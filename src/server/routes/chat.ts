import process from "node:process";
import { accessSync, createReadStream } from "node:fs";
import { createGzip } from "node:zlib";
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from "fastify";
import { ZodError, z } from "zod";

import { buildFinalMessagePreview, buildUsageSummary, persistChatOutputs } from "../../chat/outputs";
import type { ConduitConfig, RequestControlMode } from "../../config";
import { resolveEffectiveRunnerArgs, resolveStateDbPath } from "../../config";
import { HttpError } from "../http-error";
import { createRunner, SqliteAgentQueueStore } from "../../index";
import type { AgentKind, ExitEvent, ThreadRecord } from "../../types/agent-types";
import type { RunnerRef } from "../../types/run-types";

const AgentKindSchema = z.enum(["claude", "codex", "cursor", "gemini"]);
const RunnerRefSchema = z
  .object({
    provider: AgentKindSchema,
    model: z.string().min(1).nullable().optional(),
  })
  .strict();
const ErrorResponseSchema = z.object({ error: z.string() });
const UsageSchema = z.object({
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  cachedInputTokens: z.number().nullable(),
  cacheWriteTokens: z.number().nullable(),
  totalTokens: z.number().nullable(),
  costUsd: z.number().nullable(),
});
const RunResponseSafeSchema = z.object({
  threadId: z.string().nullable(),
  queueItemId: z.string().nullable(),
  finalMessage: z.string().nullable(),
  usage: UsageSchema.nullable(),
  exit: z.object({
    code: z.number().nullable(),
    signal: z.string().nullable(),
    finalState: z.enum(["queued", "starting", "running", "completed", "failed", "cancelled"]),
    endedAt: z.string(),
  }),
});
const RunResponseDebugSchema = RunResponseSafeSchema.extend({
  stdout: z.array(z.string()),
  stderr: z.array(z.string()),
});
const StatusParamsSchema = z.object({
  threadId: z.string().min(1),
});
const OutputParamsSchema = z.object({
  threadId: z.string().min(1),
});
const StatusThreadSafeSchema = z.object({
  threadId: z.string(),
  queueItemId: z.string(),
  state: z.enum(["queued", "starting", "running", "completed", "failed", "cancelled"]),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  exitCode: z.number().nullable(),
  exitSignal: z.string().nullable(),
});
const StatusThreadDebugSchema = StatusThreadSafeSchema.extend({
  prompt: z.string(),
  metadata: z.record(z.string(), z.string()),
});
const CancelResponseSchema = z.object({
  threadId: z.string(),
  cancelled: z.boolean(),
});
const InitResponseSchema = z.object({ ok: z.boolean() });

interface ResolvedRunRequest {
  projectId: string;
  prompt: string;
  runner: RunnerRef;
  resume: string | undefined;
  externalRef: string | undefined;
  workingDirectory: string;
  db: string;
  args: string[];
}

interface ResolvedControlRequest {
  runner: RunnerRef;
  db: string;
  args: string[];
}

interface ExitSummary {
  code: number | null;
  signal: NodeJS.Signals | null;
  finalState: ExitEvent["finalState"];
  endedAt: string;
}

interface RequestBucket {
  windowStartMs: number;
  count: number;
}

type SseEventName = "queued" | "start" | "stdout" | "stderr" | "exit" | "error";

type StatusThreadDebug = z.infer<typeof StatusThreadDebugSchema>;
type StatusThreadSafe = z.infer<typeof StatusThreadSafeSchema>;

function resolveControlledString(
  requested: string | undefined,
  field: "db",
  mode: RequestControlMode,
  fallback: string,
): string {
  if (requested === undefined) return fallback;
  if (mode !== "read_write") {
    throw new HttpError(403, `Request override for "${field}" is not allowed`);
  }
  return requested;
}

function resolveControlledArgs(
  requested: string[] | undefined,
  mode: RequestControlMode,
  fallback: string[],
): string[] {
  if (requested === undefined) return fallback;
  if (mode !== "read_write") {
    throw new HttpError(403, 'Request override for "args" is not allowed');
  }
  return requested;
}

function readOptionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (typeof value === "string") return value;
  return undefined;
}

