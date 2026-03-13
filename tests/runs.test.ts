import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import Database from "better-sqlite3";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConduitConfig } from "../src/config";
import type { AgentRunner, RunOptions } from "../src/types/agent-types";
import { createServer } from "../server";

interface FakeRunnerBehaviorResult {
  exitCode?: number;
  stdout?: string[];
  stderr?: string[];
}

type RunnerCallbacks = NonNullable<RunOptions["callbacks"]>;

type FakeRunnerBehavior = (input: {
  prompt: string;
  options: RunOptions;
  signal: AbortSignal;
}) => Promise<FakeRunnerBehaviorResult | undefined>;

function normalizeBehaviorResult(result: FakeRunnerBehaviorResult | undefined): FakeRunnerBehaviorResult {
  if (result === undefined) {
    return {};
  }
  return result;
}

const fakeRunnerState = {
  prompts: [] as Array<{ prompt: string; workingDirectory: string; kind: string }>,
  behavior: null as FakeRunnerBehavior | null,
  nextId: 1,
  pending: new Map<
    string,
    {
      queueItemId: string;
      callbacks: RunnerCallbacks;
      finished: boolean;
      signal: AbortController;
    }
  >(),
};

function emitFakeRunnerExit(
  threadId: string,
  finalState: "completed" | "failed" | "cancelled",
  code: number | null,
  signal: NodeJS.Signals | null,
): void {
  const pending = fakeRunnerState.pending.get(threadId);
  if (!pending || pending.finished) {
    return;
  }
  pending.finished = true;
  fakeRunnerState.pending.delete(threadId);
  pending.callbacks.onExit?.({
    threadId,
    queueItemId: pending.queueItemId,
    pid: 999,
    code,
    signal,
    finalState,
    endedAt: new Date().toISOString(),
    emittedAt: new Date().toISOString(),
  });
}

function createFakeRunner(kind: "claude" | "codex" | "cursor" | "gemini"): AgentRunner {
  return {
    kind,
    async init() {},
    async awaitIdle() {},
    async run(prompt, options = {}) {
      const id = fakeRunnerState.nextId++;
      const threadId = `run-thread-${id}`;
      const queueItemId = `run-queue-${id}`;
      const callbacks: RunnerCallbacks = options.callbacks ?? {};
      const signal = new AbortController();

      fakeRunnerState.prompts.push({
        prompt,
        workingDirectory: options.workingDirectory ?? process.cwd(),
        kind,
      });
      fakeRunnerState.pending.set(threadId, {
        queueItemId,
        callbacks,
        finished: false,
        signal,
      });

      callbacks.onQueued?.({
        threadId,
        queueItemId,
        emittedAt: new Date().toISOString(),
      });
      callbacks.onStart?.({
        threadId,
        queueItemId,
        pid: 999,
        startedAt: new Date().toISOString(),
        emittedAt: new Date().toISOString(),
      });

      queueMicrotask(async () => {
        try {
          const result = normalizeBehaviorResult(
            await (fakeRunnerState.behavior?.({
              prompt,
              options,
              signal: signal.signal,
            }) ?? Promise.resolve(undefined)),
          );
          if (signal.signal.aborted) {
            emitFakeRunnerExit(threadId, "cancelled", null, "SIGTERM");
            return;
          }
          for (const chunk of result.stdout ?? []) {
            callbacks.onStdout?.({
              threadId,
              queueItemId,
              pid: 999,
              stream: "stdout",
              chunk,
              emittedAt: new Date().toISOString(),
            });
          }
          for (const chunk of result.stderr ?? []) {
            callbacks.onStderr?.({
              threadId,
              queueItemId,
              pid: 999,
              stream: "stderr",
              chunk,
              emittedAt: new Date().toISOString(),
            });
          }
          emitFakeRunnerExit(threadId, (result.exitCode ?? 0) === 0 ? "completed" : "failed", result.exitCode ?? 0, null);
        } catch (error) {
          const pending = fakeRunnerState.pending.get(threadId);
          if (!pending || pending.finished) {
            return;
          }
          pending.finished = true;
          fakeRunnerState.pending.delete(threadId);
          callbacks.onError?.({
            threadId,
            queueItemId,
            pid: 999,
            error: error instanceof Error ? error : new Error(String(error)),
            emittedAt: new Date().toISOString(),
          });
        }
      });

      return { threadId, queueItemId };
    },
    async isRunning(threadId) {
      const pending = fakeRunnerState.pending.get(threadId);
      return pending !== undefined && !pending.finished;
    },
    async getThread(threadId) {
      const pending = fakeRunnerState.pending.get(threadId);
      if (!pending) {
        return null;
      }
      return {
        threadId,
        queueItemId: pending.queueItemId,
        state: pending.finished ? "completed" : "running",
        pid: 999,
        prompt: "",
        metadata: {},
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        endedAt: pending.finished ? new Date().toISOString() : null,
        exitCode: pending.finished ? 0 : null,
        exitSignal: null,
      };
    },
    async cancel(threadId) {
      const pending = fakeRunnerState.pending.get(threadId);
      if (!pending || pending.finished) {
        return false;
      }
      pending.signal.abort();
      emitFakeRunnerExit(threadId, "cancelled", null, "SIGTERM");
      return true;
    },
    extractFinalMessage(stdout: string) {
      const trimmed = stdout.trim();
      return trimmed.length > 0 ? trimmed : null;
    },
    extractUsage() {
      return null;
    },
  };
}

const fakeRunners = {
  claude: createFakeRunner("claude"),
  codex: createFakeRunner("codex"),
  cursor: createFakeRunner("cursor"),
  gemini: createFakeRunner("gemini"),
};

vi.mock("../src/runners/factory", () => ({
  createRunner: vi.fn((kind: keyof typeof fakeRunners) => fakeRunners[kind]),
}));


interface TestContext {
  rootDir: string;
  stateDir: string;
  projectDir: string;
  policyDir: string;
}

const cleanupDirs: string[] = [];
const apps: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (apps.length > 0) {
    await apps.pop()?.close();
  }
  fakeRunnerState.prompts = [];
  fakeRunnerState.behavior = null;
  fakeRunnerState.nextId = 1;
  fakeRunnerState.pending.clear();
  while (cleanupDirs.length > 0) {
    await rm(cleanupDirs.pop()!, { recursive: true, force: true });
  }
});

