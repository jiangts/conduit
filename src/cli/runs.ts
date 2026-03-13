import { readFile } from "node:fs/promises";
import type { Argv } from "yargs";

import type { ConduitConfig } from "../config";
import { resolveStateDbPath } from "../config";
import { ConduitRunManager } from "../runs/manager";
import type { RunStatus } from "../types/run-types";
import { createHttpClient } from "./http";
import { parseRunnerRef } from "./runner-ref";

interface OutputWriter {
  write(chunk: string): unknown;
}

interface RunCreateResponse {
  run_id: string;
  status: RunStatus;
  project_id: string;
  policy_id: string;
}

interface RunRecord {
  run_id: string;
  project_id: string;
  policy_id: string;
  task_id: string;
  status: RunStatus;
  input: Record<string, unknown>;
  resolved_project: {
    project_id: string;
    path: string;
    baseline_ref: string | null;
  };
  runner: {
    provider: string;
    model: string | null;
  };
  requested_runner: {
    provider: string;
    model: string | null;
  } | null;
  external_ref: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  max_attempts: number;
  current_attempt_index: number;
  cancel_requested_at: string | null;
  failure_summary: string | null;
  run_record_path: string;
}

interface RunCheckResult {
  id: number;
  run_id: string;
  attempt_id: string;
  attempt_index: number;
  check_order: number;
  name: string;
  command: string;
  on_fail: "retry" | "fail" | "ignore";
  exit_code: number | null;
  passed: boolean;
  started_at: string;
  finished_at: string;
  duration_ms: number | null;
  stdout_path: string | null;
  stderr_path: string | null;
  stdout_url?: string | null;
  stderr_url?: string | null;
  output_ref: string | null;
  failure_effective: boolean;
}

interface RunAttempt {
  attempt_id: string;
  run_id: string;
  attempt_index: number;
  status: "running" | "succeeded" | "failed" | "timed_out" | "canceled";
  runner: {
    provider: string;
    model: string | null;
  };
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  workspace_path: string;
  output_dir: string;
  failure_summary: string | null;
  check_results: RunCheckResult[];
}

type RunWithAttempts = RunRecord & { attempts: RunAttempt[] };