function readOptionalArgs(input: Record<string, unknown>, key: string): string[] | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value;
  }
  return undefined;
}

function normalizeRunnerRef(input: z.infer<typeof RunnerRefSchema> | undefined): RunnerRef | undefined {
  if (!input) return undefined;
  return {
    provider: input.provider,
    model: input.model ?? null,
  };
}

function redactTopLevelPid(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (!("pid" in record)) return value;
  const { pid: _pid, ...rest } = record;
  return rest;
}

function redactStatusThread(thread: ThreadRecord | null, debug: boolean): StatusThreadDebug | StatusThreadSafe | null {
  if (!thread) return null;
  const { pid: _pid, threadId, ...withoutPid } = thread;
  if (debug) {
    return { threadId, ...withoutPid };
  }
  const { prompt: _prompt, metadata: _metadata, ...safe } = withoutPid;
  return { threadId, ...safe };
}

function redactSsePayload(event: SseEventName, payload: unknown, debug: boolean): unknown | null {
  if (!debug && (event === "stdout" || event === "stderr")) {
    return null;
  }
  if (!debug && event === "error") {
    return { error: "Internal server error" };
  }
  return redactTopLevelPid(payload);
}

function redactErrorMessage(statusCode: number, rawMessage: string, debug: boolean): string {
  if (!debug && statusCode >= 500) {
    return "Internal server error";
  }
  return rawMessage;
}