function baseConfig(stateDir: string, projectDir: string): ConduitConfig {
  return {
    defaultRunner: "codex",
    stateDir,
    projects: {
      fixture: {
        path: projectDir,
      },
    },
    runners: {
      claude: { args: [] },
      codex: { args: [] },
      cursor: { args: [] },
      gemini: { args: [] },
    },
    server: {
      port: 8888,
      allowInit: false,
      debug: false,
      enableDocs: false,
      queue: {
        maxQueuedRuns: null,
        maxActiveRuns: null,
      },
      throttling: {
        enabled: false,
        windowMs: 60_000,
        maxRequests: 60,
        key: "ip",
      },
      requestControls: {
        cwd: "disabled",
        db: "disabled",
        args: "disabled",
      },
    },
  };
}

type ServerTestOverrides = Partial<Omit<ConduitConfig["server"], "queue">> & {
  queue?: Partial<ConduitConfig["server"]["queue"]>;
};

function withServerOverrides(
  config: ConduitConfig,
  overrides?: ServerTestOverrides,
): ConduitConfig {
  if (!overrides) {
    return config;
  }

  return {
    ...config,
    server: {
      ...config.server,
      ...overrides,
      queue: {
        ...config.server.queue,
        ...(overrides.queue ?? {}),
      },
    },
  };
}

