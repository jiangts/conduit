import { ChildProcess } from "node:child_process";

export type AgentKind = "claude" | "codex" | "cursor" | "gemini";

export type ThreadState =
  | "queued"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type OutputStream = "stdout" | "stderr";

export type QueueDispatchPolicy = "fifo" | "priority";

export interface ThreadConcurrencyPolicy {
  maxActivePerThread: number;
}

export type RecoveryMode = "mark_failed" | "requeue";

export interface RecoveryPolicy {
  mode: RecoveryMode;
}

export interface CancellationPolicy {
  sigtermTimeoutMs: number;
  sigkillAfterTimeout: boolean;
}

export interface RetryPolicy {
  maxAttempts: number;
  backoffMs: number;
}

export interface QueuePolicy {
  dispatch: QueueDispatchPolicy;
  threadConcurrency: ThreadConcurrencyPolicy;
  recovery: RecoveryPolicy;
  cancellation: CancellationPolicy;
  retry: RetryPolicy;
}

export interface QueuePolicyOverride {
  dispatch?: QueueDispatchPolicy;
  threadConcurrency?: Partial<ThreadConcurrencyPolicy>;
  recovery?: Partial<RecoveryPolicy>;
  cancellation?: Partial<CancellationPolicy>;
  retry?: Partial<RetryPolicy>;
}

export interface QueueClaimContext {
  policy?: QueuePolicy;
}

export const DEFAULT_QUEUE_POLICY: QueuePolicy = {
  dispatch: "fifo",
  threadConcurrency: {
    maxActivePerThread: 1,
  },
  recovery: {
    mode: "mark_failed",
  },
  cancellation: {
    sigtermTimeoutMs: 0,
    sigkillAfterTimeout: false,
  },
  retry: {
    maxAttempts: 1,
    backoffMs: 0,
  },
};

export function mergeQueuePolicy(base: QueuePolicy, override?: QueuePolicyOverride): QueuePolicy {
  if (!override) {
    return {
      dispatch: base.dispatch,
      threadConcurrency: { ...base.threadConcurrency },
      recovery: { ...base.recovery },
      cancellation: { ...base.cancellation },
      retry: { ...base.retry },
    };
  }

  return {
    dispatch: override.dispatch ?? base.dispatch,
    threadConcurrency: {
      maxActivePerThread: override.threadConcurrency?.maxActivePerThread ?? base.threadConcurrency.maxActivePerThread,
    },
    recovery: {
      mode: override.recovery?.mode ?? base.recovery.mode,
    },
    cancellation: {
      sigtermTimeoutMs: override.cancellation?.sigtermTimeoutMs ?? base.cancellation.sigtermTimeoutMs,
      sigkillAfterTimeout: override.cancellation?.sigkillAfterTimeout ?? base.cancellation.sigkillAfterTimeout,
    },
    retry: {
      maxAttempts: override.retry?.maxAttempts ?? base.retry.maxAttempts,
      backoffMs: override.retry?.backoffMs ?? base.retry.backoffMs,
    },
  };
}

export interface QueueEvent {
  threadId: string;
  queueItemId: string;
  emittedAt: string;
}

export interface StartEvent extends QueueEvent {
  pid: number;
  startedAt: string;
}

export interface OutputEvent extends QueueEvent {
  pid: number | null;
  stream: OutputStream;
  chunk: string;
}

export interface ExitEvent extends QueueEvent {
  pid: number | null;
  code: number | null;
  signal: NodeJS.Signals | null;
  finalState: ThreadState;
  endedAt: string;
}

export interface ErrorEvent extends QueueEvent {
  pid: number | null;
  error: Error;
}

export interface RunCallbacks {
  onQueued?(event: QueueEvent): void;
  onStart?(event: StartEvent): void;
  onStdout?(event: OutputEvent): void;
  onStderr?(event: OutputEvent): void;
  onStateChange?(event: { threadId: string; from: ThreadState; to: ThreadState }): void;
  onExit?(event: ExitEvent): void;
  onError?(event: ErrorEvent): void;
}

export interface RunOptions {
  resumeThreadId?: string;
  workingDirectory?: string;
  callbacks?: RunCallbacks;
  metadata?: Record<string, string>;
  queuePolicy?: QueuePolicyOverride;
}

export interface RunResult {
  threadId: string;
  queueItemId: string;
}

export interface AgentRunUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
}

export interface ThreadRecord {
  threadId: string;
  queueItemId: string;
  state: ThreadState;
  pid: number | null;
  prompt: string;
  metadata: Record<string, string>;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
}

export interface QueueItem {
  id: string;
  threadId: string;
  prompt: string;
  workingDirectory: string;
  metadata: Record<string, string>;
  state: ThreadState;
}

export interface EnqueueInput {
  id: string;
  threadId: string;
  prompt: string;
  workingDirectory: string;
  metadata: Record<string, string>;
}

export interface FinishInput {
  state: "completed" | "failed" | "cancelled";
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface QueueCounts {
  queued: number;
  active: number;
}

export interface AgentQueueStore {
  enqueue(item: EnqueueInput): Promise<void>;

  /**
   * Atomically claim exactly one queued item for execution.
   *
   * Contract requirements:
   * - The returned item must no longer be claimable by other workers.
   * - Claim and state transition must happen in one transaction/atomic operation.
   * - Return `null` when no queued work is available.
   */
  claimNextQueued(context?: QueueClaimContext): Promise<QueueItem | null>;

  markState(id: string, state: ThreadState): Promise<void>;
  attachPid(id: string, pid: number): Promise<void>;
  finish(id: string, result: FinishInput): Promise<void>;
  mergeMetadata(id: string, metadata: Record<string, string>): Promise<void>;
  getQueueCounts(): Promise<QueueCounts>;
  getLatestByThreadId(threadId: string): Promise<ThreadRecord | null>;
  appendOutput(id: string, stream: OutputStream, chunk: string): Promise<void>;
}

export interface AgentRunner {
  readonly kind: AgentKind;
  init(): Promise<void>;
  run(prompt: string, options?: RunOptions): Promise<RunResult>;
  isRunning(threadId: string): Promise<boolean>;
  getThread(threadId: string): Promise<ThreadRecord | null>;
  cancel(threadId: string): Promise<boolean>;
  awaitIdle?(): Promise<void>;
  extractFinalMessage(stdout: string): string | null;
  extractUsage(stdout: string): AgentRunUsage | null;
}

export interface SpawnInput {
  threadId: string;
  queueItemId: string;
  prompt: string;
  workingDirectory: string;
  metadata: Record<string, string>;
}

export interface AgentProcess extends ChildProcess {}
