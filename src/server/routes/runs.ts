import { accessSync, createReadStream } from "node:fs";
import { join } from "node:path";
import { createGzip } from "node:zlib";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { HttpError } from "../http-error";
import { ConduitRunManager, RunQueueCapacityError, type AttemptOutputTarget } from "../../runs/manager";

const ErrorResponseSchema = z.object({ error: z.string() });
const RunnerRefSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1).nullable().optional(),
});
const RunStatusSchema = z.enum(["queued", "running", "succeeded", "failed", "timed_out", "canceled"]);
const AttemptStatusSchema = z.enum(["running", "succeeded", "failed", "timed_out", "canceled"]);
const RunBodyV1Schema = z
  .object({
    project_id: z.string().min(1),
    policy_id: z.string().min(1),
    input: z.record(z.string(), z.unknown()),
    requested_runner: RunnerRefSchema.optional(),
    timeout_seconds: z.number().int().positive().optional(),
    external_ref: z.string().min(1).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
const RunParamsSchema = z.object({
  runId: z.string().min(1),
});
const CheckOutputParamsSchema = z.object({
  runId: z.string().min(1),
  attemptIndex: z.coerce.number().int().positive(),
  checkName: z.string().min(1),
});
const CheckOutputQuerySchema = z.object({
  stream: z.enum(["stdout", "stderr"]),
});
const AttemptOutputParamsSchema = z.object({
  runId: z.string().min(1),
  attemptIndex: z.coerce.number().int().positive(),
});
const AttemptOutputQuerySchema = z.object({
  stream: z.enum(["stdout", "stderr"]),
});
const RunQuerySchema = z.object({
  include: z.union([z.literal("attempts"), z.array(z.literal("attempts"))]).optional(),
});
const RunSchema = z.object({
  run_id: z.string(),
  project_id: z.string(),
  policy_id: z.string(),
  task_id: z.string(),
  status: RunStatusSchema,
  input: z.record(z.string(), z.unknown()),
  resolved_project: z.object({
    project_id: z.string(),
    path: z.string(),
    baseline_ref: z.string().nullable(),
  }),
  runner: z.object({
    provider: z.string(),
    model: z.string().nullable(),
  }),
  requested_runner: z
    .object({
      provider: z.string(),
      model: z.string().nullable(),
    })
    .nullable(),
  external_ref: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  created_at: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  max_attempts: z.number().int().positive(),
  current_attempt_index: z.number().int().min(0),
  cancel_requested_at: z.string().nullable(),
  failure_summary: z.string().nullable(),
  run_record_path: z.string(),
});
const AttemptSchema = z.object({
  attempt_id: z.string(),
  run_id: z.string(),
  attempt_index: z.number().int().positive(),
  status: AttemptStatusSchema,
  runner: z.object({
    provider: z.string(),
    model: z.string().nullable(),
  }),
  started_at: z.string(),
  finished_at: z.string().nullable(),
  duration_ms: z.number().int().nullable(),
  workspace_path: z.string(),
  output_dir: z.string(),
  failure_summary: z.string().nullable(),
  agent_final_url: z.string().nullable(),
  agent_stdout_url: z.string().nullable(),
  agent_stderr_url: z.string().nullable(),
  check_results: z.array(
    z.object({
      id: z.number().int(),
      run_id: z.string(),
      attempt_id: z.string(),
      attempt_index: z.number().int().positive(),
      check_order: z.number().int().positive(),
      name: z.string(),
      command: z.string(),
      on_fail: z.enum(["retry", "fail", "ignore"]),
      exit_code: z.number().int().nullable(),
      passed: z.boolean(),
      started_at: z.string(),
      finished_at: z.string(),
      duration_ms: z.number().int().nullable(),
      stdout_path: z.string().nullable(),
      stderr_path: z.string().nullable(),
      stdout_url: z.string().nullable(),
      stderr_url: z.string().nullable(),
      output_ref: z.string().nullable(),
      failure_effective: z.boolean(),
    }),
  ),
});
const RunWithAttemptsSchema = RunSchema.extend({
  attempts: z.array(AttemptSchema),
});
const RunCreateResponseSchema = z.object({
  run_id: z.string(),
  status: RunStatusSchema,
  project_id: z.string(),
  policy_id: z.string(),
});
const RunCancelResponseSchema = z.object({
  run_id: z.string(),
  canceled: z.boolean(),
});
function buildCheckOutputUrl(runId: string, attemptIndex: number, checkName: string, stream: "stdout" | "stderr"): string {
  return `/runs/${encodeURIComponent(runId)}/attempts/${attemptIndex}/output/checks/${encodeURIComponent(checkName)}?stream=${stream}`;
}

function buildAttemptOutputUrl(runId: string, attemptIndex: number, stream: "stdout" | "stderr"): string {
  return `/runs/${encodeURIComponent(runId)}/attempts/${attemptIndex}/output/agent?stream=${stream}`;
}

function buildAttemptFinalOutputUrl(runId: string, attemptIndex: number): string {
  return `/runs/${encodeURIComponent(runId)}/attempts/${attemptIndex}/output/agent/final`;
}

function sendTextOutput(
  request: FastifyRequest,
  reply: FastifyReply,
  path: string,
) {
  const acceptsGzip = request.headers["accept-encoding"]?.includes("gzip") ?? false;
  reply.type("text/plain; charset=utf-8");
  if (acceptsGzip) {
    reply.header("Content-Encoding", "gzip");
    reply.header("Vary", "Accept-Encoding");
    return reply.send(createReadStream(path).pipe(createGzip()));
  }
  return reply.send(createReadStream(path));
}

async function sendAttemptOutput(
  request: FastifyRequest,
  reply: FastifyReply,
  runManager: ConduitRunManager,
  params: z.infer<typeof AttemptOutputParamsSchema> | z.infer<typeof CheckOutputParamsSchema>,
  target: AttemptOutputTarget,
) {
  const run = runManager.getRun(params.runId);
  if (!run) {
    throw new HttpError(404, `Run "${params.runId}" not found`);
  }

  const output = await runManager.getAttemptOutputArtifact(params.runId, params.attemptIndex, target);
  if (!output) {
    if (target.kind === "agent") {
      throw new HttpError(
        404,
        `Attempt output not found for run "${params.runId}", attempt ${params.attemptIndex}, stream "${target.stream}"`,
      );
    }
    throw new HttpError(
      404,
      `Check output not found for run "${params.runId}", attempt ${params.attemptIndex}, check "${target.checkName}", stream "${target.stream}"`,
    );
  }

  try {
    accessSync(output.path);
  } catch {
    if (target.kind === "agent") {
      throw new HttpError(
        404,
        `Attempt output not found for run "${params.runId}", attempt ${params.attemptIndex}, stream "${target.stream}"`,
      );
    }
    throw new HttpError(
      404,
      `Check output not found for run "${params.runId}", attempt ${params.attemptIndex}, check "${target.checkName}", stream "${target.stream}"`,
    );
  }

  return sendTextOutput(request, reply, output.path);
}

export function registerRunRoutes(app: FastifyInstance, runManager: ConduitRunManager): void {
  app.post(
    "/runs",
    {
      schema: {
        tags: ["runs"],
        description: "Create and start a deterministic run from {project_id, policy_id, input}.",
        body: RunBodyV1Schema,
        response: {
          200: RunCreateResponseSchema,
          400: ErrorResponseSchema,
          429: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request) => {
      const body = request.body as z.infer<typeof RunBodyV1Schema>;
      let run;
      try {
        run = await runManager.createRun({
          ...body,
          requested_runner: body.requested_runner
            ? {
                provider: body.requested_runner.provider,
                model: body.requested_runner.model ?? null,
              }
            : undefined,
        });
      } catch (error) {
        if (error instanceof RunQueueCapacityError) {
          throw new HttpError(429, error.message);
        }
        throw error;
      }
      return {
        run_id: run.run_id,
        status: run.status,
        project_id: run.project_id,
        policy_id: run.policy_id,
      };
    },
  );

  app.get(
    "/runs/:runId",
    {
      schema: {
        tags: ["runs"],
        params: RunParamsSchema,
        querystring: RunQuerySchema,
        response: {
          200: z.union([RunWithAttemptsSchema, RunSchema]),
          404: ErrorResponseSchema,
        },
      },
    },
    async (request) => {
      const params = request.params as z.infer<typeof RunParamsSchema>;
      const query = request.query as z.infer<typeof RunQuerySchema>;
      const run = runManager.getRun(params.runId);
      if (!run) {
        throw new HttpError(404, `Run "${params.runId}" not found`);
      }
      const includes = query.include === undefined ? [] : Array.isArray(query.include) ? query.include : [query.include];
      if (includes.includes("attempts")) {
        return {
          ...run,
          attempts: runManager.getAttempts(params.runId).map((attempt) => ({
            ...attempt,
            agent_final_url: buildAttemptFinalOutputUrl(params.runId, attempt.attempt_index),
            agent_stdout_url: buildAttemptOutputUrl(params.runId, attempt.attempt_index, "stdout"),
            agent_stderr_url: buildAttemptOutputUrl(params.runId, attempt.attempt_index, "stderr"),
            check_results: attempt.check_results.map((check) => ({
              ...check,
              stdout_url:
                check.stdout_path === null
                  ? null
                  : buildCheckOutputUrl(params.runId, attempt.attempt_index, check.name, "stdout"),
              stderr_url:
                check.stderr_path === null
                  ? null
                  : buildCheckOutputUrl(params.runId, attempt.attempt_index, check.name, "stderr"),
            })),
          })),
        };
      }
      return run;
    },
  );

  app.get(
    "/runs/:runId/attempts/:attemptIndex/output/agent/final",
    {
      schema: {
        tags: ["runs"],
        params: AttemptOutputParamsSchema,
        response: {
          404: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const params = request.params as z.infer<typeof AttemptOutputParamsSchema>;
      const run = runManager.getRun(params.runId);
      if (!run) {
        throw new HttpError(404, `Run "${params.runId}" not found`);
      }

      const attempt = runManager.getAttempts(params.runId).find((item) => item.attempt_index === params.attemptIndex);
      if (!attempt) {
        throw new HttpError(404, `Attempt ${params.attemptIndex} not found for run "${params.runId}"`);
      }

      const path = join(attempt.output_dir, "agent.final.txt");
      try {
        accessSync(path);
      } catch {
        throw new HttpError(404, `Final output not found for run "${params.runId}", attempt ${params.attemptIndex}`);
      }

      return sendTextOutput(request, reply, path);
    },
  );

  app.get(
    "/runs/:runId/attempts/:attemptIndex/output/agent",
    {
      schema: {
        tags: ["runs"],
        params: AttemptOutputParamsSchema,
        querystring: AttemptOutputQuerySchema,
        response: {
          404: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const params = request.params as z.infer<typeof AttemptOutputParamsSchema>;
      const query = request.query as z.infer<typeof AttemptOutputQuerySchema>;
      return sendAttemptOutput(request, reply, runManager, params, {
        kind: "agent",
        stream: query.stream,
      });
    },
  );

  app.get(
    "/runs/:runId/attempts/:attemptIndex/output/checks/:checkName",
    {
      schema: {
        tags: ["runs"],
        params: CheckOutputParamsSchema,
        querystring: CheckOutputQuerySchema,
        response: {
          404: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const params = request.params as z.infer<typeof CheckOutputParamsSchema>;
      const query = request.query as z.infer<typeof CheckOutputQuerySchema>;
      return sendAttemptOutput(request, reply, runManager, params, {
        kind: "check",
        checkName: params.checkName,
        stream: query.stream,
      });
    },
  );

  app.post(
    "/runs/:runId/cancel",
    {
      schema: {
        tags: ["runs"],
        params: RunParamsSchema,
        response: {
          200: RunCancelResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (request) => {
      const params = request.params as z.infer<typeof RunParamsSchema>;
      const run = runManager.getRun(params.runId);
      if (!run) {
        throw new HttpError(404, `Run "${params.runId}" not found`);
      }
      return {
        run_id: params.runId,
        canceled: await runManager.cancelRun(params.runId),
      };
    },
  );
}