async function createFixture(
  policyId: string,
  policyYaml: string,
  files: Record<string, string>,
): Promise<TestContext> {
  const rootDir = await mkdtemp(join(tmpdir(), "conduit-runs-"));
  const stateDir = join(rootDir, "state");
  const projectDir = join(rootDir, "project");
  const policyDir = join(projectDir, ".conduit", "policies", policyId);

  cleanupDirs.push(rootDir);
  await mkdir(policyDir, { recursive: true });
  await mkdir(join(projectDir, ".git"), { recursive: true });
  await writeFile(join(projectDir, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
  await writeFile(join(policyDir, "policy.yaml"), policyYaml, "utf8");

  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(policyDir, relativePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf8");
    if (relativePath.endsWith(".sh")) {
      await chmod(fullPath, 0o755);
    }
  }

  return { rootDir, stateDir, projectDir, policyDir };
}

async function createApp(
  context: TestContext,
  overrides?: ServerTestOverrides,
) {
  const app = await createServer(withServerOverrides(baseConfig(context.stateDir, context.projectDir), overrides));
  apps.push(app);
  return app;
}

async function waitForRunStatus(
  app: Awaited<ReturnType<typeof createApp>>,
  runId: string,
  predicate: (status: string) => boolean,
) {
  for (let index = 0; index < 200; index += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/runs/${runId}`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    if (predicate(body.status)) {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Run "${runId}" did not reach the expected status`);
}

async function waitForTerminalStatus(app: Awaited<ReturnType<typeof createApp>>, runId: string) {
  return waitForRunStatus(app, runId, (status) => ["succeeded", "failed", "timed_out", "canceled"].includes(status));
}

async function waitForNonQueuedStatus(app: Awaited<ReturnType<typeof createApp>>, runId: string) {
  return waitForRunStatus(app, runId, (status) => status !== "queued");
}

async function waitForPromptCount(count: number) {
  for (let index = 0; index < 200; index += 1) {
    if (fakeRunnerState.prompts.length === count) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Expected ${count} runner prompt(s), got ${fakeRunnerState.prompts.length}`);
}

async function waitForNoAdditionalPrompts(count: number, durationMs = 200) {
  await new Promise((resolve) => setTimeout(resolve, durationMs));
  expect(fakeRunnerState.prompts).toHaveLength(count);
}

function createBarrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function waitForQueueCounts(stateDir: string, expected: { queued?: number; active?: number }) {
  for (let index = 0; index < 200; index += 1) {
    const db = openDb(stateDir);
    const counts = db
      .prepare(
        `
SELECT
  SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
  SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS active
FROM runs
        `.trim(),
      )
      .get() as { queued: number | null; active: number | null };
    db.close();
    const queued = counts.queued ?? 0;
    const active = counts.active ?? 0;
    if ((expected.queued === undefined || queued === expected.queued) && (expected.active === undefined || active === expected.active)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Queue counts did not reach queued=${expected.queued ?? "*"}, active=${expected.active ?? "*"}`);
}

function openDb(stateDir: string): Database.Database {
  return new Database(join(stateDir, "db.sqlite"));
}

describe("Conduit /runs v1", () => {
  it("lets init hooks update the run workspace for the agent and checks", async () => {
    const fixture = await createFixture(
      "init-workspace.v1",
      `
policy_id: init-workspace.v1
task_id: fix_bug
hooks:
  init:
    - ./init_workspace.sh
checks:
  - name: workspace-file
    command: test -f agent-output.txt
    on_fail: fail
retry:
  max_attempts: 1
      `.trim(),
      {
        "init_workspace.sh": [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          "WORKTREE_PATH=\"$CONDUIT_PROJECT_PATH/.worktrees/$CONDUIT_RUN_ID\"",
          "mkdir -p \"$WORKTREE_PATH\"",
          "cat > \"$CONDUIT_HOOK_OUTPUT_PATH\" <<EOF",
          "{",
          "  \"workspace_path\": \"$WORKTREE_PATH\"",
          "}",
          "EOF",
          "",
        ].join("\n"),
      },
    );
    fakeRunnerState.behavior = async ({ options }) => {
      const workingDirectory = options.workingDirectory ?? process.cwd();
      await writeFile(join(workingDirectory, "agent-output.txt"), "ok\n", "utf8");
      return {};
    };
    const app = await createApp(fixture);

    const createResponse = await app.inject({
      method: "POST",
      url: "/runs",
      payload: {
        project_id: "fixture",
        policy_id: "init-workspace.v1",
        input: { issue: 101 },
      },
    });

    const runId = createResponse.json().run_id;
    const run = await waitForTerminalStatus(app, runId);
    expect(run.status).toBe("succeeded");

    const attemptsResponse = await app.inject({ method: "GET", url: `/runs/${runId}?include=attempts` });
    const attempts = attemptsResponse.json().attempts;
    const workspacePath = join(fixture.projectDir, ".worktrees", runId);
    expect(fakeRunnerState.prompts[0].workingDirectory).toBe(workspacePath);
    expect(attempts[0].workspace_path).toBe(workspacePath);
    expect(await readFile(join(workspacePath, "agent-output.txt"), "utf8")).toBe("ok\n");
  });

  it("lets before_attempt hooks override the workspace for a specific attempt", async () => {
    const fixture = await createFixture(
      "attempt-workspace.v1",
      `
policy_id: attempt-workspace.v1
task_id: fix_bug
hooks:
  before_attempt:
    - ./attempt_workspace.sh
checks:
  - name: workspace-file
    command: test -f attempt-output.txt
    on_fail: fail
retry:
  max_attempts: 1
      `.trim(),
      {
        "attempt_workspace.sh": [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          "WORKTREE_PATH=\"$CONDUIT_PROJECT_PATH/.worktrees/$CONDUIT_RUN_ID-attempt-$CONDUIT_ATTEMPT_INDEX\"",
          "mkdir -p \"$WORKTREE_PATH\"",
          "cat > \"$CONDUIT_HOOK_OUTPUT_PATH\" <<EOF",
          "{",
          "  \"workspace_path\": \"$WORKTREE_PATH\"",
          "}",
          "EOF",
          "",
        ].join("\n"),
      },
    );
    fakeRunnerState.behavior = async ({ options }) => {
      const workingDirectory = options.workingDirectory ?? process.cwd();
      await writeFile(join(workingDirectory, "attempt-output.txt"), "ok\n", "utf8");
      return {};
    };
    const app = await createApp(fixture);

    const createResponse = await app.inject({
      method: "POST",
      url: "/runs",
      payload: {
        project_id: "fixture",
        policy_id: "attempt-workspace.v1",
        input: { issue: 102 },
      },
    });

    const runId = createResponse.json().run_id;
    const run = await waitForTerminalStatus(app, runId);
    expect(run.status).toBe("succeeded");

    const attemptsResponse = await app.inject({ method: "GET", url: `/runs/${runId}?include=attempts` });
    const attempts = attemptsResponse.json().attempts;
    const workspacePath = join(fixture.projectDir, ".worktrees", `${runId}-attempt-1`);
    expect(fakeRunnerState.prompts[0].workingDirectory).toBe(workspacePath);
    expect(attempts[0].workspace_path).toBe(workspacePath);
    expect(await readFile(join(workspacePath, "attempt-output.txt"), "utf8")).toBe("ok\n");
  });

  it("invokes the agent before running checks", async () => {
    const fixture = await createFixture(
      "agent-first.v1",
      `
policy_id: agent-first.v1
task_id: fix_bug
runner:
  provider: codex
checks:
  - name: generated
    command: test -f generated-by-agent.txt
    on_fail: retry
retry:
  max_attempts: 1
      `.trim(),
      {},
    );
    fakeRunnerState.behavior = async ({ options }) => {
      const workingDirectory = options.workingDirectory ?? process.cwd();
      await writeFile(join(workingDirectory, "generated-by-agent.txt"), "ok\n", "utf8");
      return {
        stdout: ["agent wrote file"],
      };
    };
    const app = await createApp(fixture);

    const createResponse = await app.inject({
      method: "POST",
      url: "/runs",
      payload: {
        project_id: "fixture",
        policy_id: "agent-first.v1",
        input: { issue: 101 },
      },
    });

    const run = await waitForTerminalStatus(app, createResponse.json().run_id);
    expect(run.status).toBe("succeeded");
    expect(fakeRunnerState.prompts).toHaveLength(1);
    expect(fakeRunnerState.prompts[0].prompt).toContain('"issue": 101');
    expect(await readFile(join(fixture.stateDir, "runs", createResponse.json().run_id, "attempts", "1", "agent.stdout.log"), "utf8")).toContain(
      "agent wrote file",
    );
  });

  it("persists success rows and check output paths", async () => {
    const fixture = await createFixture(
      "success.v1",
      `
policy_id: success.v1
task_id: fix_bug
runner:
  provider: codex
  model: gpt-5-codex
checks:
  - name: smoke
    command: ./success.sh
    on_fail: retry
retry:
  max_attempts: 1
      `.trim(),
      {
        "success.sh": "#!/usr/bin/env bash\necho success-stdout\necho success-stderr >&2\nexit 0\n",
      },
    );
    const app = await createApp(fixture);

    const createResponse = await app.inject({
      method: "POST",
      url: "/runs",
      payload: {
        project_id: "fixture",
        policy_id: "success.v1",
        input: { issue: 1 },
      },
    });

    expect(createResponse.statusCode).toBe(200);
    const created = createResponse.json();
    expect(created.project_id).toBe("fixture");
    expect(created.policy_id).toBe("success.v1");

    const run = await waitForTerminalStatus(app, created.run_id);
    expect(run.status).toBe("succeeded");
    expect(run.task_id).toBe("fix_bug");

    const expandedRunResponse = await app.inject({ method: "GET", url: `/runs/${created.run_id}?include=attempts` });
    expect(expandedRunResponse.statusCode).toBe(200);
    const expandedRun = expandedRunResponse.json();
    expect(expandedRun.attempts).toHaveLength(1);
    expect(expandedRun.attempts[0].check_results).toHaveLength(1);
    expect(expandedRun.attempts[0].check_results[0].passed).toBe(true);
    expect(expandedRun.attempts[0].check_results[0].stdout_url).toBe(
      `/runs/${created.run_id}/attempts/1/output/checks/smoke?stream=stdout`,
    );
    expect(expandedRun.attempts[0].check_results[0].stderr_url).toBe(
      `/runs/${created.run_id}/attempts/1/output/checks/smoke?stream=stderr`,
    );
    const removedAttemptsEndpoint = await app.inject({ method: "GET", url: `/runs/${created.run_id}/attempts` });
    expect(removedAttemptsEndpoint.statusCode).toBe(404);

    const db = openDb(fixture.stateDir);
    const runRow = db.prepare("SELECT project_id, policy_id, status FROM runs WHERE run_id = ?").get(created.run_id) as {
      project_id: string;
      policy_id: string;
      status: string;
    };
    expect(runRow).toEqual({
      project_id: "fixture",
      policy_id: "success.v1",
      status: "succeeded",
    });
    const checkRow = db
      .prepare("SELECT stdout_path, stderr_path, passed FROM check_results WHERE run_id = ?")
      .get(created.run_id) as { stdout_path: string; stderr_path: string; passed: number };
    expect(checkRow.passed).toBe(1);
    expect(checkRow.stdout_path).toContain(join(fixture.stateDir, "runs", created.run_id));
    expect(checkRow.stderr_path).toContain(join(fixture.stateDir, "runs", created.run_id));
    expect(await readFile(checkRow.stdout_path, "utf8")).toContain("success-stdout");
    expect(await readFile(checkRow.stderr_path, "utf8")).toContain("success-stderr");
    expect(await readFile(join(fixture.stateDir, "runs", created.run_id, "run.json"), "utf8")).toContain(`"policy_id": "success.v1"`);

    const stdoutResponse = await app.inject({
      method: "GET",
      url: expandedRun.attempts[0].check_results[0].stdout_url,
    });
    expect(stdoutResponse.statusCode).toBe(200);
    expect(stdoutResponse.headers["content-type"]).toContain("text/plain");
    expect(stdoutResponse.body).toContain("success-stdout");

    const stderrResponse = await app.inject({
      method: "GET",
      url: expandedRun.attempts[0].check_results[0].stderr_url,
    });
    expect(stderrResponse.statusCode).toBe(200);
    expect(stderrResponse.body).toContain("success-stderr");

    const missingCheckResponse = await app.inject({
      method: "GET",
      url: `/runs/${created.run_id}/attempts/1/output/checks/missing?stream=stdout`,
    });
    expect(missingCheckResponse.statusCode).toBe(404);

    const gzipResponse = await app.inject({
      method: "GET",
      url: `/runs/${created.run_id}/attempts/1/output/checks/smoke?stream=stdout`,
      headers: {
        "accept-encoding": "gzip",
      },
    });
    expect(gzipResponse.statusCode).toBe(200);
    expect(gzipResponse.headers["content-encoding"]).toBe("gzip");
    expect(gzipResponse.headers.vary).toContain("Accept-Encoding");
    expect(gunzipSync(Buffer.from(gzipResponse.rawPayload)).toString("utf8")).toContain("success-stdout");

    const missingRunResponse = await app.inject({
      method: "GET",
      url: "/runs/run_missing/attempts/1/output/checks/smoke?stream=stdout",
    });
    expect(missingRunResponse.statusCode).toBe(404);
    db.close();
  });

  it("dedupes create requests by external_ref within a project and policy", async () => {
    const fixture = await createFixture(
      "dedupe.v1",
      `
policy_id: dedupe.v1
task_id: fix_bug
runner:
  provider: codex
retry:
  max_attempts: 1
      `.trim(),
      {},
    );
    const app = await createApp(fixture);
    fakeRunnerState.behavior = async () => ({ stdout: ["deduped"] });

    const firstResponse = await app.inject({
      method: "POST",
      url: "/runs",
      payload: {
        project_id: "fixture",
        policy_id: "dedupe.v1",
        input: { issue: 42 },
        external_ref: "github:yourname/conduit/issues/42",
      },
    });
    const secondResponse = await app.inject({
      method: "POST",
      url: "/runs",
      payload: {
        project_id: "fixture",
        policy_id: "dedupe.v1",
        input: { issue: 42, retried: true },
        external_ref: "github:yourname/conduit/issues/42",
      },
    });

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    expect(secondResponse.json().run_id).toBe(firstResponse.json().run_id);

    const run = await waitForTerminalStatus(app, firstResponse.json().run_id);
    expect(run.status).toBe("succeeded");
    expect(fakeRunnerState.prompts).toHaveLength(1);

    const db = openDb(fixture.stateDir);
    const row = db
      .prepare(
        "SELECT COUNT(*) AS count FROM runs WHERE project_id = ? AND policy_id = ? AND external_ref = ?",
      )
      .get("fixture", "dedupe.v1", "github:yourname/conduit/issues/42") as { count: number };
    expect(row.count).toBe(1);
    db.close();
  });

  it("queues later runs until an active slot opens", async () => {
    const fixture = await createFixture(
      "queueing.v1",
      `
policy_id: queueing.v1
task_id: fix_bug
runner:
  provider: codex
retry:
  max_attempts: 1
      `.trim(),
      {},
    );
    const app = await createApp(fixture, {
      queue: {
        maxActiveRuns: 1,
      },
    });
    const firstBarrier = createBarrier();
    const secondBarrier = createBarrier();
    let invocationCount = 0;
    fakeRunnerState.behavior = async () => {
      invocationCount += 1;
      await (invocationCount === 1 ? firstBarrier.promise : secondBarrier.promise);
      return { stdout: [`attempt-${invocationCount}`] };
    };

    const firstResponse = await app.inject({
      method: "POST",
      url: "/runs",
      payload: {
        project_id: "fixture",
        policy_id: "queueing.v1",
        input: { issue: 1 },
      },
    });
    const secondResponse = await app.inject({
      method: "POST",
      url: "/runs",
      payload: {
        project_id: "fixture",
        policy_id: "queueing.v1",
        input: { issue: 2 },
      },
    });

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    await waitForPromptCount(1);
    await waitForQueueCounts(fixture.stateDir, { queued: 1, active: 1 });

    const queuedRun = await app.inject({
      method: "GET",
      url: `/runs/${secondResponse.json().run_id}`,
    });
    expect(queuedRun.statusCode).toBe(200);
    expect(queuedRun.json().status).toBe("queued");

    firstBarrier.release();
    await waitForTerminalStatus(app, firstResponse.json().run_id);
    await waitForPromptCount(2);
    await waitForNonQueuedStatus(app, secondResponse.json().run_id);
    await waitForQueueCounts(fixture.stateDir, { queued: 0, active: 1 });

    secondBarrier.release();
    const secondRun = await waitForTerminalStatus(app, secondResponse.json().run_id);
    expect(secondRun.status).toBe("succeeded");
  });

  it("cancels queued runs before they start", async () => {
    const fixture = await createFixture(
      "queue-cancel.v1",
      `
policy_id: queue-cancel.v1
task_id: fix_bug
runner:
  provider: codex
retry:
  max_attempts: 1
      `.trim(),
      {},
    );
    const app = await createApp(fixture, {
      queue: {
        maxActiveRuns: 1,
      },
    });
    const firstBarrier = createBarrier();
    fakeRunnerState.behavior = async () => {
      await firstBarrier.promise;
      return {};
    };

    const firstResponse = await app.inject({
      method: "POST",
      url: "/runs",
      payload: {
        project_id: "fixture",
        policy_id: "queue-cancel.v1",
        input: { issue: 1 },
      },
    });
    const secondResponse = await app.inject({
      method: "POST",
      url: "/runs",
      payload: {
        project_id: "fixture",
        policy_id: "queue-cancel.v1",
        input: { issue: 2 },
      },
    });

    await waitForPromptCount(1);
    await waitForQueueCounts(fixture.stateDir, { queued: 1, active: 1 });

    const cancelResponse = await app.inject({
      method: "POST",
      url: `/runs/${secondResponse.json().run_id}/cancel`,
    });
    expect(cancelResponse.statusCode).toBe(200);
    expect(cancelResponse.json().canceled).toBe(true);

    const canceledRun = await waitForTerminalStatus(app, secondResponse.json().run_id);
    expect(canceledRun.status).toBe("canceled");
    await waitForQueueCounts(fixture.stateDir, { queued: 0, active: 1 });
    await waitForNoAdditionalPrompts(1);

    firstBarrier.release();
    const firstRun = await waitForTerminalStatus(app, firstResponse.json().run_id);
    expect(firstRun.status).toBe("succeeded");
    await waitForNoAdditionalPrompts(1);
  });

  it("rejects new runs when queued capacity is exhausted", async () => {
    const fixture = await createFixture(
      "queue-capacity.v1",
      `
policy_id: queue-capacity.v1
task_id: fix_bug
runner:
  provider: codex
retry:
  max_attempts: 1
      `.trim(),
      {},
    );
    const app = await createApp(fixture, {
      queue: {
        maxActiveRuns: 1,
        maxQueuedRuns: 1,
      },
    });
    const firstBarrier = createBarrier();
    const secondBarrier = createBarrier();
    let invocationCount = 0;
    fakeRunnerState.behavior = async () => {
      invocationCount += 1;
      await (invocationCount === 1 ? firstBarrier.promise : secondBarrier.promise);
      return {};
    };

    const firstResponse = await app.inject({
      method: "POST",
      url: "/runs",
      payload: {
        project_id: "fixture",
        policy_id: "queue-capacity.v1",
        input: { issue: 1 },
      },
    });
    const secondResponse = await app.inject({
      method: "POST",
      url: "/runs",
      payload: {
        project_id: "fixture",
        policy_id: "queue-capacity.v1",
        input: { issue: 2 },
      },
    });

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    await waitForQueueCounts(fixture.stateDir, { queued: 1, active: 1 });

    const thirdResponse = await app.inject({
      method: "POST",
      url: "/runs",
      payload: {
        project_id: "fixture",
        policy_id: "queue-capacity.v1",
        input: { issue: 3 },
      },
    });
    expect(thirdResponse.statusCode).toBe(429);
    expect(thirdResponse.json()).toEqual({ error: "Queue capacity exceeded" });

    firstBarrier.release();
    await waitForTerminalStatus(app, firstResponse.json().run_id);
    await waitForPromptCount(2);
    secondBarrier.release();
    await waitForTerminalStatus(app, secondResponse.json().run_id);
  });

  it("retries and succeeds on a later attempt", async () => {
    const fixture = await createFixture(
      "retry-success.v1",
      `
policy_id: retry-success.v1
task_id: fix_bug
checks:
  - name: flaky
    command: ./retry_then_pass.sh
    on_fail: retry
retry:
  max_attempts: 2
      `.trim(),
      {
        "retry_then_pass.sh": [
          "#!/usr/bin/env bash",
          "COUNTER_FILE=\"$CONDUIT_WORKSPACE/.attempt-counter\"",
          "COUNT=0",
          "if [ -f \"$COUNTER_FILE\" ]; then COUNT=$(cat \"$COUNTER_FILE\"); fi",
          "COUNT=$((COUNT + 1))",
          "echo \"$COUNT\" > \"$COUNTER_FILE\"",
          "echo attempt-$COUNT",
          "if [ \"$COUNT\" -lt 2 ]; then exit 1; fi",
          "exit 0",
          "",
        ].join("\n"),
      },
    );
    const app = await createApp(fixture);
    fakeRunnerState.behavior = async () => ({});

    const createResponse = await app.inject({
      method: "POST",
      url: "/runs",
      payload: {
        project_id: "fixture",
        policy_id: "retry-success.v1",
        input: { issue: 2 },
      },
    });
    const created = createResponse.json();

    const run = await waitForTerminalStatus(app, created.run_id);
    expect(run.status).toBe("succeeded");
    expect(run.current_attempt_index).toBe(2);

    const attempts = (await app.inject({ method: "GET", url: `/runs/${created.run_id}?include=attempts` })).json().attempts;
    expect(attempts).toHaveLength(2);
    expect(attempts[0].status).toBe("failed");
    expect(attempts[1].status).toBe("succeeded");
    expect(attempts[0].check_results[0].on_fail).toBe("retry");
    expect(attempts[0].check_results[0].passed).toBe(false);
    expect(attempts[1].check_results[0].passed).toBe(true);
  });

  it("feeds failed check output into the retry prompt", async () => {
    const fixture = await createFixture(
      "retry-feedback.v1",
      `
policy_id: retry-feedback.v1
task_id: fix_bug
checks:
  - name: missing-file
    command: ./require_fix.sh
    on_fail: retry
retry:
  max_attempts: 2
      `.trim(),
      {
        "require_fix.sh": [
          "#!/usr/bin/env bash",
          "if [ ! -f fixed-by-retry.txt ]; then",
          "  echo retry-stdout",
          "  echo retry-stderr >&2",
          "  exit 1",
          "fi",
          "exit 0",
          "",
        ].join("\n"),
      },
    );
    fakeRunnerState.behavior = async ({ prompt, options }) => {
      if (prompt.includes("Check: missing-file") && prompt.includes("retry-stderr")) {
        const workingDirectory = options.workingDirectory ?? process.cwd();
        await writeFile(join(workingDirectory, "fixed-by-retry.txt"), "fixed\n", "utf8");
      }
      return {};
    };
    const app = await createApp(fixture);

    const createResponse = await app.inject({
      method: "POST",
      url: "/runs",
      payload: {
        project_id: "fixture",
        policy_id: "retry-feedback.v1",
        input: { issue: 202 },
      },
    });

    const run = await waitForTerminalStatus(app, createResponse.json().run_id);
    expect(run.status).toBe("succeeded");
    expect(fakeRunnerState.prompts).toHaveLength(2);
    expect(fakeRunnerState.prompts[1].prompt).toContain("Retry feedback:");
    expect(fakeRunnerState.prompts[1].prompt).toContain("Check: missing-file");
    expect(fakeRunnerState.prompts[1].prompt).toContain("retry-stdout");
    expect(fakeRunnerState.prompts[1].prompt).toContain("retry-stderr");
    expect(
      await readFile(
        join(fixture.stateDir, "runs", createResponse.json().run_id, "attempts", "2", "retry-feedback.txt"),
        "utf8",
      ),
    ).toContain("Check: missing-file");
  });

  it("escalates to the next runner on retryable failure", async () => {
    const fixture = await createFixture(
      "escalation.v1",
      `
policy_id: escalation.v1
task_id: fix_bug
runner:
  provider: claude
  model: sonnet-4
checks:
  - name: gate
    command: ./gate.sh
    on_fail: retry
retry:
  max_attempts: 2
  escalation:
    - runner:
        provider: codex
        model: gpt-5-codex
      `.trim(),
      {
        "gate.sh": [
          "#!/usr/bin/env bash",
          "if [ ! -f escalated-pass.txt ]; then",
          "  echo still-failing",
          "  exit 1",
          "fi",
          "exit 0",
          "",
        ].join("\n"),
      },
    );
    fakeRunnerState.behavior = async ({ options }) => {
      const current = fakeRunnerState.prompts[fakeRunnerState.prompts.length - 1];
      if (current?.kind === "codex") {
        const workingDirectory = options.workingDirectory ?? process.cwd();
        await writeFile(join(workingDirectory, "escalated-pass.txt"), "ok\n", "utf8");
      }
      return {};
    };
    const app = await createApp(fixture);

    const createResponse = await app.inject({
      method: "POST",
      url: "/runs",
      payload: {
        project_id: "fixture",
        policy_id: "escalation.v1",
        input: { issue: 303 },
      },
    });

    const run = await waitForTerminalStatus(app, createResponse.json().run_id);
    expect(run.status).toBe("succeeded");
    expect(fakeRunnerState.prompts.map((entry) => entry.kind)).toEqual(["claude", "codex"]);

    const attempts = (await app.inject({ method: "GET", url: `/runs/${createResponse.json().run_id}?include=attempts` })).json().attempts;
    expect(attempts).toHaveLength(2);
    expect(attempts[0].runner.provider).toBe("claude");
    expect(attempts[1].runner.provider).toBe("codex");
  });

  it("fails immediately when a check uses on_fail=fail", async () => {
    const fixture = await createFixture(
      "fail-fast.v1",
      `
policy_id: fail-fast.v1
task_id: fix_bug
checks:
  - name: fatal
    command: ./fatal.sh
    on_fail: fail
retry:
  max_attempts: 3
      `.trim(),
      {
        "fatal.sh": "#!/usr/bin/env bash\necho fatal\nexit 1\n",
      },
    );
    const app = await createApp(fixture);
    fakeRunnerState.behavior = async () => ({});

    const createResponse = await app.inject({
      method: "POST",
      url: "/runs",
      payload: {
        project_id: "fixture",
        policy_id: "fail-fast.v1",
        input: { issue: 3 },
      },
    });
    const run = await waitForTerminalStatus(app, createResponse.json().run_id);
    expect(run.status).toBe("failed");
    expect(run.current_attempt_index).toBe(1);

    const attempts = (await app.inject({ method: "GET", url: `/runs/${createResponse.json().run_id}?include=attempts` })).json().attempts;
    expect(attempts).toHaveLength(1);
    expect(attempts[0].check_results[0].on_fail).toBe("fail");
    expect(attempts[0].check_results[0].failure_effective).toBe(true);
  });

  it("records ignored check failures and still succeeds", async () => {
    const fixture = await createFixture(
      "ignore.v1",
      `
policy_id: ignore.v1
task_id: fix_bug
checks:
  - name: soft
    command: ./soft_fail.sh
    on_fail: ignore
  - name: hard-pass
    command: ./pass.sh
    on_fail: retry
retry:
  max_attempts: 1
      `.trim(),
      {
        "soft_fail.sh": "#!/usr/bin/env bash\necho ignored\nexit 1\n",
        "pass.sh": "#!/usr/bin/env bash\necho pass\nexit 0\n",
      },
    );
    const app = await createApp(fixture);
    fakeRunnerState.behavior = async () => ({});

    const createResponse = await app.inject({
      method: "POST",
      url: "/runs",
      payload: {
        project_id: "fixture",
        policy_id: "ignore.v1",
        input: { issue: 4 },
      },
    });
    const run = await waitForTerminalStatus(app, createResponse.json().run_id);
    expect(run.status).toBe("succeeded");

    const attempts = (await app.inject({ method: "GET", url: `/runs/${createResponse.json().run_id}?include=attempts` })).json().attempts;
    expect(attempts[0].check_results).toHaveLength(2);
    expect(attempts[0].check_results[0].passed).toBe(false);
    expect(attempts[0].check_results[0].failure_effective).toBe(false);
  });

  it("fails after reaching max attempts for retryable checks", async () => {
    const fixture = await createFixture(
      "max-attempts.v1",
      `
policy_id: max-attempts.v1
task_id: fix_bug
checks:
  - name: always-fail
    command: ./always_fail.sh
    on_fail: retry
retry:
  max_attempts: 2
      `.trim(),
      {
        "always_fail.sh": "#!/usr/bin/env bash\necho nope\nexit 1\n",
      },
    );
    const app = await createApp(fixture);
    fakeRunnerState.behavior = async () => ({});

    const createResponse = await app.inject({
      method: "POST",
      url: "/runs",
      payload: {
        project_id: "fixture",
        policy_id: "max-attempts.v1",
        input: { issue: 5 },
      },
    });
    const run = await waitForTerminalStatus(app, createResponse.json().run_id);
    expect(run.status).toBe("failed");
    expect(run.current_attempt_index).toBe(2);

    const db = openDb(fixture.stateDir);
    const attempts = db.prepare("SELECT COUNT(*) AS count FROM attempts WHERE run_id = ?").get(createResponse.json().run_id) as {
      count: number;
    };
    expect(attempts.count).toBe(2);
    db.close();
  });

  it("cancels an active run and persists canceled state", async () => {
    const fixture = await createFixture(
      "cancel.v1",
      `
policy_id: cancel.v1
task_id: fix_bug
checks:
  - name: done
    command: test -f agent-finished.txt
    on_fail: retry
retry:
  max_attempts: 2
      `.trim(),
      {},
    );
    const app = await createApp(fixture);
    fakeRunnerState.behavior = async ({ options, signal }) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (!signal.aborted) {
        const workingDirectory = options.workingDirectory ?? process.cwd();
        await writeFile(join(workingDirectory, "agent-finished.txt"), "done\n", "utf8");
      }
      return {};
    };

    const createResponse = await app.inject({
      method: "POST",
      url: "/runs",
      payload: {
        project_id: "fixture",
        policy_id: "cancel.v1",
        input: { issue: 6 },
      },
    });
    const runId = createResponse.json().run_id;

    for (let index = 0; index < 100; index += 1) {
      const runResponse = await app.inject({ method: "GET", url: `/runs/${runId}` });
      if (fakeRunnerState.prompts.length >= 1) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const cancelResponse = await app.inject({
      method: "POST",
      url: `/runs/${runId}/cancel`,
    });
    expect(cancelResponse.statusCode).toBe(200);
    expect(cancelResponse.json().canceled).toBe(true);

    const run = await waitForTerminalStatus(app, runId);
    expect(run.status).toBe("canceled");

    const attempts = (await app.inject({ method: "GET", url: `/runs/${runId}?include=attempts` })).json().attempts;
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe("canceled");

    const db = openDb(fixture.stateDir);
    const runRow = db.prepare("SELECT status, cancel_requested_at FROM runs WHERE run_id = ?").get(runId) as {
      status: string;
      cancel_requested_at: string | null;
    };
    expect(runRow.status).toBe("canceled");
    expect(runRow.cancel_requested_at).not.toBeNull();
    db.close();
  });

  it("renders filtered runs in the status partial", async () => {
    const fixture = await createFixture(
      "listable.v1",
      `
policy_id: listable.v1
task_id: fix_bug
runner:
  provider: codex
retry:
  max_attempts: 1
      `.trim(),
      {},
    );
    const app = await createApp(fixture);

    fakeRunnerState.behavior = async () => ({ stdout: ["ok"] });
    const firstCreate = await app.inject({
      method: "POST",
      url: "/runs",
      payload: {
        project_id: "fixture",
        policy_id: "listable.v1",
        input: { issue: 1 },
      },
    });
    const firstRunId = firstCreate.json().run_id;
    await waitForTerminalStatus(app, firstRunId);

    fakeRunnerState.behavior = async () => ({ exitCode: 1, stderr: ["boom"] });
    const secondCreate = await app.inject({
      method: "POST",
      url: "/runs",
      payload: {
        project_id: "fixture",
        policy_id: "listable.v1",
        input: { issue: 2 },
      },
    });
    const secondRunId = secondCreate.json().run_id;
    await waitForTerminalStatus(app, secondRunId);

    const listResponse = await app.inject({
      method: "GET",
      url: "/status/partials/runs?status=failed",
    });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.body).toContain(secondRunId);
    expect(listResponse.body).not.toContain(firstRunId);

    const succeededResponse = await app.inject({
      method: "GET",
      url: "/status/partials/runs?status=succeeded",
    });
    expect(succeededResponse.statusCode).toBe(200);
    expect(succeededResponse.body).toContain(firstRunId);
    expect(succeededResponse.body).not.toContain(secondRunId);
  });

  it("serves agent attempt stdout and stderr logs", async () => {
    const fixture = await createFixture(
      "attempt-output.v1",
      `
policy_id: attempt-output.v1
task_id: fix_bug
runner:
  provider: codex
retry:
  max_attempts: 1
      `.trim(),
      {},
    );
    fakeRunnerState.behavior = async () => ({
      stdout: ["agent stdout line"],
      stderr: ["agent stderr line"],
    });
    const app = await createApp(fixture);

    const createResponse = await app.inject({
      method: "POST",
      url: "/runs",
      payload: {
        project_id: "fixture",
        policy_id: "attempt-output.v1",
        input: { issue: 7 },
      },
    });
    const runId = createResponse.json().run_id;
    const run = await waitForTerminalStatus(app, runId);
    expect(run.status).toBe("succeeded");

    const expandedRunResponse = await app.inject({ method: "GET", url: `/runs/${runId}?include=attempts` });
    expect(expandedRunResponse.statusCode).toBe(200);
    expect(expandedRunResponse.json().attempts[0].agent_stdout_url).toBe(`/runs/${runId}/attempts/1/output/agent?stream=stdout`);
    expect(expandedRunResponse.json().attempts[0].agent_stderr_url).toBe(`/runs/${runId}/attempts/1/output/agent?stream=stderr`);

    const stdoutResponse = await app.inject({
      method: "GET",
      url: `/runs/${runId}/attempts/1/output/agent?stream=stdout`,
    });
    expect(stdoutResponse.statusCode).toBe(200);
    expect(stdoutResponse.body).toContain("agent stdout line");

    const stderrResponse = await app.inject({
      method: "GET",
      url: `/runs/${runId}/attempts/1/output/agent?stream=stderr`,
    });
    expect(stderrResponse.statusCode).toBe(200);
    expect(stderrResponse.body).toContain("agent stderr line");
  });

  it("renders the status dashboard shell and partials", async () => {
    const fixture = await createFixture(
      "status-page.v1",
      `
policy_id: status-page.v1
task_id: fix_bug
runner:
  provider: codex
checks:
  - name: smoke
    command: ./smoke.sh
    on_fail: retry
retry:
  max_attempts: 1
      `.trim(),
      {
        "smoke.sh": "#!/usr/bin/env bash\necho smoke-ok\nexit 0\n",
      },
    );
    fakeRunnerState.behavior = async () => ({
      stdout: ["operator stdout"],
      stderr: ["operator stderr"],
    });
    const app = await createApp(fixture);

    const createResponse = await app.inject({
      method: "POST",
      url: "/runs",
      payload: {
        project_id: "fixture",
        policy_id: "status-page.v1",
        input: { issue: 9 },
      },
    });
    const runId = createResponse.json().run_id;
    await waitForTerminalStatus(app, runId);

    const db = openDb(fixture.stateDir);
    db.prepare(
      `
INSERT INTO agent_queue (id, thread_id, prompt, working_directory, metadata_json, state, started_at, ended_at, exit_code)
VALUES (?, ?, ?, ?, ?, 'failed', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 1)
      `.trim(),
    ).run(
      "queue-1",
      "thread-1",
      "redacted prompt",
      fixture.projectDir,
      JSON.stringify({
        projectId: "fixture",
        finalOutputPath: "/tmp/conduit-chat-final.txt",
        finalMessagePreview: "chat final preview",
        usageSummary: "in 10 | out 5",
      }),
    );
    db.close();

    const shellResponse = await app.inject({
      method: "GET",
      url: `/status?runId=${encodeURIComponent(runId)}`,
    });
    expect(shellResponse.statusCode).toBe(200);
    expect(shellResponse.headers["content-type"]).toContain("text/html");
    expect(shellResponse.body).toContain("/status/partials/summary");
    expect(shellResponse.body).toContain(`/status/partials/runs/${runId}`);
    expect(shellResponse.body).toContain('href="/playground">Playground</a>');
    expect(shellResponse.body).toContain('href="/status">Status</a>');

    const summaryResponse = await app.inject({
      method: "GET",
      url: "/status/partials/summary",
    });
    expect(summaryResponse.statusCode).toBe(200);
    expect(summaryResponse.body).toContain("Service Summary");

    const chatResponse = await app.inject({
      method: "GET",
      url: "/status/partials/chat",
    });
    expect(chatResponse.statusCode).toBe(200);
    expect(chatResponse.body).toContain("Chat Queue");
    expect(chatResponse.body).toContain("thread-1");
    expect(chatResponse.body).toContain("chat final preview");
    expect(chatResponse.body).toContain("/chat/threads/thread-1/output/final");
    expect(chatResponse.body).toContain("in 10 | out 5");

    const runsResponse = await app.inject({
      method: "GET",
      url: "/status/partials/runs",
    });
    expect(runsResponse.statusCode).toBe(200);
    expect(runsResponse.body).toContain(runId);
    expect(runsResponse.body).toContain("latest 20 runs");

    const detailResponse = await app.inject({
      method: "GET",
      url: `/status/partials/runs/${runId}`,
    });
    expect(detailResponse.statusCode).toBe(200);
    expect(detailResponse.body).toContain("Run Detail");
    expect(detailResponse.body).toContain(`/runs/${runId}/attempts/1/output/agent/final`);
    expect(detailResponse.body).toContain(`/runs/${runId}/attempts/1/output/agent?stream=stdout`);
    expect(detailResponse.body).toContain(`/runs/${runId}/attempts/1/output/checks/smoke?stream=stdout`);
    expect(detailResponse.body).toContain(`href="/playground?project_id=fixture&amp;policy_id=status-page.v1&amp;section=run"`);
  });

  it("renders the playground and supports chat/run actions", async () => {
    const fixture = await createFixture(
      "playground.v1",
      `
policy_id: playground.v1
task_id: fix_bug
runner:
  provider: codex
retry:
  max_attempts: 1
      `.trim(),
      {},
    );
    fakeRunnerState.behavior = async () => ({
      stdout: ["playground stdout"],
    });
    const app = await createApp(fixture);

    const pageResponse = await app.inject({
      method: "GET",
      url: "/playground",
    });
    expect(pageResponse.statusCode).toBe(200);
    expect(pageResponse.body).toContain("Conduit Playground");
    expect(pageResponse.body).toContain("submitPlaygroundForm(form, '/chat')");
    expect(pageResponse.body).toContain("submitPlaygroundForm(form, '/runs')");
    expect(pageResponse.body).toContain('data-playground-section="chat"');
    expect(pageResponse.body).toContain('data-playground-section="run"');
    expect(pageResponse.body).toContain('href="/playground">Playground</a>');
    expect(pageResponse.body).toContain('href="/status">Status</a>');
    expect(pageResponse.body).toContain("json5@2/dist/index.min.js");
    expect(pageResponse.body).toContain("JSON5 is accepted here.");

    const policyResponse = await app.inject({
      method: "GET",
      url: "/playground/partials/run-policy?project_id=fixture",
    });
    expect(policyResponse.statusCode).toBe(200);
    expect(policyResponse.body).toContain("playground.v1");

    const chatResponse = await app.inject({
      method: "POST",
      url: "/chat",
      payload: {
        project_id: "fixture",
        prompt: "playground prompt",
      },
    });
    expect(chatResponse.statusCode).toBe(200);
    expect(chatResponse.json()).toMatchObject({
      threadId: "run-thread-1",
      queueItemId: "run-queue-1",
      finalMessage: "playground stdout",
    });

    const runResponse = await app.inject({
      method: "POST",
      url: "/runs",
      payload: {
        project_id: "fixture",
        policy_id: "playground.v1",
        input: {
          issue: 10,
          retries: 2,
        },
      },
    });
    expect(runResponse.statusCode).toBe(200);
    expect(runResponse.json()).toMatchObject({
      status: "queued",
      project_id: "fixture",
      policy_id: "playground.v1",
    });
    const runId = runResponse.json().run_id as string;
    expect(runId).toMatch(/^run_[a-f0-9-]+$/);
    await waitForTerminalStatus(app, runId);
  });

  it("prefills playground project and policy from query params", async () => {
    const fixture = await createFixture(
      "playground-prefill.v1",
      `
policy_id: playground-prefill.v1
task_id: fix_bug
runner:
  provider: codex
retry:
  max_attempts: 1
      `.trim(),
      {},
    );
    const app = await createApp(fixture);

    const pageResponse = await app.inject({
      method: "GET",
      url: "/playground?project_id=fixture&policy_id=playground-prefill.v1&section=run",
    });

    expect(pageResponse.statusCode).toBe(200);
    expect(pageResponse.body).toContain('<option value="fixture" selected>');
    expect(pageResponse.body).toContain('<option value="playground-prefill.v1" selected>playground-prefill.v1 (fix_bug)</option>');
    expect(pageResponse.body).toContain('<details class="card accordion" open data-playground-section="run">');
  });
});
