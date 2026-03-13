import { randomUUID } from "node:crypto";
import { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

import {
  AgentKind,
  AgentQueueStore,
  AgentRunUsage,
  DEFAULT_QUEUE_POLICY,
  AgentRunner,
  mergeQueuePolicy,
  QueuePolicy,
  OutputStream,
  QueueItem,
  RunCallbacks,
  RunOptions,
  RunResult,
  SpawnInput,
  ThreadRecord,
  ThreadState,
} from "./types/agent-types";

export interface AgentRunnerInitOptions {
  defaultWorkingDirectory?: string;
  queuePolicy?: QueuePolicy;
}

export abstract class AbstractAgentRunner implements AgentRunner {
  public abstract readonly kind: AgentKind;
  protected readonly store: AgentQueueStore;
  protected readonly defaultWorkingDirectory: string;
  protected readonly queuePolicy: QueuePolicy;

  private readonly callbacksByThreadId = new Map<string, RunCallbacks>();
  private readonly queuePolicyByQueueItemId = new Map<string, QueuePolicy>();
  private readonly runningByThreadId = new Map<string, ChildProcess>();
  private draining = false;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private drainPromise: Promise<void> | null = null;

  protected constructor(store: AgentQueueStore, defaultWorkingDirectory?: string);
  protected constructor(store: AgentQueueStore, options?: AgentRunnerInitOptions);
  protected constructor(
    store: AgentQueueStore,
    defaultWorkingDirectoryOrOptions: string | AgentRunnerInitOptions = process.cwd(),
  ) {
    this.store = store;
    if (typeof defaultWorkingDirectoryOrOptions === "string") {
      this.defaultWorkingDirectory = defaultWorkingDirectoryOrOptions;
      this.queuePolicy = mergeQueuePolicy(DEFAULT_QUEUE_POLICY);
      return;
    }

    const options = defaultWorkingDirectoryOrOptions;
    this.defaultWorkingDirectory = options.defaultWorkingDirectory ?? process.cwd();
    this.queuePolicy = mergeQueuePolicy(options.queuePolicy ?? DEFAULT_QUEUE_POLICY);
  }

  public async init(): Promise<void> {
    await this.ensureInitialized();
  }

  public async run(prompt: string, options: RunOptions = {}): Promise<RunResult> {
    await this.ensureInitialized();
    const threadId = options.resumeThreadId ?? randomUUID();
    const queueItemId = randomUUID();
    const effectiveQueuePolicy = mergeQueuePolicy(this.queuePolicy, options.queuePolicy);

    if (options.callbacks) {
      this.callbacksByThreadId.set(threadId, options.callbacks);
    }
    this.queuePolicyByQueueItemId.set(queueItemId, effectiveQueuePolicy);

    await this.store.enqueue({
      id: queueItemId,
      threadId,
      prompt,
      workingDirectory: options.workingDirectory ?? this.defaultWorkingDirectory,
      metadata: options.metadata ?? {},
    });

    options.callbacks?.onQueued?.({ threadId, queueItemId, emittedAt: this.nowIso() });
    void this.drainQueue();
    return { threadId, queueItemId };
  }

  public async isRunning(threadId: string): Promise<boolean> {
    await this.ensureInitialized();
    const record = await this.store.getLatestByThreadId(threadId);
    if (!record) return false;

    // PID is source-of-truth when present.
    if (record.pid !== null) {
      return this.isPidAlive(record.pid);
    }

    // Fallback for queued/starting records that do not yet have a PID.
    return record.state === "queued" || record.state === "starting" || record.state === "running";
  }

  public async getThread(threadId: string): Promise<ThreadRecord | null> {
    await this.ensureInitialized();
    return this.store.getLatestByThreadId(threadId);
  }

  public async awaitIdle(): Promise<void> {
    await this.ensureInitialized();
    await this.drainPromise;
  }

  public async cancel(threadId: string): Promise<boolean> {
    await this.ensureInitialized();
    const child = this.runningByThreadId.get(threadId);
    if (!child || !child.pid) return false;
    child.kill("SIGTERM");
    return true;
  }

  public extractFinalMessage(stdout: string): string | null {
    const trimmed = stdout.trim();
    if (trimmed.length === 0) {
      return null;
    }

    const parsed = this.extractFinalMessageFromJsonLines(trimmed);
    return parsed ?? trimmed;
  }

  public extractUsage(_stdout: string): AgentRunUsage | null {
    return null;
  }

  protected abstract spawnAgent(input: SpawnInput): Promise<ChildProcess>;
  protected async onInit(): Promise<void> {
    // Optional extension point for provider setup (e.g. creating worktrees).
  }
  protected shouldEmitOutput(_stream: OutputStream, _chunk: string): boolean {
    return true;
  }

  public static sqliteSchemaSql(): string {
    return `
CREATE TABLE IF NOT EXISTS agent_queue (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  working_directory TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  state TEXT NOT NULL,
  pid INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at TEXT,
  ended_at TEXT,
  exit_code INTEGER,
  exit_signal TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_queue_state ON agent_queue(state);
CREATE INDEX IF NOT EXISTS idx_agent_queue_thread ON agent_queue(thread_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_output (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_item_id TEXT NOT NULL,
  stream TEXT NOT NULL,
  chunk TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY(queue_item_id) REFERENCES agent_queue(id)
);
`.trim();
  }

  private async drainQueue(): Promise<void> {
    if (this.drainPromise) {
      await this.drainPromise;
      return;
    }

    this.drainPromise = (async () => {
      if (this.draining) return;
      this.draining = true;

      try {
        while (true) {
          const item = await this.store.claimNextQueued({ policy: this.queuePolicy });
          if (!item) break;
          await this.executeItem(item);
        }
      } finally {
        this.draining = false;
        this.drainPromise = null;
      }
    })();

    await this.drainPromise;
  }

  private async executeItem(item: QueueItem): Promise<void> {
    const callbacks = this.callbacksByThreadId.get(item.threadId);
    await this.transition(item, "starting");

    let child: ChildProcess;
    try {
      child = await this.spawnAgent({
        threadId: item.threadId,
        queueItemId: item.id,
        prompt: item.prompt,
        workingDirectory: item.workingDirectory,
        metadata: item.metadata,
      });
    } catch (error) {
      const err = this.toError(error);
      callbacks?.onError?.({
        threadId: item.threadId,
        queueItemId: item.id,
        pid: null,
        error: err,
        emittedAt: this.nowIso(),
      });
      await this.store.finish(item.id, { state: "failed", code: null, signal: null });
      this.queuePolicyByQueueItemId.delete(item.id);
      return;
    }

    if (!child.pid) {
      const err = new Error("Spawned process has no PID");
      callbacks?.onError?.({
        threadId: item.threadId,
        queueItemId: item.id,
        pid: null,
        error: err,
        emittedAt: this.nowIso(),
      });
      await this.store.finish(item.id, { state: "failed", code: null, signal: null });
      this.queuePolicyByQueueItemId.delete(item.id);
      return;
    }

    await this.store.attachPid(item.id, child.pid);
    await this.transition(item, "running");
    const startedAt = this.nowIso();
    callbacks?.onStart?.({
      threadId: item.threadId,
      queueItemId: item.id,
      pid: child.pid,
      startedAt,
      emittedAt: startedAt,
    });
    this.runningByThreadId.set(item.threadId, child);

    if (child.stdout) {
      const rl = createInterface({ input: child.stdout });
      rl.on("line", async (line) => {
        await this.emitOutput(callbacks, item, child.pid ?? null, "stdout", line);
      });
    }

    if (child.stderr) {
      const rl = createInterface({ input: child.stderr });
      rl.on("line", async (line) => {
        await this.emitOutput(callbacks, item, child.pid ?? null, "stderr", line);
      });
    }

    await new Promise<void>((resolve) => {
      child.once("exit", async (code, signal) => {
        const finalState: ThreadState = code === 0 ? "completed" : signal === "SIGTERM" ? "cancelled" : "failed";
        await this.store.finish(item.id, { state: finalState, code, signal });
        this.runningByThreadId.delete(item.threadId);
        this.queuePolicyByQueueItemId.delete(item.id);
        const endedAt = this.nowIso();
        callbacks?.onExit?.({
          threadId: item.threadId,
          queueItemId: item.id,
          pid: child.pid ?? null,
          code,
          signal,
          finalState,
          endedAt,
          emittedAt: endedAt,
        });
        resolve();
      });
    });
  }

  private async transition(item: QueueItem, to: ThreadState): Promise<void> {
    const from = item.state;
    if (from === to) return;
    await this.store.markState(item.id, to);
    const callbacks = this.callbacksByThreadId.get(item.threadId);
    callbacks?.onStateChange?.({ threadId: item.threadId, from, to });
    item.state = to;
  }

  private isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private toError(error: unknown): Error {
    if (error instanceof Error) return error;
    return new Error(String(error));
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (this.initPromise) {
      await this.initPromise;
      return;
    }
    this.initPromise = this.onInit();
    try {
      await this.initPromise;
      this.initialized = true;
    } finally {
      this.initPromise = null;
    }
  }

  private async emitOutput(
    callbacks: RunCallbacks | undefined,
    item: QueueItem,
    pid: number | null,
    stream: OutputStream,
    chunk: string,
  ): Promise<void> {
    if (!this.shouldEmitOutput(stream, chunk)) {
      return;
    }
    await this.store.appendOutput(item.id, stream, chunk);
    const event = {
      threadId: item.threadId,
      queueItemId: item.id,
      pid,
      stream,
      chunk,
      emittedAt: this.nowIso(),
    };
    if (stream === "stdout") {
      callbacks?.onStdout?.(event);
    } else {
      callbacks?.onStderr?.(event);
    }
  }

  protected parseJsonLines(stdout: string): unknown[] {
    const events: unknown[] = [];

    for (const rawLine of stdout.split("\n")) {
      const line = rawLine.trim();
      if (line.length === 0) {
        continue;
      }

      try {
        events.push(JSON.parse(line) as unknown);
      } catch {
        // Ignore non-JSON lines and let callers fall back to raw stdout.
      }
    }

    return events;
  }

  protected extractText(value: unknown): string | null {
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    }

    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        const nested = this.extractText(value[index]);
        if (nested !== null) {
          return nested;
        }
      }
      return null;
    }

    if (!value || typeof value !== "object") {
      return null;
    }

    const record = value as Record<string, unknown>;
    const directKeys = [
      "result",
      "message",
      "text",
      "content",
      "final_message",
      "finalMessage",
      "output",
      "response",
    ] as const;

    for (const key of directKeys) {
      const nested = this.extractText(record[key]);
      if (nested !== null) {
        return nested;
      }
    }

    const nestedKeys = ["data", "delta", "payload"] as const;
    for (const key of nestedKeys) {
      const nested = this.extractText(record[key]);
      if (nested !== null) {
        return nested;
      }
    }

    return null;
  }

  protected createUsage(input: Partial<AgentRunUsage>): AgentRunUsage | null {
    const usage: AgentRunUsage = {
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      cachedInputTokens: input.cachedInputTokens ?? null,
      cacheWriteTokens: input.cacheWriteTokens ?? null,
      totalTokens: input.totalTokens ?? null,
      costUsd: input.costUsd ?? null,
    };

    return Object.values(usage).some((value) => value !== null) ? usage : null;
  }

  private nowIso(): string {
    return new Date().toISOString();
  }

  private extractFinalMessageFromJsonLines(stdout: string): string | null {
    let lastMessage: string | null = null;

    for (const parsed of this.parseJsonLines(stdout)) {
      const message = this.extractText(parsed);
      if (message !== null) {
        lastMessage = message;
      }
    }

    return lastMessage;
  }
}
