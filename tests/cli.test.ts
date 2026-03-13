import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConduitConfig } from "../src/config";
import type { AgentRunner, RunOptions } from "../src/types/agent-types";
import { main } from "../cli";
import { createServer } from "../server";
import { registerRuntimeCommands } from "../src/cli/runtime";

const CONDUIT_PACKAGE_VERSION = "0.1.0";

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
  prompts: [] as Array<{ prompt: string; workingDirectory: string; kind: string; metadata: Record<string, string> }>,
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
        metadata: { ...(options.metadata ?? {}) },
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
            queueItemId: pending.queueItemId,
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
}

interface CaptureStream {
  chunks: string[];
  write(chunk: string): boolean;
}

const cleanupDirs: string[] = [];
const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
  fakeRunnerState.prompts = [];
  fakeRunnerState.behavior = null;
  fakeRunnerState.nextId = 1;
  fakeRunnerState.pending.clear();
  while (cleanupDirs.length > 0) {
    await rm(cleanupDirs.pop()!, { recursive: true, force: true });
  }
});

function createCaptureStream(): CaptureStream {
  return {
    chunks: [],
    write(chunk: string) {
      this.chunks.push(chunk);
      return true;
    },
  };
}

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

async function createFixture(
  policyId: string,
  policyYaml: string,
  files: Record<string, string>,
): Promise<TestContext> {
  const rootDir = await mkdtemp(join(tmpdir(), "conduit-cli-"));
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

  return { rootDir, stateDir, projectDir };
}

async function startServer(config: ConduitConfig): Promise<string> {
  const app = await createServer(config);
  servers.push(app);
  return app.listen({ host: "127.0.0.1", port: 0 });
}