function logRunnerOutputChunk(
  debug: boolean,
  logger: FastifyBaseLogger,
  stream: "stdout" | "stderr",
  chunk: string,
): void {
  if (!debug || chunk.length === 0) return;
  if (stream === "stderr") {
    logger.warn({ stream, chunk }, "Runner output");
    return;
  }
  logger.debug({ stream, chunk }, "Runner output");
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sendTextOutput(request: FastifyRequest, reply: import("fastify").FastifyReply, path: string) {
  const acceptsGzip = request.headers["accept-encoding"]?.includes("gzip") ?? false;
  reply.type("text/plain; charset=utf-8");
  if (acceptsGzip) {
    reply.header("Content-Encoding", "gzip");
    reply.header("Vary", "Accept-Encoding");
    return reply.send(createReadStream(path).pipe(createGzip()));
  }
  return reply.send(createReadStream(path));
}

export function registerChatRoutes(app: FastifyInstance, config: ConduitConfig): void {
  const debug = config.server.debug;
  const RunResponseSchema = debug ? RunResponseDebugSchema : RunResponseSafeSchema;
  const StatusThreadSchema = debug ? StatusThreadDebugSchema : StatusThreadSafeSchema;
  const StatusResponseSchema = z.object({
    threadId: z.string(),
    running: z.boolean(),
    thread: StatusThreadSchema.nullable(),
  });
  const allowDbOverride = config.server.requestControls.db === "read_write";
  const allowArgsOverride = config.server.requestControls.args === "read_write";

  const RunBodySchema = z
    .object({
      project_id: z.string().min(1),
      prompt: z.string().min(1),
      runner: RunnerRefSchema.optional(),
      resume: z.string().min(1).optional(),
      external_ref: z.string().min(1).optional(),
      ...(allowDbOverride ? { db: z.string().min(1).optional() } : {}),
      ...(allowArgsOverride ? { args: z.array(z.string()).optional() } : {}),
    })
    .strict();

  const ControlBodySchema = z
    .object({
      runner: RunnerRefSchema.optional(),
      ...(allowDbOverride ? { db: z.string().min(1).optional() } : {}),
      ...(allowArgsOverride ? { args: z.array(z.string()).optional() } : {}),
    })
    .strict();

  const runnerCache = new Map<string, { runner: ReturnType<typeof createRunner>; store: SqliteAgentQueueStore }>();
  const statusStore = new SqliteAgentQueueStore(resolveStateDbPath(config));
  const requestBuckets = new Map<string, RequestBucket>();

  app.addHook("onClose", async () => {
    for (const instance of runnerCache.values()) {
      instance.store.close();
    }
    runnerCache.clear();
    statusStore.close();
  });

  function getRunnerInstance(request: ResolvedControlRequest) {
    const key = JSON.stringify([request.runner, request.db, request.args]);
    const existing = runnerCache.get(key);
    if (existing) return existing;

    const store = new SqliteAgentQueueStore(request.db);
    const runner = createRunner(request.runner.provider as AgentKind, store, request.args);
    const instance = { runner, store };
    runnerCache.set(key, instance);
    return instance;
  }

  function getThrottleKey(request: FastifyRequest): string {
    if (config.server.throttling.key === "global") return "__global__";
    return request.ip;
  }

  function enforceRunThrottle(request: FastifyRequest): void {
    if (!config.server.throttling.enabled) return;
    const now = Date.now();
    const { windowMs, maxRequests } = config.server.throttling;
    const key = getThrottleKey(request);
    const existing = requestBuckets.get(key);

    if (!existing || now - existing.windowStartMs >= windowMs) {
      requestBuckets.set(key, { windowStartMs: now, count: 1 });
    } else {
      existing.count += 1;
      requestBuckets.set(key, existing);
      if (existing.count > maxRequests) {
        throw new HttpError(429, "Rate limit exceeded");
      }
    }

    if (requestBuckets.size > 1024) {
      for (const [bucketKey, bucket] of requestBuckets.entries()) {
        if (now - bucket.windowStartMs >= windowMs) {
          requestBuckets.delete(bucketKey);
        }
      }
    }
  }

  async function enforceQueueLimits(store: SqliteAgentQueueStore): Promise<void> {
    const { maxActiveRuns, maxQueuedRuns } = config.server.queue;
    if (maxActiveRuns === null && maxQueuedRuns === null) {
      return;
    }

    const counts = await store.getQueueCounts();
    if (maxQueuedRuns !== null && counts.queued >= maxQueuedRuns) {
      throw new HttpError(429, "Queue capacity exceeded");
    }
    if (maxActiveRuns !== null && counts.active >= maxActiveRuns) {
      throw new HttpError(429, "Active run capacity exceeded");
    }
  }

  function resolveControlRequest(
    input: {
      runner?: RunnerRef;
      db?: string;
      args?: string[];
    },
    defaults: {
      runner: RunnerRef;
      db: string;
    },
  ): ResolvedControlRequest {
    const runner = input.runner ?? defaults.runner;
    const provider = runner.provider as AgentKind;
    const baseArgs = resolveEffectiveRunnerArgs(config, provider, []);
    return {
      runner: {
        provider,
        model: runner.model ?? null,
      },
      db: resolveControlledString(input.db, "db", config.server.requestControls.db, defaults.db),
      args: resolveControlledArgs(input.args, config.server.requestControls.args, baseArgs),
    };
  }

  function resolveRunRequest(input: z.infer<typeof RunBodySchema>): ResolvedRunRequest {
    const inputRecord = input as Record<string, unknown>;
    const project = config.projects[input.project_id];
    if (!project) {
      throw new HttpError(404, `Unknown project_id "${input.project_id}"`);
    }
    const prompt = input.prompt.trim();
    if (!prompt) {
      throw new HttpError(400, "Prompt cannot be empty");
    }

    const resolved = resolveControlRequest(
      {
        runner: normalizeRunnerRef(input.runner),
        db: readOptionalString(inputRecord, "db"),
        args: readOptionalArgs(inputRecord, "args"),
      },
      {
        runner: {
          provider: config.defaultRunner,
          model: null,
        },
        db: resolveStateDbPath(config),
      },
    );

    return {
      projectId: input.project_id,
      prompt,
      runner: resolved.runner,
      resume: input.resume,
      externalRef: input.external_ref,
      workingDirectory: project.path,
      db: resolved.db,
      args: resolved.args,
    };
  }

  app.post(
    "/chat",
    {
      schema: {
        tags: ["chat"],
        description: "Execute a prompt. Returns JSON by default; streams SSE if Accept includes text/event-stream.",
        body: RunBodySchema,
        response: {
          200: RunResponseSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          429: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      enforceRunThrottle(request);
      const runInput = resolveRunRequest(request.body as z.infer<typeof RunBodySchema>);
      const runnerInstance = getRunnerInstance({
        runner: runInput.runner,
        db: runInput.db,
        args: runInput.args,
      });
      await enforceQueueLimits(runnerInstance.store);
      const runner = runnerInstance.runner;

      const wantsSse = String(request.headers.accept ?? "").includes("text/event-stream");
      if (wantsSse) {
        reply.hijack();
        reply.raw.statusCode = 200;
        reply.raw.setHeader("content-type", "text/event-stream; charset=utf-8");
        reply.raw.setHeader("cache-control", "no-cache");
        reply.raw.setHeader("connection", "keep-alive");
        reply.raw.write(": connected\n\n");
      }

      const stdout: string[] = [];
      const stderr: string[] = [];
      let lastQueueItemId: string | null = null;
      let threadId: string | null = null;
      let settled = false;
      const runLogger = request.log.child({
        route: "/chat",
        runner: runInput.runner,
      });

      const sendSse = (event: SseEventName, payload: unknown) => {
        if (!wantsSse) return;
        const redactedPayload = redactSsePayload(event, payload, debug);
        if (redactedPayload === null) {
          return;
        }
        reply.raw.write(`event: ${event}\n`);
        reply.raw.write(`data: ${JSON.stringify(redactedPayload)}\n\n`);
      };

      const waitForTerminal = new Promise<ExitSummary>((resolve) => {
        const settle = (summary: ExitSummary) => {
          if (settled) return;
          settled = true;
          resolve(summary);
        };

        const runInvocation = runner.run(runInput.prompt, {
          workingDirectory: runInput.workingDirectory,
          resumeThreadId: runInput.resume,
          metadata: {
            projectId: runInput.projectId,
            ...(runInput.resume
              ? {
                  sessionId: runInput.resume,
                }
              : {}),
            ...(runInput.externalRef
              ? {
                  externalRef: runInput.externalRef,
                }
              : {}),
            ...(runInput.runner.model
              ? {
                  requestedModel: runInput.runner.model,
                }
              : {}),
          },
          callbacks: {
            onQueued: (event) => {
              lastQueueItemId = event.queueItemId;
              sendSse("queued", event);
            },
            onStart: (event) => {
              sendSse("start", event);
            },
            onStdout: (event) => {
              stdout.push(event.chunk);
              logRunnerOutputChunk(debug, runLogger, "stdout", event.chunk);
              sendSse("stdout", event);
            },
            onStderr: (event) => {
              stderr.push(event.chunk);
              logRunnerOutputChunk(debug, runLogger, "stderr", event.chunk);
              sendSse("stderr", event);
            },
            onExit: (event) => {
              sendSse("exit", event);
              settle({
                code: event.code,
                signal: event.signal,
                finalState: event.finalState,
                endedAt: event.endedAt,
              });
            },
            onError: (event) => {
              const endedAt = new Date().toISOString();
              stderr.push(event.error.message);
              logRunnerOutputChunk(debug, runLogger, "stderr", event.error.message);
              sendSse("error", {
                ...event,
                error: event.error.message,
              });
              settle({
                code: null,
                signal: null,
                finalState: "failed",
                endedAt,
              });
            },
          },
        });

        void runInvocation
          .then((result) => {
            threadId = result.threadId;
            if (!lastQueueItemId) {
              lastQueueItemId = result.queueItemId;
            }
          })
          .catch((error) => {
            const endedAt = new Date().toISOString();
            const message = error instanceof Error ? error.message : String(error);
            if (debug) {
              stderr.push(message);
            }
            logRunnerOutputChunk(debug, runLogger, "stderr", message);
            sendSse("error", { error: message, emittedAt: endedAt });
            settle({
              code: null,
              signal: null,
              finalState: "failed",
              endedAt,
            });
          });
      });

      const exit = await waitForTerminal;
      const stdoutText = stdout.join("\n");
      const stderrText = stderr.join("\n");
      const finalMessage = runner.extractFinalMessage(stdoutText);
      const usage = runner.extractUsage(stdoutText);

      if (threadId && lastQueueItemId) {
        const outputs = await persistChatOutputs({
          stateDir: config.stateDir,
          threadId,
          queueItemId: lastQueueItemId,
          prompt: runInput.prompt,
          stdout: stdoutText,
          stderr: stderrText,
          finalMessage,
          usage,
          exit,
        });
        await runnerInstance.store.mergeMetadata(lastQueueItemId, {
          finalOutputPath: outputs.finalOutputPath ?? "",
          finalMessagePreview: buildFinalMessagePreview(finalMessage) ?? "",
          resultOutputPath: outputs.resultOutputPath,
          outputDir: outputs.outputDir,
          usageSummary: buildUsageSummary(usage) ?? "",
        });
      }

      if (wantsSse) {
        reply.raw.end();
        return;
      }

      const response = {
        threadId,
        queueItemId: lastQueueItemId,
        finalMessage,
        usage,
        exit,
      };
      if (debug) {
        return {
          ...response,
          stdout,
          stderr,
        };
      }
      return response;
    },
  );

  app.get(
    "/chat/threads/:threadId",
    {
      schema: {
        tags: ["chat"],
        params: StatusParamsSchema,
        response: {
          200: StatusResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request) => {
      const params = request.params as z.infer<typeof StatusParamsSchema>;
      const thread = await statusStore.getLatestByThreadId(params.threadId);
      const running =
        thread !== null &&
        (thread.pid !== null
          ? isPidAlive(thread.pid)
          : thread.state === "queued" || thread.state === "starting" || thread.state === "running");
      const redacted = redactStatusThread(thread, debug);
      return {
        threadId: params.threadId,
        running,
        thread: redacted,
      };
    },
  );

  app.get(
    "/chat/threads/:threadId/output/final",
    {
      schema: {
        tags: ["chat"],
        params: OutputParamsSchema,
        response: {
          404: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const params = request.params as z.infer<typeof OutputParamsSchema>;
      const thread = await statusStore.getLatestByThreadId(params.threadId);
      if (!thread) {
        throw new HttpError(404, `Thread "${params.threadId}" not found`);
      }

      const path = thread.metadata.finalOutputPath;
      if (!path) {
        throw new HttpError(404, `Final output not found for thread "${params.threadId}"`);
      }

      try {
        accessSync(path);
      } catch {
        throw new HttpError(404, `Final output not found for thread "${params.threadId}"`);
      }

      return sendTextOutput(request, reply, path);
    },
  );

  app.post(
    "/chat/threads/:threadId/cancel",
    {
      schema: {
        tags: ["chat"],
        params: StatusParamsSchema,
        body: ControlBodySchema,
        response: {
          200: CancelResponseSchema,
          403: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request) => {
      const params = request.params as z.infer<typeof StatusParamsSchema>;
      const body = request.body as z.infer<typeof ControlBodySchema>;
      const bodyRecord = body as Record<string, unknown>;
      const resolved = resolveControlRequest(
        {
          runner: normalizeRunnerRef(body.runner),
          db: readOptionalString(bodyRecord, "db"),
          args: readOptionalArgs(bodyRecord, "args"),
        },
        {
          runner: {
            provider: config.defaultRunner,
            model: null,
          },
          db: resolveStateDbPath(config),
        },
      );
      const runnerInstance = getRunnerInstance(resolved);
      const cancelled = await runnerInstance.runner.cancel(params.threadId);
      return { threadId: params.threadId, cancelled };
    },
  );

  if (config.server.allowInit) {
    app.post(
      "/chat/init",
      {
        schema: {
          tags: ["chat"],
          body: ControlBodySchema,
          response: {
            200: InitResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request) => {
        const body = request.body as z.infer<typeof ControlBodySchema>;
        const bodyRecord = body as Record<string, unknown>;
        const resolved = resolveControlRequest(
          {
            runner: normalizeRunnerRef(body.runner),
            db: readOptionalString(bodyRecord, "db"),
            args: readOptionalArgs(bodyRecord, "args"),
          },
          {
            runner: {
              provider: config.defaultRunner,
              model: null,
            },
            db: resolveStateDbPath(config),
          },
        );
        const runnerInstance = getRunnerInstance(resolved);
        await runnerInstance.runner.init();
        return { ok: true };
      },
    );
  }
}

export { ErrorResponseSchema, ZodError, redactErrorMessage };
