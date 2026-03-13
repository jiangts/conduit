import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ConduitConfig } from "../src/config";
import type { AgentRunner, ThreadRecord } from "../src/types/agent-types";

const storeState = {
  latestThread: null as ThreadRecord | null,
  queueCounts: { queued: 0, active: 0 },
  cancelResult: true,
  initCalls: 0,
  runCalls: [] as Array<{
    prompt: string;
    workingDirectory?: string;
    resumeThreadId?: string;
    metadata?: Record<string, string>;
  }>,
};

class FakeSqliteAgentQueueStore {
  public constructor(_dbPath: string) {}

  public close(): void {}

  public async mergeMetadata(_id: string, _metadata: Record<string, string>): Promise<void> {}

  public async getLatestByThreadId(_threadId: string): Promise<ThreadRecord | null> {
    return storeState.latestThread;
  }

  public async getQueueCounts(): Promise<{ queued: number; active: number }> {
    return storeState.queueCounts;
  }
}

const fakeRunner: AgentRunner = {
  kind: "codex",
  async init() {
    storeState.initCalls += 1;
  },
  async awaitIdle() {},
  async run(prompt, options = {}) {
    storeState.runCalls.push({
      prompt,
      workingDirectory: options.workingDirectory,
      resumeThreadId: options.resumeThreadId,
      metadata: options.metadata,
    });
    options.callbacks?.onQueued?.({
      threadId: "thread-1",
      queueItemId: "queue-1",
      emittedAt: new Date().toISOString(),
    });
    options.callbacks?.onStart?.({
      threadId: "thread-1",
      queueItemId: "queue-1",
      pid: 123,
      startedAt: new Date().toISOString(),
      emittedAt: new Date().toISOString(),
    });
    options.callbacks?.onStdout?.({
      threadId: "thread-1",
      queueItemId: "queue-1",
      pid: 123,
      stream: "stdout",
      chunk: "hi",
      emittedAt: new Date().toISOString(),
    });
    options.callbacks?.onExit?.({
      threadId: "thread-1",
      queueItemId: "queue-1",
      pid: 123,
      code: 0,
      signal: null,
      finalState: "completed",
      endedAt: new Date().toISOString(),
      emittedAt: new Date().toISOString(),
    });
    return {
      threadId: "thread-1",
      queueItemId: "queue-1",
    };
  },
  async isRunning() {
    return false;
  },
  async getThread(threadId) {
    return storeState.latestThread?.threadId === threadId ? storeState.latestThread : null;
  },
  async cancel(_threadId: string) {
    return storeState.cancelResult;
  },
  extractFinalMessage(stdout: string) {
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  },
  extractUsage() {
    return null;
  },
};

vi.mock("../src/index", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/index")>();
  return {
    ...actual,
    SqliteAgentQueueStore: FakeSqliteAgentQueueStore,
    createRunner: vi.fn(() => fakeRunner),
  };
});

describe("Conduit /chat routes", () => {
  beforeEach(() => {
    storeState.latestThread = null;
    storeState.queueCounts = { queued: 0, active: 0 };
    storeState.cancelResult = true;
    storeState.initCalls = 0;
    storeState.runCalls = [];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function baseConfig(): ConduitConfig {
    return {
      defaultRunner: "codex",
      stateDir: "/tmp/conduit-chat-test",
      projects: {
        fixture: {
          path: "/tmp/conduit-chat-project",
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
        allowInit: true,
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

  it("executes POST /chat with the runner object contract", async () => {
    const { createServer } = await import("../server");
    const app = await createServer(baseConfig());

    const response = await app.inject({
      method: "POST",
      url: "/chat",
      payload: {
        project_id: "fixture",
        prompt: "fix this",
        external_ref: "chat-123",
        runner: {
          provider: "codex",
          model: "gpt-5-codex",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      threadId: "thread-1",
      queueItemId: "queue-1",
      finalMessage: "hi",
      exit: {
        code: 0,
        finalState: "completed",
      },
    });
    expect(storeState.runCalls).toEqual([
      {
        prompt: "fix this",
        workingDirectory: "/tmp/conduit-chat-project",
        resumeThreadId: undefined,
        metadata: {
          projectId: "fixture",
          externalRef: "chat-123",
          requestedModel: "gpt-5-codex",
        },
      },
    ]);

    await app.close();
  });

  it("returns thread status from GET /chat/threads/:threadId", async () => {
    const { createServer } = await import("../server");
    storeState.latestThread = {
      threadId: "thread-1",
      queueItemId: "queue-1",
      state: "completed",
      pid: null,
      prompt: "fix this",
      metadata: {},
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      exitCode: 0,
      exitSignal: null,
    };
    const app = await createServer(baseConfig());

    const response = await app.inject({
      method: "GET",
      url: "/chat/threads/thread-1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      threadId: "thread-1",
      running: false,
      thread: {
        threadId: "thread-1",
        queueItemId: "queue-1",
        state: "completed",
      },
    });

    await app.close();
  });

  it("serves the persisted final output for a chat thread", async () => {
    const { createServer } = await import("../server");
    const outputDir = await mkdtemp(join(tmpdir(), "conduit-chat-output-"));
    const finalPath = join(outputDir, "final.txt");
    await writeFile(finalPath, "hello from final output\n", "utf8");
    storeState.latestThread = {
      threadId: "thread-1",
      queueItemId: "queue-1",
      state: "completed",
      pid: null,
      prompt: "fix this",
      metadata: {
        finalOutputPath: finalPath,
      },
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      exitCode: 0,
      exitSignal: null,
    };
    const app = await createServer(baseConfig());

    const response = await app.inject({
      method: "GET",
      url: "/chat/threads/thread-1/output/final",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.body).toContain("hello from final output");

    await app.close();
  });

  it("rejects POST /chat for unknown project ids", async () => {
    const { createServer } = await import("../server");
    const app = await createServer(baseConfig());

    const response = await app.inject({
      method: "POST",
      url: "/chat",
      payload: {
        project_id: "missing",
        prompt: "fix this",
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: 'Unknown project_id "missing"',
    });

    await app.close();
  });

  it("cancels via POST /chat/threads/:threadId/cancel", async () => {
    const { createServer } = await import("../server");
    const app = await createServer(baseConfig());

    const response = await app.inject({
      method: "POST",
      url: "/chat/threads/thread-1/cancel",
      payload: {
        runner: {
          provider: "codex",
          model: null,
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      threadId: "thread-1",
      cancelled: true,
    });

    await app.close();
  });

  it("initializes via POST /chat/init when enabled", async () => {
    const { createServer } = await import("../server");
    const app = await createServer(baseConfig());

    const response = await app.inject({
      method: "POST",
      url: "/chat/init",
      payload: {
        runner: {
          provider: "codex",
          model: null,
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(storeState.initCalls).toBe(1);

    await app.close();
  });
});