describe("conduit CLI", () => {
  it("initializes global state with conduit install", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "conduit-home-"));
    cleanupDirs.push(homeDir);
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();
    const previousHome = process.env.HOME;

    process.env.HOME = homeDir;
    try {
      const exitCode = await main(["install", "--json"], { stdout, stderr });
      const result = JSON.parse(stdout.chunks.join(""));

      expect(exitCode).toBe(0);
      expect(result).toMatchObject({
        state_dir: join(homeDir, ".conduit"),
        config_path: join(homeDir, ".conduit", "config.yaml"),
        created_state_dir: true,
        created_config: true,
        created_runs_dir: true,
        assets: {
          package_version: CONDUIT_PACKAGE_VERSION,
          presets: {
            overwritten_files: 0,
            skipped_existing_files: 0,
          },
          components: {
            overwritten_files: 0,
            skipped_existing_files: 0,
          },
        },
      });
      expect(result.assets.presets.copied_files).toBeGreaterThan(0);
      expect(result.assets.components.copied_files).toBeGreaterThan(0);
      expect(await readFile(join(homeDir, ".conduit", "config.yaml"), "utf8")).toBe("conduit:\n  projects: {}\n");
      expect(await stat(join(homeDir, ".conduit", "runs"))).toBeTruthy();
      expect(
        JSON.parse(await readFile(join(homeDir, ".conduit", "presets", ".bundle-meta.json"), "utf8")).package_version,
      ).toBe(CONDUIT_PACKAGE_VERSION);
      expect(
        JSON.parse(await readFile(join(homeDir, ".conduit", "components", ".bundle-meta.json"), "utf8")).package_version,
      ).toBe(CONDUIT_PACKAGE_VERSION);
      const presetYaml = await readFile(join(homeDir, ".conduit", "presets", "basic", "preset.yaml"), "utf8");
      expect(presetYaml).toContain("intent: Select bundled components and bootstrap metadata");
      expect(presetYaml).toContain("runner_component: codex-gpt-5-3");
      expect(presetYaml).toContain("check_components:");
      expect(
        await readFile(
          join(homeDir, ".conduit", "components", "runners", "codex-gpt-5-3", "component.yaml"),
          "utf8",
        ),
      ).toContain("model: gpt-5.3-codex");
      expect(
        await readFile(
          join(homeDir, ".conduit", "components", "runners", "claude-sonnet-4-6", "component.yaml"),
          "utf8",
        ),
      ).toContain("model: claude-sonnet-4-6");
      expect(
        await readFile(
          join(homeDir, ".conduit", "components", "checks", "npm-test", "component.yaml"),
          "utf8",
        ),
      ).toContain("command: npm test");
      expect(
        await readFile(
          join(homeDir, ".conduit", "components", "checks", "ralph", "component.yaml"),
          "utf8",
        ),
      ).toContain("command: ./scripts/check.sh");
      expect(
        await readFile(
          join(homeDir, ".conduit", "components", "hooks", "worktree-from-main", "component.yaml"),
          "utf8",
        ),
      ).toContain("lifecycle: before_attempt");
      expect(
        await readFile(
          join(homeDir, ".conduit", "components", "hooks", "jingle-success", "component.yaml"),
          "utf8",
        ),
      ).toContain("lifecycle: on_success");
      expect(
        await readFile(
          join(homeDir, ".conduit", "components", "hooks", "jingle-failure", "component.yaml"),
          "utf8",
        ),
      ).toContain("lifecycle: on_failure");
      expect(
        (await stat(
          join(homeDir, ".conduit", "components", "hooks", "worktree-from-main", "scripts", "setup.sh"),
        )).mode &
          0o111,
      ).not.toBe(0);
      expect(
        (await stat(
          join(homeDir, ".conduit", "components", "hooks", "jingle-failure", "scripts", "complete.sh"),
        )).mode &
          0o111,
      ).not.toBe(0);
      expect(
        await stat(join(homeDir, ".conduit", "components", "hooks", "jingle-success", "assets", "success.wav")),
      ).toBeTruthy();
      expect(
        await stat(join(homeDir, ".conduit", "components", "hooks", "jingle-failure", "assets", "failure.wav")),
      ).toBeTruthy();
      expect(stderr.chunks.join("")).toBe("");
    } finally {
      process.env.HOME = previousHome;
    }
  });

  it("does not overwrite an existing bundled asset during conduit install", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "conduit-home-"));
    cleanupDirs.push(homeDir);
    await mkdir(join(homeDir, ".conduit", "components", "checks", "ralph"), { recursive: true });
    await writeFile(
      join(homeDir, ".conduit", "components", "checks", "ralph", "component.yaml"),
      "version: 1\ncomponent:\n  id: ralph\n  description: custom\n",
      "utf8",
    );

    const stdout = createCaptureStream();
    const stderr = createCaptureStream();
    const previousHome = process.env.HOME;

    process.env.HOME = homeDir;
    try {
      const exitCode = await main(["install", "--json"], { stdout, stderr });

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.chunks.join(""))).toMatchObject({
        created_state_dir: false,
        created_config: true,
        created_runs_dir: true,
        assets: {
          package_version: CONDUIT_PACKAGE_VERSION,
          components: {
            overwritten_files: 0,
          },
        },
      });
      expect(
        await readFile(join(homeDir, ".conduit", "components", "checks", "ralph", "component.yaml"), "utf8"),
      ).toBe("version: 1\ncomponent:\n  id: ralph\n  description: custom\n");
      expect(stderr.chunks.join("")).toBe("");
    } finally {
      process.env.HOME = previousHome;
    }
  });

  it("overwrites existing bundled assets when conduit install uses --force", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "conduit-home-"));
    cleanupDirs.push(homeDir);
    await mkdir(join(homeDir, ".conduit", "components", "checks", "ralph"), { recursive: true });
    await writeFile(
      join(homeDir, ".conduit", "components", "checks", "ralph", "component.yaml"),
      "version: 1\ncomponent:\n  id: ralph\n  description: custom\n",
      "utf8",
    );

    const stdout = createCaptureStream();
    const stderr = createCaptureStream();
    const previousHome = process.env.HOME;

    process.env.HOME = homeDir;
    try {
      const exitCode = await main(["install", "--json", "--force"], { stdout, stderr });

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.chunks.join(""))).toMatchObject({
        assets: {
          components: {
            overwritten_files: 1,
          },
        },
      });
      expect(
        await readFile(join(homeDir, ".conduit", "components", "checks", "ralph", "component.yaml"), "utf8"),
      ).toContain("description: Succeeds only when the attempt output contains the string DONE.");
      expect(stderr.chunks.join("")).toBe("");
    } finally {
      process.env.HOME = previousHome;
    }
  });

  it("uses only global config when running conduit install", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "conduit-home-"));
    const projectDir = await mkdtemp(join(tmpdir(), "conduit-project-"));
    cleanupDirs.push(homeDir, projectDir);
    await mkdir(join(homeDir, ".conduit"), { recursive: true });
    await writeFile(
      join(homeDir, ".conduit", "config.yaml"),
      "conduit:\n  stateDir: /tmp/custom-conduit-state\n  projects: {}\n",
      "utf8",
    );
    await mkdir(join(projectDir, ".conduit"), { recursive: true });
    await writeFile(join(projectDir, ".conduit", "config.yaml"), "conduit:\n  server:\n    port: nope\n", "utf8");

    const stdout = createCaptureStream();
    const stderr = createCaptureStream();
    const previousHome = process.env.HOME;
    const previousCwd = process.cwd();

    process.env.HOME = homeDir;
    process.chdir(projectDir);
    try {
      const exitCode = await main(["install", "--json"], { stdout, stderr });
      const result = JSON.parse(stdout.chunks.join(""));

      expect(exitCode).toBe(0);
      expect(result).toMatchObject({
        state_dir: "/tmp/custom-conduit-state",
        config_path: join(homeDir, ".conduit", "config.yaml"),
        created_state_dir: true,
        created_config: false,
        created_runs_dir: true,
        assets: {
          package_version: CONDUIT_PACKAGE_VERSION,
          presets: {
            overwritten_files: 0,
            skipped_existing_files: 0,
          },
          components: {
            overwritten_files: 0,
            skipped_existing_files: 0,
          },
        },
      });
      expect(result.assets.presets.copied_files).toBeGreaterThan(0);
      expect(result.assets.components.copied_files).toBeGreaterThan(0);
      expect(await readFile(join(homeDir, ".conduit", "config.yaml"), "utf8")).toBe(
        "conduit:\n  stateDir: /tmp/custom-conduit-state\n  projects: {}\n",
      );
      expect(stderr.chunks.join("")).toBe("");
    } finally {
      process.chdir(previousCwd);
      process.env.HOME = previousHome;
      await rm("/tmp/custom-conduit-state", { recursive: true, force: true });
    }
  });

  it("initializes the current repo with the basic bundled preset", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "conduit-home-"));
    const repoDir = await mkdtemp(join(tmpdir(), "sample-repo-"));
    cleanupDirs.push(homeDir, repoDir);
    await mkdir(join(repoDir, ".git"), { recursive: true });
    await writeFile(join(repoDir, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");

    const stdout = createCaptureStream();
    const stderr = createCaptureStream();
    const previousHome = process.env.HOME;
    const previousCwd = process.cwd();

    process.env.HOME = homeDir;
    process.chdir(repoDir);
    try {
      const exitCode = await main(["init", "--json", "--yes"], { stdout, stderr });
      const result = JSON.parse(stdout.chunks.join(""));

      expect(exitCode).toBe(0);
      expect(result).toMatchObject({
        project_id: basename(repoDir).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""),
        policy_id: "default.v1",
        installed_global_state: {
          created_state_dir: true,
          created_config: true,
        },
      });
      expect(result.project_path.endsWith(basename(repoDir))).toBe(true);
      expect(await readFile(join(homeDir, ".conduit", "config.yaml"), "utf8")).toContain(`${result.project_id}:`);
      expect(await readFile(join(repoDir, ".conduit", "config.yaml"), "utf8")).toContain(`id: ${result.project_id}`);

      const policyYaml = await readFile(join(repoDir, ".conduit", "policies", "default.v1", "policy.yaml"), "utf8");
      expect(policyYaml).toContain("policy_id: default.v1");
      expect(policyYaml).toContain("task_id: default");
      expect(policyYaml).toContain("provider: codex");
      expect(policyYaml).toContain("model: gpt-5.3-codex");
      expect(policyYaml).toContain("before_attempt:");
      expect(policyYaml).toContain("./hooks/worktree-from-main/scripts/setup.sh");
      expect(policyYaml).toContain("checks: []");
      await expect(readFile(join(repoDir, ".conduit", "policies", "default.v1", "prompt.md"), "utf8")).resolves.toContain(
        "Default Prompt",
      );
      expect(stderr.chunks.join("")).toBe("");
    } finally {
      process.chdir(previousCwd);
      process.env.HOME = previousHome;
    }
  });

  it("initializes the current directory without git by skipping git-dependent default hooks", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "conduit-home-"));
    const projectDir = await mkdtemp(join(tmpdir(), "plain-project-"));
    cleanupDirs.push(homeDir, projectDir);

    const stdout = createCaptureStream();
    const stderr = createCaptureStream();
    const previousHome = process.env.HOME;
    const previousCwd = process.cwd();

    process.env.HOME = homeDir;
    process.chdir(projectDir);
    try {
      const exitCode = await main(["init", "--json", "--yes"], { stdout, stderr });

      expect(exitCode).toBe(0);
      const policyYaml = await readFile(join(projectDir, ".conduit", "policies", "default.v1", "policy.yaml"), "utf8");
      expect(policyYaml).not.toContain("./hooks/worktree-from-main/scripts/setup.sh");
      expect(policyYaml).toContain("checks: []");
      expect(stderr.chunks.join("")).toBe("");
    } finally {
      process.chdir(previousCwd);
      process.env.HOME = previousHome;
    }
  });

  it("fails when a git-dependent hook is explicitly selected outside a git repo", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "conduit-home-"));
    const projectDir = await mkdtemp(join(tmpdir(), "plain-project-"));
    cleanupDirs.push(homeDir, projectDir);

    const stdout = createCaptureStream();
    const stderr = createCaptureStream();
    const previousHome = process.env.HOME;
    const previousCwd = process.cwd();

    process.env.HOME = homeDir;
    process.chdir(projectDir);
    try {
      const exitCode = await main(["init", "--json", "--yes", "--hook", "worktree-from-main"], { stdout, stderr });

      expect(exitCode).toBe(1);
      expect(stderr.chunks.join("")).toContain("requires git");
    } finally {
      process.chdir(previousCwd);
      process.env.HOME = previousHome;
    }
  });

  it("lets conduit init override the bundled defaults with selected components", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "conduit-home-"));
    const repoDir = await mkdtemp(join(tmpdir(), "sample-repo-"));
    cleanupDirs.push(homeDir, repoDir);
    await mkdir(join(repoDir, ".git"), { recursive: true });
    await writeFile(join(repoDir, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");

    const stdout = createCaptureStream();
    const stderr = createCaptureStream();
    const previousHome = process.env.HOME;
    const previousCwd = process.cwd();

    process.env.HOME = homeDir;
    process.chdir(repoDir);
    try {
      const exitCode = await main(
        [
          "init",
          "--json",
          "--yes",
          "--force",
          "--project-id",
          "demo-app",
          "--runner",
          "claude-sonnet-4-6",
          "--check",
          "npm-test",
          "--hook",
          "jingle-success",
          "--hook",
          "jingle-failure",
        ],
        { stdout, stderr },
      );

      expect(exitCode).toBe(0);
      const policyYaml = await readFile(join(repoDir, ".conduit", "policies", "default.v1", "policy.yaml"), "utf8");
      expect(policyYaml).toContain("provider: claude");
      expect(policyYaml).toContain("model: claude-sonnet-4-6");
      expect(policyYaml).toContain("command: npm test");
      expect(policyYaml).toContain("./hooks/jingle-success/scripts/complete.sh");
      expect(policyYaml).toContain("./hooks/jingle-failure/scripts/complete.sh failure");
      expect(await readFile(join(homeDir, ".conduit", "config.yaml"), "utf8")).toContain("demo-app:");
      expect(await readFile(join(repoDir, ".conduit", "config.yaml"), "utf8")).toContain("id: demo-app");
      expect(
        await stat(join(repoDir, ".conduit", "policies", "default.v1", "hooks", "jingle-success", "assets", "success.wav")),
      ).toBeTruthy();
      expect(
        await stat(join(repoDir, ".conduit", "policies", "default.v1", "hooks", "jingle-failure", "assets", "failure.wav")),
      ).toBeTruthy();
      expect(stderr.chunks.join("")).toBe("");
    } finally {
      process.chdir(previousCwd);
      process.env.HOME = previousHome;
    }
  });

  it("uses interactive picker selections for conduit init", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "conduit-home-"));
    const repoDir = await mkdtemp(join(tmpdir(), "sample-repo-"));
    cleanupDirs.push(homeDir, repoDir);
    await mkdir(join(repoDir, ".git"), { recursive: true });
    await writeFile(join(repoDir, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");

    const stdout = createCaptureStream();
    const stderr = createCaptureStream();
    const promptInitSelections = vi.fn(async () => ({
      preset: "basic",
      runnerComponent: "claude-sonnet-4-6",
      beforeAttemptHookComponents: ["worktree-from-main"],
      checkComponents: ["npm-test"],
      optionalHookComponents: ["jingle-success"],
      projectId: "interactive-demo",
    }));
    const previousHome = process.env.HOME;
    const previousCwd = process.cwd();

    process.env.HOME = homeDir;
    process.chdir(repoDir);
    try {
      const exitCode = await main(["init", "--json"], {
        stdout,
        stderr,
        initInteractive: true,
        promptInitSelections,
      });

      expect(exitCode).toBe(0);
      expect(promptInitSelections).toHaveBeenCalledTimes(1);
      const policyYaml = await readFile(join(repoDir, ".conduit", "policies", "default.v1", "policy.yaml"), "utf8");
      expect(policyYaml).toContain("provider: claude");
      expect(policyYaml).toContain("command: npm test");
      expect(policyYaml).toContain("./hooks/jingle-success/scripts/complete.sh");
      expect(await readFile(join(homeDir, ".conduit", "config.yaml"), "utf8")).toContain("interactive-demo:");
      expect(await readFile(join(repoDir, ".conduit", "config.yaml"), "utf8")).toContain("id: interactive-demo");
      expect(stderr.chunks.join("")).toBe("");
    } finally {
      process.chdir(previousCwd);
      process.env.HOME = previousHome;
    }
  });

  it("treats a bare prompt as the chat command", async () => {
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();
    fakeRunnerState.behavior = async () => ({
      stdout: ["chat ok"],
    });

    const exitCode = await main(["Write tests", "--runner", "codex"], {
      loadConfig: async () => baseConfig(join(tmpdir(), "unused-state"), join(tmpdir(), "unused-project")),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(fakeRunnerState.prompts).toHaveLength(1);
    expect(fakeRunnerState.prompts[0].prompt).toBe("Write tests");
    expect(stdout.chunks.join("")).toContain("chat ok");
    expect(stderr.chunks.join("")).toBe("");
  });

  it("preserves an inline runner model on the local chat path", async () => {
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();
    fakeRunnerState.behavior = async () => ({
      stdout: ["chat ok"],
    });

    const exitCode = await main(["Write tests", "--runner", "codex/gpt-5"], {
      loadConfig: async () => baseConfig(join(tmpdir(), "unused-state"), join(tmpdir(), "unused-project")),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(fakeRunnerState.prompts).toHaveLength(1);
    expect(fakeRunnerState.prompts[0].kind).toBe("codex");
    expect(fakeRunnerState.prompts[0].metadata).toEqual({
      requestedModel: "gpt-5",
    });
  });

  it("lists projects locally without requiring the runtime", async () => {
    const fixture = await createFixture(
      "policy-one.v1",
      `
policy_id: policy-one.v1
task_id: fix_bug
runner:
  provider: codex
retry:
  max_attempts: 1
      `.trim(),
      {},
    );
    const config = baseConfig(fixture.stateDir, fixture.projectDir);
    const stdout = createCaptureStream();

    const exitCode = await main(["projects", "list", "--json"], {
      loadConfig: async () => config,
      stdout,
      stderr: createCaptureStream(),
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.chunks.join(""))).toEqual([
      {
        project_id: "fixture",
        path: fixture.projectDir,
      },
    ]);
  });

  it("creates a run and waits for terminal status", async () => {
    const fixture = await createFixture(
      "success.v1",
      `
policy_id: success.v1
task_id: fix_bug
runner:
  provider: codex
checks:
  - name: smoke
    command: ./success.sh
    on_fail: retry
retry:
  max_attempts: 1
      `.trim(),
      {
        "success.sh": "#!/usr/bin/env bash\necho success\nexit 0\n",
      },
    );
    const config = baseConfig(fixture.stateDir, fixture.projectDir);
    const stdout = createCaptureStream();

    const exitCode = await main(
      [
        "runs",
        "create",
        "--project",
        "fixture",
        "--policy",
        "success.v1",
        "--input",
        '{"issue":1}',
        "--wait",
        "--attempts",
        "--json",
      ],
      {
        loadConfig: async () => config,
        stdout,
        stderr: createCaptureStream(),
        sleep: async () => new Promise((resolve) => setTimeout(resolve, 1)),
      },
    );

    const run = JSON.parse(stdout.chunks.join(""));
    expect(exitCode).toBe(0);
    expect(run.status).toBe("succeeded");
    expect(run.project_id).toBe("fixture");
    expect(run.attempts).toHaveLength(1);
    expect(run.attempts[0].check_results[0].passed).toBe(true);
  });

  it("accepts an inline runner model on runs create", async () => {
    const fixture = await createFixture(
      "success.v1",
      `
policy_id: success.v1
task_id: fix_bug
runner:
  provider: codex
checks:
  - name: smoke
    command: ./success.sh
    on_fail: retry
retry:
  max_attempts: 1
      `.trim(),
      {
        "success.sh": "#!/usr/bin/env bash\necho success\nexit 0\n",
      },
    );
    const config = baseConfig(fixture.stateDir, fixture.projectDir);
    const stdout = createCaptureStream();

    const exitCode = await main(
      [
        "runs",
        "create",
        "--project",
        "fixture",
        "--policy",
        "success.v1",
        "--input",
        '{"issue":1}',
        "--runner",
        "codex/gpt-5",
        "--wait",
        "--json",
      ],
      {
        loadConfig: async () => config,
        stdout,
        stderr: createCaptureStream(),
        sleep: async () => new Promise((resolve) => setTimeout(resolve, 1)),
      },
    );

    const run = JSON.parse(stdout.chunks.join(""));
    expect(exitCode).toBe(0);
    expect(run.requested_runner).toEqual({
      provider: "codex",
      model: "gpt-5",
    });
  });

  it("reports runtime status and starts the runtime via the runtime commands", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "conduit-runtime-state-"));
    cleanupDirs.push(stateDir);
    const stdout = createCaptureStream();
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        }),
      );
    const spawnFn = vi.fn(() => ({
      pid: 4321,
      unref: vi.fn(),
    })) as unknown as typeof import("node:child_process").spawn;

    const parser = (await import("yargs")).default(["runtime", "start", "--base-url", "http://127.0.0.1:9999", "--json"])
      .exitProcess(false)
      .fail((message, error) => {
        throw error ?? new Error(message);
      });

    registerRuntimeCommands(parser, {
      stdout,
      fetchFn,
      sleep: async () => undefined,
      config: { stateDir },
      spawnFn,
    });

    await parser.parseAsync();

    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(spawnFn).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(["tsx", expect.stringMatching(/[\\/]server\.ts$/)]),
      expect.objectContaining({
        detached: true,
        stdio: "ignore",
      }),
    );
    expect(JSON.parse(stdout.chunks.join(""))).toMatchObject({
      base_url: "http://127.0.0.1:9999",
      started: true,
      already_running: false,
      pid: 4321,
    });
    expect(JSON.parse(await readFile(join(stateDir, "runtime.json"), "utf8"))).toMatchObject({
      base_url: "http://127.0.0.1:9999",
      pid: 4321,
    });
  });

  it("runs conduit serve in the foreground", async () => {
    const serveFn = vi.fn(async () => undefined);
    const config = baseConfig(join(tmpdir(), "unused-state"), join(tmpdir(), "unused-project"));

    const exitCode = await main(["serve", "--host", "127.0.0.1", "--port", "9999"], {
      loadConfig: async () => config,
      stdout: createCaptureStream(),
      stderr: createCaptureStream(),
      serveFn,
    });

    expect(exitCode).toBe(0);
    expect(serveFn).toHaveBeenCalledWith({
      config,
      host: "127.0.0.1",
      port: 9999,
    });
  });

  it("stops a managed runtime and clears the runtime state file", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "conduit-runtime-state-"));
    cleanupDirs.push(stateDir);
    await writeFile(
      join(stateDir, "runtime.json"),
      `${JSON.stringify({
        base_url: "http://127.0.0.1:9999",
        pid: 4321,
        started_at: new Date().toISOString(),
      })}\n`,
      "utf8",
    );
    const stdout = createCaptureStream();
    const killFn = vi.fn();

    const parser = (await import("yargs")).default(["runtime", "stop", "--base-url", "http://127.0.0.1:9999", "--json"])
      .exitProcess(false)
      .fail((message, error) => {
        throw error ?? new Error(message);
      });

    registerRuntimeCommands(parser, {
      stdout,
      fetchFn: vi.fn(),
      sleep: async () => undefined,
      config: { stateDir },
      killFn,
    });

    await parser.parseAsync();

    expect(killFn).toHaveBeenCalledWith(4321, "SIGTERM");
    expect(JSON.parse(stdout.chunks.join(""))).toEqual({
      base_url: "http://127.0.0.1:9999",
      stopped: true,
      found: true,
      pid: 4321,
    });
    await expect(readFile(join(stateDir, "runtime.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("watches a failed run and returns a non-zero exit code", async () => {
    const fixture = await createFixture(
      "failure.v1",
      `
policy_id: failure.v1
task_id: fix_bug
runner:
  provider: codex
checks:
  - name: smoke
    command: ./failure.sh
    on_fail: fail
retry:
  max_attempts: 1
      `.trim(),
      {
        "failure.sh": "#!/usr/bin/env bash\necho no\nexit 1\n",
      },
    );
    const config = baseConfig(fixture.stateDir, fixture.projectDir);
    const baseUrl = await startServer(config);
    const createResponse = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        project_id: "fixture",
        policy_id: "failure.v1",
        input: { issue: 2 },
      }),
    });
    const created = (await createResponse.json()) as { run_id: string };
    const stdout = createCaptureStream();

    const exitCode = await main(
      ["runs", "watch", created.run_id, "--attempts", "--base-url", baseUrl, "--interval", "1"],
      {
        loadConfig: async () => config,
        stdout,
        stderr: createCaptureStream(),
        sleep: async () => new Promise((resolve) => setTimeout(resolve, 1)),
      },
    );

    expect(exitCode).toBe(1);
    expect(stdout.chunks.join("")).toContain("status: failed");
    expect(stdout.chunks.join("")).toContain("check 1/smoke: failed");
  });
});
