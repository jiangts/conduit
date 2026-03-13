import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute, join } from "node:path";
import process from "node:process";

import type { ConduitConfig } from "../config";
import { loadPolicy } from "../config";
import { SqliteRunStore } from "../stores/sqlite/sqlite-run-store";
import { SqliteAgentQueueStore } from "../stores/sqlite/sqlite-agent-queue-store";
import { createRunner } from "../runners/factory";
import type { AgentKind, AgentRunUsage, AgentRunner, ExitEvent } from "../types/agent-types";
import type {
  CheckFailureAction,
  ResolvedPolicy,
  RunSpec,
  RunnerRef,
  StoredAttempt,
  StoredCheckResult,
  StoredRun,
} from "../types/run-types";
import { RunOutputStore } from "./output-store";
import { buildAttemptPrompt } from "./attempt-prompt";
import {
  createRetryFeedbackPayload,
  DefaultRetryFeedbackFormatter,
  type RetryFeedbackCheckResult,
  type RetryFeedbackFormatter,
} from "./retry-feedback";

interface ActiveRunContext {
  controller: AbortController;
  child: ChildProcess | null;
  cancelAgent: (() => Promise<void>) | null;
}

interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  timedOut: boolean;
  canceled: boolean;
}

interface AgentInvocationResult {
  threadId: string;
  queueItemId: string;
  stdout: string;
  stderr: string;
  finalMessage: string | null;
  usage: AgentRunUsage | null;
  exit: ExitEvent;
}

interface CheckExecutionResult extends RetryFeedbackCheckResult {
  duration_ms: number | null;
  started_at: string;
  finished_at: string;
}

interface HookExecutionResult {
  workspacePath: string | null;
}

interface RunnerInstance {
  runner: AgentRunner;
  store: SqliteAgentQueueStore;
}

export type AttemptOutputTarget =
  | { kind: "agent"; stream: "stdout" | "stderr" }
  | { kind: "check"; checkName: string; stream: "stdout" | "stderr" };

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function resolvePolicyCommand(command: string, policy: ResolvedPolicy): string {
  const trimmed = command.trim();
  if (trimmed.startsWith("./") || trimmed.startsWith("../")) {
    return shellEscape(join(policy.policy_dir, trimmed));
  }
  return command;
}

function hookAllowsWorkspaceOverride(hookName: keyof ResolvedPolicy["hooks"]): boolean {
  return hookName === "init" || hookName === "before_attempt";
}

function parseHookOutput(raw: string): { workspace_path?: unknown } {
  return JSON.parse(raw) as { workspace_path?: unknown };
}

async function readBaselineRef(projectPath: string): Promise<string | null> {
  const headPath = join(projectPath, ".git", "HEAD");
  try {
    const head = (await readFile(headPath, "utf8")).trim();
    if (head.startsWith("ref: ")) {
      return head.slice(5);
    }
    return head || null;
  } catch {
    return null;
  }
}

function resolveDefaultRunRunner(config: ConduitConfig): RunnerRef {
  return {
    provider: config.defaultRunner,
    model: null,
  };
}

function isExternalRefConflictError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes("idx_runs_external_ref_dedupe") || error.message.includes("runs.project_id, runs.policy_id, runs.external_ref");
}

export class RunQueueCapacityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RunQueueCapacityError";
  }
}

export class ConduitRunManager {
  private readonly store: SqliteRunStore;
  private readonly outputs: RunOutputStore;
  private readonly activeRuns = new Map<string, ActiveRunContext>();
  private readonly runnerCache = new Map<string, RunnerInstance>();
  private pumpPromise: Promise<void> | null = null;
  private pumpRequested = false;
  private closed = false;

  public constructor(
    private readonly config: ConduitConfig,
    dbPath: string,
    private readonly retryFeedbackFormatter: RetryFeedbackFormatter = new DefaultRetryFeedbackFormatter(),
  ) {
    this.store = new SqliteRunStore(dbPath);
    this.outputs = new RunOutputStore(config.stateDir);
  }