function writeJson(writer: OutputWriter, value: unknown): void {
  writer.write(`${JSON.stringify(value, null, 2)}\n`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function parseJsonObjectInput(value: string, label: string): Promise<Record<string, unknown>> {
  const raw = value.startsWith("@") ? await readFile(value.slice(1), "utf8") : value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${label} JSON: ${message}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed;
}

function isTerminalStatus(status: RunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "timed_out" || status === "canceled";
}

function exitCodeForStatus(status: RunStatus): number {
  return status === "succeeded" ? 0 : 1;
}

function printRunSummary(writer: OutputWriter, run: RunRecord): void {
  writer.write(`run_id: ${run.run_id}\n`);
  writer.write(`status: ${run.status}\n`);
  writer.write(`project_id: ${run.project_id}\n`);
  writer.write(`policy_id: ${run.policy_id}\n`);
  writer.write(`task_id: ${run.task_id}\n`);
  writer.write(`runner: ${run.runner.provider}${run.runner.model ? ` (${run.runner.model})` : ""}\n`);
  writer.write(`created_at: ${run.created_at}\n`);
  writer.write(`started_at: ${run.started_at ?? "null"}\n`);
  writer.write(`finished_at: ${run.finished_at ?? "null"}\n`);
  writer.write(`current_attempt_index: ${run.current_attempt_index}/${run.max_attempts}\n`);
  writer.write(`run_record_path: ${run.run_record_path}\n`);
  if (run.failure_summary) {
    writer.write(`failure_summary: ${run.failure_summary}\n`);
  }
}

function printAttempts(writer: OutputWriter, attempts: RunAttempt[]): void {
  if (attempts.length === 0) {
    writer.write("attempts: (none)\n");
    return;
  }
  writer.write("attempts:\n");
  for (const attempt of attempts) {
    writer.write(
      `- attempt ${attempt.attempt_index}: ${attempt.status}, runner=${attempt.runner.provider}, output_dir=${attempt.output_dir}\n`,
    );
    if (attempt.failure_summary) {
      writer.write(`  failure_summary: ${attempt.failure_summary}\n`);
    }
    for (const check of attempt.check_results) {
      writer.write(
        `  check ${check.name}: ${check.passed ? "passed" : "failed"} [on_fail=${check.on_fail}, exit_code=${check.exit_code ?? "null"}]\n`,
      );
    }
  }
}

async function getRun(
  client: ReturnType<typeof createHttpClient>,
  runId: string,
  includeAttempts: boolean,
): Promise<RunRecord | RunWithAttempts> {
  const suffix = includeAttempts ? "?include=attempts" : "";
  return client.request<RunRecord | RunWithAttempts>(`/runs/${encodeURIComponent(runId)}${suffix}`);
}

function getLocalRun(
  manager: ConduitRunManager,
  runId: string,
  includeAttempts: boolean,
): RunRecord | RunWithAttempts {
  const run = manager.getRun(runId);
  if (!run) {
    throw new Error(`Run "${runId}" not found`);
  }
  if (!includeAttempts) {
    return run;
  }
  return {
    ...run,
    attempts: manager.getAttempts(runId),
  };
}

async function waitForTerminalRun(
  client: ReturnType<typeof createHttpClient>,
  runId: string,
  options: {
    intervalMs: number;
    includeAttempts: boolean;
    stdout: OutputWriter;
    emitProgress: boolean;
    sleep: (ms: number) => Promise<void>;
  },
): Promise<RunRecord | RunWithAttempts> {
  let previousStatus: RunStatus | null = null;
  let knownAttempts = 0;
  const printedChecks = new Set<string>();

  while (true) {
    const run = await getRun(client, runId, options.includeAttempts);

    if (options.emitProgress && run.status !== previousStatus) {
      options.stdout.write(`status: ${run.status}\n`);
      previousStatus = run.status;
    }

    if (options.emitProgress && options.includeAttempts && "attempts" in run) {
      for (const attempt of run.attempts) {
        if (attempt.attempt_index > knownAttempts) {
          options.stdout.write(`attempt ${attempt.attempt_index}: ${attempt.status}\n`);
          knownAttempts = attempt.attempt_index;
        }
        for (const check of attempt.check_results) {
          const key = `${attempt.attempt_index}:${check.name}:${check.finished_at}`;
          if (!printedChecks.has(key)) {
            printedChecks.add(key);
            options.stdout.write(`check ${attempt.attempt_index}/${check.name}: ${check.passed ? "passed" : "failed"}\n`);
          }
        }
      }
    }

    if (isTerminalStatus(run.status)) {
      return run;
    }

    await options.sleep(options.intervalMs);
  }
}

async function waitForTerminalLocalRun(
  manager: ConduitRunManager,
  runId: string,
  options: {
    intervalMs: number;
    includeAttempts: boolean;
    stdout: OutputWriter;
    emitProgress: boolean;
    sleep: (ms: number) => Promise<void>;
  },
): Promise<RunRecord | RunWithAttempts> {
  let previousStatus: RunStatus | null = null;
  let knownAttempts = 0;
  const printedChecks = new Set<string>();

  while (true) {
    const run = getLocalRun(manager, runId, options.includeAttempts);

    if (options.emitProgress && run.status !== previousStatus) {
      options.stdout.write(`status: ${run.status}\n`);
      previousStatus = run.status;
    }

    if (options.emitProgress && options.includeAttempts && "attempts" in run) {
      for (const attempt of run.attempts) {
        if (attempt.attempt_index > knownAttempts) {
          options.stdout.write(`attempt ${attempt.attempt_index}: ${attempt.status}\n`);
          knownAttempts = attempt.attempt_index;
        }
        for (const check of attempt.check_results) {
          const key = `${attempt.attempt_index}:${check.name}:${check.finished_at}`;
          if (!printedChecks.has(key)) {
            printedChecks.add(key);
            options.stdout.write(`check ${attempt.attempt_index}/${check.name}: ${check.passed ? "passed" : "failed"}\n`);
          }
        }
      }
    }

    if (isTerminalStatus(run.status)) {
      return run;
    }

    await options.sleep(options.intervalMs);
  }
}

function withRuntimeErrorHint(error: unknown, baseUrl: string): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("fetch failed") || message.includes("ECONNREFUSED")) {
    throw new Error(
      `No local Conduit runtime detected at ${baseUrl}. Start it with "conduit runtime start", or use "conduit runs create --wait" for one-shot local execution.`,
    );
  }
  throw error;
}

export function registerRunCommands(
  yargs: Argv,
  context: {
    stdout: OutputWriter;
    fetchFn: typeof fetch;
    sleep: (ms: number) => Promise<void>;
    setExitCode: (code: number) => void;
    config: ConduitConfig;
  },
): void {
  yargs.command(
    "runs <command>",
    "Create and inspect deterministic runs",
    (runsYargs) => {
      runsYargs.command(
        "create",
        "Create a run",
        (cmd) =>
          cmd
            .option("project", {
              type: "string",
              demandOption: true,
              describe: "Configured project id",
            })
            .option("policy", {
              type: "string",
              demandOption: true,
              describe: "Policy id",
            })
            .option("input", {
              type: "string",
              demandOption: true,
              describe: "Inline JSON object or @path/to/file.json",
            })
            .option("runner", {
              type: "string",
              describe: "Requested runner override as provider or provider/model",
            })
            .option("model", {
              type: "string",
              describe: "Requested runner model override",
            })
            .option("timeout-seconds", {
              type: "number",
              describe: "Run timeout hint",
            })
            .option("external-ref", {
              type: "string",
              describe: "External idempotency reference",
            })
            .option("metadata", {
              type: "string",
              describe: "Inline JSON object or @path/to/file.json",
            })
            .option("wait", {
              type: "boolean",
              default: false,
              describe: "Wait for terminal status",
            })
            .option("attempts", {
              type: "boolean",
              default: false,
              describe: "Include attempt details in waited output",
            })
            .option("json", {
              type: "boolean",
              default: false,
              describe: "Emit JSON output",
            }),
        async (args) => {
          if (args.model && !args.runner) {
            throw new Error("--model requires --runner");
          }
          const payload: Record<string, unknown> = {
            project_id: String(args.project),
            policy_id: String(args.policy),
            input: await parseJsonObjectInput(String(args.input), "input"),
          };
          if (args.runner) {
            payload.requested_runner = parseRunnerRef(String(args.runner), {
              model: args.model ? String(args.model) : undefined,
            });
          }
          if (args["timeout-seconds"] !== undefined) {
            payload.timeout_seconds = Number(args["timeout-seconds"]);
          }
          if (args["external-ref"]) {
            payload.external_ref = String(args["external-ref"]);
          }
          if (args.metadata) {
            payload.metadata = await parseJsonObjectInput(String(args.metadata), "metadata");
          }

          if (args.wait) {
            const manager = new ConduitRunManager(context.config, resolveStateDbPath(context.config));
            manager.start();
            try {
              const createdRun = await manager.createRun({
                project_id: String(args.project),
                policy_id: String(args.policy),
                input: payload.input as Record<string, unknown>,
                requested_runner: (payload.requested_runner as { provider: string; model: string | null } | undefined) ?? undefined,
                timeout_seconds:
                  payload.timeout_seconds === undefined ? undefined : Number(payload.timeout_seconds),
                external_ref: payload.external_ref as string | undefined,
                metadata: payload.metadata as Record<string, unknown> | undefined,
              });
              const run = await waitForTerminalLocalRun(manager, createdRun.run_id, {
                intervalMs: 1000,
                includeAttempts: Boolean(args.attempts),
                stdout: context.stdout,
                emitProgress: !args.json,
                sleep: context.sleep,
              });
              context.setExitCode(exitCodeForStatus(run.status));
              if (args.json) {
                writeJson(context.stdout, run);
                return;
              }
              printRunSummary(context.stdout, run);
              if ("attempts" in run) {
                printAttempts(context.stdout, run.attempts);
              }
              return;
            } finally {
              manager.close();
            }
          }

          const client = createHttpClient(String(args.baseUrl), context.fetchFn);
          const created = await client.request<RunCreateResponse>("/runs", {
            method: "POST",
            body: JSON.stringify(payload),
          });
          if (args.json) {
            writeJson(context.stdout, created);
          } else {
            context.stdout.write(
              `created ${created.run_id} status=${created.status} project=${created.project_id} policy=${created.policy_id}\n`,
            );
          }
        },
      );

      runsYargs.command(
        "get <runId>",
        "Get run status",
        (cmd) =>
          cmd
            .positional("runId", {
              type: "string",
              demandOption: true,
            })
            .option("attempts", {
              type: "boolean",
              default: false,
              describe: "Include attempts and checks",
            })
            .option("json", {
              type: "boolean",
              default: false,
              describe: "Emit JSON output",
            }),
        async (args) => {
          const baseUrl = String(args.baseUrl);
          const client = createHttpClient(baseUrl, context.fetchFn);
          let run: RunRecord | RunWithAttempts;
          try {
            run = await getRun(client, String(args.runId), Boolean(args.attempts));
          } catch (error) {
            withRuntimeErrorHint(error, baseUrl);
          }
          if (args.json) {
            writeJson(context.stdout, run);
            return;
          }
          printRunSummary(context.stdout, run);
          if ("attempts" in run) {
            printAttempts(context.stdout, run.attempts);
          }
        },
      );

      runsYargs.command(
        "watch <runId>",
        "Watch a run until terminal status",
        (cmd) =>
          cmd
            .positional("runId", {
              type: "string",
              demandOption: true,
            })
            .option("interval", {
              type: "number",
              default: 1000,
              describe: "Polling interval in milliseconds",
            })
            .option("attempts", {
              type: "boolean",
              default: false,
              describe: "Include attempt and check progress",
            })
            .option("json", {
              type: "boolean",
              default: false,
              describe: "Emit final JSON output",
            }),
        async (args) => {
          const baseUrl = String(args.baseUrl);
          const client = createHttpClient(baseUrl, context.fetchFn);
          let run: RunRecord | RunWithAttempts;
          try {
            run = await waitForTerminalRun(client, String(args.runId), {
              intervalMs: Number(args.interval),
              includeAttempts: Boolean(args.attempts),
              stdout: context.stdout,
              emitProgress: !args.json,
              sleep: context.sleep,
            });
          } catch (error) {
            withRuntimeErrorHint(error, baseUrl);
          }
          context.setExitCode(exitCodeForStatus(run.status));
          if (args.json) {
            writeJson(context.stdout, run);
            return;
          }
          printRunSummary(context.stdout, run);
          if ("attempts" in run) {
            printAttempts(context.stdout, run.attempts);
          }
        },
      );

      runsYargs.command(
        "cancel <runId>",
        "Cancel a run",
        (cmd) =>
          cmd
            .positional("runId", {
              type: "string",
              demandOption: true,
            })
            .option("json", {
              type: "boolean",
              default: false,
              describe: "Emit JSON output",
            }),
        async (args) => {
          const baseUrl = String(args.baseUrl);
          const client = createHttpClient(baseUrl, context.fetchFn);
          let response: { run_id: string; canceled: boolean };
          try {
            response = await client.request<{ run_id: string; canceled: boolean }>(
              `/runs/${encodeURIComponent(String(args.runId))}/cancel`,
              {
                method: "POST",
              },
            );
          } catch (error) {
            withRuntimeErrorHint(error, baseUrl);
          }
          if (args.json) {
            writeJson(context.stdout, response);
            return;
          }
          context.stdout.write(`run_id: ${response.run_id}\n`);
          context.stdout.write(`canceled: ${response.canceled}\n`);
        },
      );

      return runsYargs.demandCommand(1);
    },
  );
}