  public close(): void {
    this.closed = true;
    for (const active of this.activeRuns.values()) {
      active.controller.abort();
      active.child?.kill("SIGTERM");
      void active.cancelAgent?.();
    }
    this.activeRuns.clear();
    for (const instance of this.runnerCache.values()) {
      instance.store.close();
    }
    this.runnerCache.clear();
    this.store.close();
  }

  public start(): void {
    this.requestPump();
  }

  public async createRun(spec: RunSpec): Promise<StoredRun> {
    const project = this.config.projects[spec.project_id];
    if (!project) {
      throw new Error(`Unknown project_id "${spec.project_id}"`);
    }

    const policy = await loadPolicy(project.path, spec.policy_id, resolveDefaultRunRunner(this.config));
    const resolvedProject = {
      project_id: spec.project_id,
      path: project.path,
      baseline_ref: await readBaselineRef(project.path),
    };
    if (spec.external_ref) {
      const existing = this.store.getRunByExternalRef(spec.project_id, spec.policy_id, spec.external_ref);
      if (existing) {
        this.requestPump();
        return existing;
      }
    }
    this.ensureQueueCapacity();
    const runId = `run_${randomUUID()}`;
    const runRecordPath = this.outputs.runRecordPath(runId);
    const runner = spec.requested_runner ?? policy.runner;

    try {
      this.store.createRun({
        run_id: runId,
        project_id: spec.project_id,
        policy_id: spec.policy_id,
        task_id: policy.task_id,
        status: "queued",
        input_json: JSON.stringify(spec.input),
        resolved_project_json: JSON.stringify(resolvedProject),
        runner,
        requested_runner: spec.requested_runner ?? null,
        external_ref: spec.external_ref ?? null,
        metadata_json: JSON.stringify(spec.metadata ?? {}),
        max_attempts: policy.retry.max_attempts,
        run_record_path: runRecordPath,
      });
    } catch (error) {
      if (spec.external_ref && isExternalRefConflictError(error)) {
        const existing = this.store.getRunByExternalRef(spec.project_id, spec.policy_id, spec.external_ref);
        if (existing) {
          this.requestPump();
          return existing;
        }
      }
      throw error;
    }

    const stored = this.requireRun(runId);
    await this.outputs.writeRunRecord(stored);
    this.requestPump();
    return stored;
  }

  public getRun(runId: string): StoredRun | null {
    return this.store.getRun(runId);
  }

  public getAttempts(runId: string): Array<StoredAttempt & { check_results: StoredCheckResult[] }> {
    const attempts = this.store.listAttempts(runId);
    const checks = this.store.listCheckResults(runId);
    return attempts.map((attempt) => ({
      ...attempt,
      check_results: checks.filter((check) => check.attempt_id === attempt.attempt_id),
    }));
  }

  public async getAttemptOutputArtifact(
    runId: string,
    attemptIndex: number,
    target: AttemptOutputTarget,
  ): Promise<{ path: string } | null> {
    const run = this.store.getRun(runId);
    if (!run) {
      return null;
    }

    const attempt = this.store.listAttempts(runId).find((entry) => entry.attempt_index === attemptIndex);
    if (!attempt) {
      return null;
    }

    if (target.kind === "agent") {
      return {
        path: join(attempt.output_dir, target.stream === "stdout" ? "agent.stdout.log" : "agent.stderr.log"),
      };
    }

    const check = this.store
      .listCheckResults(runId)
      .find((entry) => entry.attempt_index === attemptIndex && entry.name === target.checkName);
    if (!check) {
      return null;
    }

    const path = target.stream === "stdout" ? check.stdout_path : check.stderr_path;
    return path ? { path } : null;
  }

  public async cancelRun(runId: string): Promise<boolean> {
    const active = this.activeRuns.get(runId);
    if (!active && this.store.cancelQueuedRun(runId)) {
      await this.syncRunRecord(runId);
      this.requestPump();
      return true;
    }

    const requested = this.store.requestCancel(runId);
    if (active) {
      active.controller.abort();
      active.child?.kill("SIGTERM");
      void active.cancelAgent?.();
    }
    return requested || active !== undefined;
  }

  public getQueueCounts(): { queued: number; active: number } {
    return this.store.getQueueCounts();
  }

  private requireRun(runId: string): StoredRun {
    const run = this.store.getRun(runId);
    if (!run) {
      throw new Error(`Run "${runId}" not found`);
    }
    return run;
  }

  private async syncRunRecord(runId: string): Promise<void> {
    const run = this.requireRun(runId);
    await this.outputs.writeRunRecord(run);
  }

  private ensureQueueCapacity(): void {
    const maxQueuedRuns = this.config.server.queue.maxQueuedRuns;
    if (maxQueuedRuns === null) {
      return;
    }

    const counts = this.store.getQueueCounts();
    if (counts.queued >= maxQueuedRuns) {
      throw new RunQueueCapacityError("Queue capacity exceeded");
    }
  }

  private requestPump(): void {
    if (this.closed) {
      return;
    }
    if (this.pumpPromise) {
      this.pumpRequested = true;
      return;
    }

    this.pumpPromise = this.pumpQueue()
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Run queue pump failed: ${message}\n`);
      })
      .finally(() => {
        this.pumpPromise = null;
        if (this.pumpRequested) {
          this.pumpRequested = false;
          this.requestPump();
        }
      });
  }

  private async pumpQueue(): Promise<void> {
    while (true) {
      const counts = this.store.getQueueCounts();
      const maxActiveRuns = this.config.server.queue.maxActiveRuns;
      const availableSlots = maxActiveRuns === null ? null : maxActiveRuns - counts.active;
      if (availableSlots !== null && availableSlots <= 0) {
        return;
      }

      const queuedRuns = this.store.listQueuedRuns(availableSlots);
      if (queuedRuns.length === 0) {
        return;
      }

      let startedAny = false;
      for (const run of queuedRuns) {
        const started = await this.startQueuedRun(run.run_id);
        startedAny = startedAny || started;
      }

      if (!startedAny) {
        return;
      }
    }
  }

  private async startQueuedRun(runId: string): Promise<boolean> {
    if (!this.store.markRunStartedIfQueued(runId)) {
      return false;
    }

    await this.syncRunRecord(runId);
    const run = this.requireRun(runId);
    const spec = this.storedRunToSpec(run);

    try {
      const project = this.config.projects[run.project_id];
      if (!project) {
        throw new Error(`Unknown project_id "${run.project_id}"`);
      }

      const policy = await loadPolicy(project.path, run.policy_id, resolveDefaultRunRunner(this.config));
      void this.executeRun(runId, spec, policy).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.store.updateRunStatus(runId, "failed", message);
        void this.syncRunRecord(runId);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.updateRunStatus(runId, "failed", message);
      await this.syncRunRecord(runId);
    }

    return true;
  }

  private storedRunToSpec(run: StoredRun): RunSpec {
    return {
      project_id: run.project_id,
      policy_id: run.policy_id,
      input: run.input,
      requested_runner: run.requested_runner ?? undefined,
      timeout_seconds: undefined,
      external_ref: run.external_ref ?? undefined,
      metadata: run.metadata,
    };
  }

  private async executeRun(runId: string, spec: RunSpec, policy: ResolvedPolicy): Promise<void> {
    const controller = new AbortController();
    const active: ActiveRunContext = { controller, child: null, cancelAgent: null };
    this.activeRuns.set(runId, active);
    let retryFeedback: string | null = null;
    let runWorkspacePath = this.config.projects[spec.project_id].path;

    try {
      if (this.store.isCancelRequested(runId)) {
        this.store.updateRunStatus(runId, "canceled", "Run canceled before start");
        await this.syncRunRecord(runId);
        return;
      }

      const initHookResult = await this.runHookList(runId, policy, "init", spec, 0, runWorkspacePath, controller.signal, active);
      runWorkspacePath = initHookResult.workspacePath ?? runWorkspacePath;

      for (let attemptIndex = 1; attemptIndex <= policy.retry.max_attempts; attemptIndex += 1) {
        if (this.store.isCancelRequested(runId)) {
          await this.finishCanceled(runId, policy, spec, null);
          return;
        }

        const attemptId = `${runId}:attempt:${attemptIndex}`;
        const outputDir = await this.outputs.initAttempt(runId, attemptIndex);
        const startedAt = nowIso();
        this.store.updateRunAttemptIndex(runId, attemptIndex);
        const attemptRunner = this.resolveAttemptRunner(spec, policy, attemptIndex);
        const attemptStarted = Date.now();
        let attemptFailureSummary: string | null = null;
        let attemptWorkspacePath = runWorkspacePath;
        let attemptRecorded = false;

        try {
          const beforeAttemptHookResult = await this.runHookList(
            runId,
            policy,
            "before_attempt",
            spec,
            attemptIndex,
            attemptWorkspacePath,
            controller.signal,
            active,
          );
          attemptWorkspacePath = beforeAttemptHookResult.workspacePath ?? attemptWorkspacePath;
          this.store.createAttempt({
            attempt_id: attemptId,
            run_id: runId,
            attempt_index: attemptIndex,
            status: "running",
            runner: attemptRunner,
            started_at: startedAt,
            workspace_path: attemptWorkspacePath,
            output_dir: outputDir,
          });
          attemptRecorded = true;
          await this.syncRunRecord(runId);

          const agentResult = await this.invokeAgent(
            runId,
            spec,
            policy,
            attemptIndex,
            attemptWorkspacePath,
            retryFeedback,
            controller.signal,
            active,
          );
          if (agentResult.exit.finalState !== "completed" || agentResult.exit.code !== 0) {
            attemptFailureSummary = `Agent execution failed with state ${agentResult.exit.finalState}`;
            this.store.finishAttempt({
              attempt_id: attemptId,
              status: agentResult.exit.finalState === "cancelled" ? "canceled" : "failed",
              finished_at: nowIso(),
              duration_ms: Date.now() - attemptStarted,
              failure_summary: attemptFailureSummary,
            });
            await this.syncRunRecord(runId);

            if (agentResult.exit.finalState === "cancelled" || controller.signal.aborted || this.store.isCancelRequested(runId)) {
              await this.finishCanceled(runId, policy, spec, attemptIndex);
              return;
            }
            if (attemptIndex === policy.retry.max_attempts) {
              await this.runHookList(runId, policy, "on_failure", spec, attemptIndex, attemptWorkspacePath, controller.signal, active);
              this.store.updateRunStatus(runId, "failed", attemptFailureSummary);
              await this.syncRunRecord(runId);
              return;
            }

            retryFeedback = `Previous attempt failed before checks completed.\nFailure summary: ${attemptFailureSummary}`;
            await sleep(10);
            continue;
          }

          const checkOutcome = await this.runChecks(
            runId,
            attemptId,
            attemptIndex,
            spec,
            policy,
            attemptWorkspacePath,
            controller.signal,
            active,
          );
          await this.runHookList(runId, policy, "after_attempt", spec, attemptIndex, attemptWorkspacePath, controller.signal, active);

          if (checkOutcome.outcome === "succeeded") {
            this.store.finishAttempt({
              attempt_id: attemptId,
              status: "succeeded",
              finished_at: nowIso(),
              duration_ms: Date.now() - attemptStarted,
              failure_summary: null,
            });
            await this.runHookList(runId, policy, "on_success", spec, attemptIndex, attemptWorkspacePath, controller.signal, active);
            this.store.updateRunStatus(runId, "succeeded");
            await this.syncRunRecord(runId);
            return;
          }

          attemptFailureSummary =
            checkOutcome.outcome === "fail" ? "Policy check requested terminal failure" : "Retryable check failure";
          retryFeedback = this.retryFeedbackFormatter.format(
            createRetryFeedbackPayload({
              run: this.requireRun(runId),
              attemptIndex,
              failureSummary: attemptFailureSummary,
              checks: checkOutcome.checks,
            }),
          );
          this.store.finishAttempt({
            attempt_id: attemptId,
            status: "failed",
            finished_at: nowIso(),
            duration_ms: Date.now() - attemptStarted,
            failure_summary: attemptFailureSummary,
          });
          await this.syncRunRecord(runId);

          if (checkOutcome.outcome === "fail" || attemptIndex === policy.retry.max_attempts) {
            await this.runHookList(runId, policy, "on_failure", spec, attemptIndex, attemptWorkspacePath, controller.signal, active);
            this.store.updateRunStatus(runId, "failed", attemptFailureSummary);
            await this.syncRunRecord(runId);
            return;
          }

          await sleep(10);
        } catch (error) {
          const finishedAt = nowIso();
          const durationMs = Date.now() - attemptStarted;
          if (!attemptRecorded) {
            this.store.createAttempt({
              attempt_id: attemptId,
              run_id: runId,
              attempt_index: attemptIndex,
              status: "running",
              runner: attemptRunner,
              started_at: startedAt,
              workspace_path: attemptWorkspacePath,
              output_dir: outputDir,
            });
            attemptRecorded = true;
          }
          if (controller.signal.aborted || this.store.isCancelRequested(runId)) {
            this.store.finishAttempt({
              attempt_id: attemptId,
              status: "canceled",
              finished_at: finishedAt,
              duration_ms: durationMs,
              failure_summary: "Run canceled",
            });
            await this.syncRunRecord(runId);
            await this.finishCanceled(runId, policy, spec, attemptIndex);
            return;
          }

          const timedOut = error instanceof Error && error.message === "Command timed out";
          attemptFailureSummary = error instanceof Error ? error.message : String(error);
          this.store.finishAttempt({
            attempt_id: attemptId,
            status: timedOut ? "timed_out" : "failed",
            finished_at: finishedAt,
            duration_ms: durationMs,
            failure_summary: attemptFailureSummary,
          });
          await this.syncRunRecord(runId);
          await this.runHookList(runId, policy, "on_failure", spec, attemptIndex, attemptWorkspacePath, controller.signal, active).catch(
            () => undefined,
          );
          this.store.updateRunStatus(runId, timedOut ? "timed_out" : "failed", attemptFailureSummary);
          await this.syncRunRecord(runId);
          return;
        }
      }
    } finally {
      this.activeRuns.delete(runId);
      this.requestPump();
    }
  }

  private async finishCanceled(runId: string, policy: ResolvedPolicy, spec: RunSpec, attemptIndex: number | null): Promise<void> {
    const hookController = new AbortController();
    const effectiveAttemptIndex = attemptIndex ?? this.requireRun(runId).current_attempt_index;
    await this.runHookList(
      runId,
      policy,
      "on_failure",
      spec,
      effectiveAttemptIndex,
      this.resolveHookWorkspacePath(runId, effectiveAttemptIndex),
      hookController.signal,
      {
        controller: hookController,
        child: null,
        cancelAgent: null,
      },
    ).catch(() => undefined);
    this.store.updateRunStatus(runId, "canceled", "Run canceled");
    await this.syncRunRecord(runId);
  }

  private async runHookList(
    runId: string,
    policy: ResolvedPolicy,
    hookName: keyof ResolvedPolicy["hooks"],
    spec: RunSpec,
    attemptIndex: number,
    workspacePath: string,
    signal: AbortSignal,
    active: ActiveRunContext,
  ): Promise<HookExecutionResult> {
    const commands = policy.hooks[hookName];
    let nextWorkspacePath: string | null = null;
    for (const command of commands) {
      const resolvedCommand = resolvePolicyCommand(command, policy);
      const baseDir = attemptIndex > 0 ? this.outputs.attemptDir(runId, attemptIndex) : this.outputs.runDir(runId);
      await mkdir(join(baseDir, "hooks"), { recursive: true });
      const fileBase = join(baseDir, "hooks", `${hookName}-${Date.now()}`);
      const hookOutputPath = `${fileBase}.result.json`;
      const result = await this.runCommand(resolvedCommand, {
        cwd: workspacePath,
        env: this.commandEnv(runId, attemptIndex, spec, workspacePath, hookOutputPath),
        timeoutMs: null,
        signal,
        active,
      });
      await writeFile(`${fileBase}.stdout.log`, result.stdout, "utf8");
      await writeFile(`${fileBase}.stderr.log`, result.stderr, "utf8");
      if (result.timedOut) {
        throw new Error("Command timed out");
      }
      if (result.canceled) {
        throw new Error("Run canceled");
      }
      if (result.exitCode !== 0) {
        throw new Error(`Hook "${hookName}" failed with exit code ${result.exitCode}`);
      }

      const hookWorkspacePath = await this.readHookWorkspacePath(hookName, hookOutputPath);
      if (hookWorkspacePath !== null) {
        nextWorkspacePath = hookWorkspacePath;
        workspacePath = hookWorkspacePath;
      }
    }
    return { workspacePath: nextWorkspacePath };
  }

  private async runChecks(
    runId: string,
    attemptId: string,
    attemptIndex: number,
    spec: RunSpec,
    policy: ResolvedPolicy,
    workspacePath: string,
    signal: AbortSignal,
    active: ActiveRunContext,
  ): Promise<{ outcome: "succeeded"; checks: CheckExecutionResult[] } | { outcome: CheckFailureAction; checks: CheckExecutionResult[] }> {
    const checkResults: CheckExecutionResult[] = [];

    for (let index = 0; index < policy.checks.length; index += 1) {
      const check = policy.checks[index];
      const result = await this.runCommand(resolvePolicyCommand(check.command, policy), {
        cwd: workspacePath,
        env: this.commandEnv(runId, attemptIndex, spec, workspacePath),
        timeoutMs: check.timeout_seconds === null ? null : check.timeout_seconds * 1000,
        signal,
        active,
      });
      const outputPaths = this.outputs.checkOutputPaths(runId, attemptIndex, index + 1, check.name);
      await writeFile(outputPaths.stdout, result.stdout, "utf8");
      await writeFile(outputPaths.stderr, result.stderr, "utf8");

      const passed = result.exitCode === 0 && !result.timedOut && !result.canceled;
      const failureEffective = !passed && check.on_fail !== "ignore";
      const checkResult: CheckExecutionResult = {
        name: check.name,
        command: check.command,
        on_fail: check.on_fail,
        exit_code: result.exitCode,
        passed,
        started_at: result.startedAt,
        finished_at: result.finishedAt,
        duration_ms: result.durationMs,
        stdout: result.stdout,
        stderr: result.stderr,
        stdout_path: outputPaths.stdout,
        stderr_path: outputPaths.stderr,
        failure_effective: failureEffective,
      };
      checkResults.push(checkResult);
      this.store.createCheckResult({
        run_id: runId,
        attempt_id: attemptId,
        attempt_index: attemptIndex,
        check_order: index + 1,
        name: check.name,
        command: check.command,
        on_fail: check.on_fail,
        exit_code: result.exitCode,
        passed,
        started_at: result.startedAt,
        finished_at: result.finishedAt,
        duration_ms: result.durationMs,
        stdout_path: outputPaths.stdout,
        stderr_path: outputPaths.stderr,
        output_ref: null,
        failure_effective: failureEffective,
      });
      await this.syncRunRecord(runId);

      if (result.canceled) {
        throw new Error("Run canceled");
      }
      if (result.timedOut) {
        throw new Error("Command timed out");
      }
      if (passed || check.on_fail === "ignore") {
        continue;
      }
      return { outcome: check.on_fail, checks: checkResults };
    }

    return { outcome: "succeeded", checks: checkResults };
  }

  private async invokeAgent(
    runId: string,
    spec: RunSpec,
    policy: ResolvedPolicy,
    attemptIndex: number,
    workspacePath: string,
    retryFeedback: string | null,
    signal: AbortSignal,
    active: ActiveRunContext,
  ): Promise<AgentInvocationResult> {
    const run = this.requireRun(runId);
    const runnerRef = this.resolveAttemptRunner(spec, policy, attemptIndex);
    const instance = this.getRunnerInstance(runnerRef);
    const prompt = buildAttemptPrompt({
      run,
      spec,
      policy,
      attemptIndex,
      retryFeedback,
    });
    const attemptDir = this.outputs.attemptDir(runId, attemptIndex);
    await writeFile(join(attemptDir, "agent.prompt.txt"), `${prompt}\n`, "utf8");
    if (retryFeedback) {
      await writeFile(join(attemptDir, "retry-feedback.txt"), `${retryFeedback}\n`, "utf8");
    }

    let threadId: string | null = null;
    let queueItemId: string | null = null;
    let stdout = "";
    let stderr = "";

    const exit = await new Promise<ExitEvent>((resolve, reject) => {
      const abortHandler = () => {
        if (threadId) {
          void instance.runner.cancel(threadId);
        }
      };
      const cleanup = () => {
        signal.removeEventListener("abort", abortHandler);
        active.cancelAgent = null;
      };
      signal.addEventListener("abort", abortHandler, { once: true });

      void instance.runner
        .run(prompt, {
          workingDirectory: workspacePath,
          metadata: {
            conduitRunId: run.run_id,
            conduitAttemptIndex: String(attemptIndex),
            conduitTaskId: run.task_id,
          },
          callbacks: {
            onQueued: (event) => {
              threadId = event.threadId;
              queueItemId = event.queueItemId;
              active.cancelAgent = async () => {
                await instance.runner.cancel(event.threadId);
              };
            },
            onStdout: (event) => {
              stdout += `${event.chunk}\n`;
            },
            onStderr: (event) => {
              stderr += `${event.chunk}\n`;
            },
            onExit: (event) => {
              cleanup();
              resolve(event);
            },
            onError: (event) => {
              cleanup();
              reject(event.error);
            },
          },
        })
        .then(async (result) => {
          threadId = result.threadId;
          queueItemId = result.queueItemId;
          if (signal.aborted) {
            await instance.runner.cancel(result.threadId);
          }
        })
        .catch((error) => {
          cleanup();
          reject(error);
        });
    });

    const finalMessage = instance.runner.extractFinalMessage(stdout);
    const usage = instance.runner.extractUsage(stdout);

    await writeFile(join(attemptDir, "agent.stdout.log"), stdout, "utf8");
    await writeFile(join(attemptDir, "agent.stderr.log"), stderr, "utf8");
    if (finalMessage !== null) {
      await writeFile(join(attemptDir, "agent.final.txt"), `${finalMessage}\n`, "utf8");
    }
    await writeFile(
      join(attemptDir, "agent.result.json"),
      `${JSON.stringify({ threadId, queueItemId, finalMessage, usage, exit }, null, 2)}\n`,
      "utf8",
    );

    if (!threadId || !queueItemId) {
      throw new Error("Agent execution completed without thread metadata");
    }

    return {
      threadId,
      queueItemId,
      stdout,
      stderr,
      finalMessage,
      usage,
      exit,
    };
  }

  private getRunnerInstance(runner: RunnerRef): RunnerInstance {
    const provider = this.asAgentKind(runner.provider);
    const args = this.config.runners[provider].args;
    const key = JSON.stringify([provider, args]);
    const existing = this.runnerCache.get(key);
    if (existing) {
      return existing;
    }

    const store = new SqliteAgentQueueStore(join(this.config.stateDir, "db.sqlite"));
    const instance = {
      runner: createRunner(provider, store, args),
      store,
    };
    this.runnerCache.set(key, instance);
    return instance;
  }

  private asAgentKind(value: string): AgentKind {
    if (value === "claude" || value === "codex" || value === "cursor" || value === "gemini") {
      return value;
    }
    throw new Error(`Unsupported runner provider "${value}"`);
  }

  private resolveAttemptRunner(spec: RunSpec, policy: ResolvedPolicy, attemptIndex: number): RunnerRef {
    const baseRunner = spec.requested_runner ?? policy.runner;
    const sequence = [baseRunner, ...policy.retry.escalation];
    const selected = sequence[Math.min(Math.max(attemptIndex - 1, 0), sequence.length - 1)];
    return {
      provider: selected.provider,
      model: selected.model,
    };
  }

  private commandEnv(
    runId: string,
    attemptIndex: number,
    spec: RunSpec,
    workspacePath: string,
    hookOutputPath?: string,
  ): NodeJS.ProcessEnv {
    const run = this.requireRun(runId);
    const outputDir = attemptIndex > 0 ? this.outputs.attemptDir(runId, attemptIndex) : this.outputs.runDir(runId);
    return {
      ...process.env,
      CONDUIT_RUN_ID: runId,
      CONDUIT_PROJECT_ID: spec.project_id,
      CONDUIT_POLICY_ID: spec.policy_id,
      CONDUIT_TASK_ID: run.task_id,
      CONDUIT_ATTEMPT_INDEX: String(attemptIndex),
      CONDUIT_ATTEMPT_ID: attemptIndex > 0 ? `${runId}:attempt:${attemptIndex}` : "",
      CONDUIT_PROJECT_PATH: run.resolved_project.path,
      CONDUIT_WORKSPACE: workspacePath,
      CONDUIT_WORKSPACE_PATH: workspacePath,
      CONDUIT_ATTEMPT_OUTPUT: outputDir,
      CONDUIT_HOOK_OUTPUT_PATH: hookOutputPath ?? "",
      CONDUIT_BASELINE_REF: run.resolved_project.baseline_ref ?? "",
      CONDUIT_RUN_INPUT_JSON: JSON.stringify(spec.input),
    };
  }

  private resolveHookWorkspacePath(runId: string, attemptIndex: number): string {
    const run = this.requireRun(runId);
    if (attemptIndex > 0) {
      const attempt = this.store.listAttempts(runId).find((entry) => entry.attempt_index === attemptIndex);
      if (attempt) {
        return attempt.workspace_path;
      }
    }
    return run.resolved_project.path;
  }

  private async readHookWorkspacePath(
    hookName: keyof ResolvedPolicy["hooks"],
    hookOutputPath: string,
  ): Promise<string | null> {
    let raw: string;
    try {
      await access(hookOutputPath);
      raw = await readFile(hookOutputPath, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return null;
      }
      throw error;
    }

    const parsed = parseHookOutput(raw);
    if (parsed.workspace_path === undefined) {
      return null;
    }
    if (!hookAllowsWorkspaceOverride(hookName)) {
      throw new Error(`Hook "${hookName}" cannot update workspace_path`);
    }
    if (typeof parsed.workspace_path !== "string" || parsed.workspace_path.length === 0) {
      throw new Error(`Hook "${hookName}" returned invalid workspace_path`);
    }
    if (!isAbsolute(parsed.workspace_path)) {
      throw new Error(`Hook "${hookName}" returned non-absolute workspace_path`);
    }
    try {
      await access(parsed.workspace_path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new Error(`Hook "${hookName}" returned missing workspace_path`);
      }
      throw error;
    }
    return parsed.workspace_path;
  }

  private async runCommand(
    command: string,
    input: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      timeoutMs: number | null;
      signal: AbortSignal;
      active: ActiveRunContext;
    },
  ): Promise<CommandResult> {
    const startedAt = nowIso();
    const startedMs = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let canceled = false;

    const child = spawn("bash", ["-lc", command], {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    input.active.child = child;

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const timeout = input.timeoutMs === null ? null : setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, input.timeoutMs);

    const abortHandler = () => {
      canceled = true;
      child.kill("SIGTERM");
    };
    input.signal.addEventListener("abort", abortHandler, { once: true });

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code));
    }).finally(() => {
      if (timeout !== null) clearTimeout(timeout);
      input.signal.removeEventListener("abort", abortHandler);
      if (input.active.child === child) {
        input.active.child = null;
      }
    });

    return {
      exitCode,
      stdout,
      stderr,
      startedAt,
      finishedAt: nowIso(),
      durationMs: Date.now() - startedMs,
      timedOut,
      canceled,
    };
  }
}
