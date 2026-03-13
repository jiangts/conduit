import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

import type {
  AttemptStatus,
  RunStatus,
  RunnerRef,
  StoredAttempt,
  StoredCheckResult,
  StoredRun,
} from "../../types/run-types";

const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

const RUNS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL,
  input_json TEXT NOT NULL,
  resolved_project_json TEXT NOT NULL,
  runner_provider TEXT NOT NULL,
  runner_model TEXT,
  requested_runner_provider TEXT,
  requested_runner_model TEXT,
  external_ref TEXT,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (${NOW_SQL}),
  started_at TEXT,
  finished_at TEXT,
  max_attempts INTEGER NOT NULL,
  current_attempt_index INTEGER NOT NULL DEFAULT 0,
  cancel_requested_at TEXT,
  failure_summary TEXT,
  run_record_path TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_status_created_at ON runs(status, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_runs_project_policy ON runs(project_id, policy_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_external_ref_dedupe
ON runs(project_id, policy_id, external_ref)
WHERE external_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS attempts (
  attempt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  attempt_index INTEGER NOT NULL,
  status TEXT NOT NULL,
  runner_provider TEXT NOT NULL,
  runner_model TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER,
  workspace_path TEXT NOT NULL,
  output_dir TEXT NOT NULL,
  failure_summary TEXT,
  UNIQUE(run_id, attempt_index),
  FOREIGN KEY(run_id) REFERENCES runs(run_id)
);
CREATE INDEX IF NOT EXISTS idx_attempts_run ON attempts(run_id, attempt_index ASC);

CREATE TABLE IF NOT EXISTS check_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  attempt_index INTEGER NOT NULL,
  check_order INTEGER NOT NULL,
  name TEXT NOT NULL,
  command TEXT NOT NULL,
  on_fail TEXT NOT NULL,
  exit_code INTEGER,
  passed INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  duration_ms INTEGER,
  stdout_path TEXT,
  stderr_path TEXT,
  output_ref TEXT,
  failure_effective INTEGER NOT NULL,
  FOREIGN KEY(run_id) REFERENCES runs(run_id),
  FOREIGN KEY(attempt_id) REFERENCES attempts(attempt_id)
);
CREATE INDEX IF NOT EXISTS idx_check_results_attempt ON check_results(run_id, attempt_index ASC, check_order ASC);
`.trim();

function parseRunner(provider: string, model: string | null): RunnerRef {
  return { provider, model };
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

interface RunRow {
  run_id: string;
  project_id: string;
  policy_id: string;
  task_id: string;
  status: RunStatus;
  input_json: string;
  resolved_project_json: string;
  runner_provider: string;
  runner_model: string | null;
  requested_runner_provider: string | null;
  requested_runner_model: string | null;
  external_ref: string | null;
  metadata_json: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  max_attempts: number;
  current_attempt_index: number;
  cancel_requested_at: string | null;
  failure_summary: string | null;
  run_record_path: string;
}

export interface CreateRunInput {
  run_id: string;
  project_id: string;
  policy_id: string;
  task_id: string;
  status: RunStatus;
  input_json: string;
  resolved_project_json: string;
  runner: RunnerRef;
  requested_runner: RunnerRef | null;
  external_ref: string | null;
  metadata_json: string;
  max_attempts: number;
  run_record_path: string;
}

export interface CreateAttemptInput {
  attempt_id: string;
  run_id: string;
  attempt_index: number;
  status: AttemptStatus;
  runner: RunnerRef;
  started_at: string;
  workspace_path: string;
  output_dir: string;
}

export interface FinishAttemptInput {
  attempt_id: string;
  status: AttemptStatus;
  finished_at: string;
  duration_ms: number;
  failure_summary: string | null;
}

export interface CreateCheckResultInput {
  run_id: string;
  attempt_id: string;
  attempt_index: number;
  check_order: number;
  name: string;
  command: string;
  on_fail: string;
  exit_code: number | null;
  passed: boolean;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  stdout_path: string | null;
  stderr_path: string | null;
  output_ref: string | null;
  failure_effective: boolean;
}

export interface RunQueueCounts {
  queued: number;
  active: number;
}

export interface ListRunsOptions {
  limit: number;
  status?: RunStatus;
  projectId?: string;
  cursor?: {
    createdAt: string;
    runId: string;
  };
}

export interface ListRunsResult {
  runs: StoredRun[];
  nextCursor: {
    createdAt: string;
    runId: string;
  } | null;
}

export type RunStatusCounts = Record<RunStatus, number>;

export class SqliteRunStore {
  private readonly db: Database.Database;

  public constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(RUNS_SCHEMA_SQL);
  }

  public close(): void {
    this.db.close();
  }

  public createRun(input: CreateRunInput): void {
    this.db
      .prepare(
        `
INSERT INTO runs (
  run_id,
  project_id,
  policy_id,
  task_id,
  status,
  input_json,
  resolved_project_json,
  runner_provider,
  runner_model,
  requested_runner_provider,
  requested_runner_model,
  external_ref,
  metadata_json,
  max_attempts,
  run_record_path
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `.trim(),
      )
      .run(
        input.run_id,
        input.project_id,
        input.policy_id,
        input.task_id,
        input.status,
        input.input_json,
        input.resolved_project_json,
        input.runner.provider,
        input.runner.model,
        input.requested_runner?.provider ?? null,
        input.requested_runner?.model ?? null,
        input.external_ref,
        input.metadata_json,
        input.max_attempts,
        input.run_record_path,
      );
  }

  public updateRunStatus(runId: string, status: RunStatus, failureSummary: string | null = null): void {
    const terminal = status === "succeeded" || status === "failed" || status === "timed_out" || status === "canceled";
    this.db
      .prepare(
        `
UPDATE runs
SET status = ?,
    failure_summary = ?,
    finished_at = CASE WHEN ? THEN COALESCE(finished_at, ${NOW_SQL}) ELSE finished_at END
WHERE run_id = ?
        `.trim(),
      )
      .run(status, failureSummary, terminal ? 1 : 0, runId);
  }

  public markRunStartedIfQueued(runId: string): boolean {
    const result = this.db
      .prepare(
        `
UPDATE runs
SET status = 'running',
    started_at = COALESCE(started_at, ${NOW_SQL})
WHERE run_id = ?
  AND status = 'queued'
        `.trim(),
      )
      .run(runId) as { changes: number };
    return result.changes > 0;
  }

  public updateRunAttemptIndex(runId: string, attemptIndex: number): void {
    this.db
      .prepare(
        `
UPDATE runs
SET current_attempt_index = ?
WHERE run_id = ?
        `.trim(),
      )
      .run(attemptIndex, runId);
  }

  public requestCancel(runId: string): boolean {
    const result = this.db
      .prepare(
        `
UPDATE runs
SET cancel_requested_at = COALESCE(cancel_requested_at, ${NOW_SQL})
WHERE run_id = ?
  AND status NOT IN ('succeeded', 'failed', 'timed_out', 'canceled')
        `.trim(),
      )
      .run(runId) as { changes: number };
    return result.changes > 0;
  }

  public cancelQueuedRun(runId: string): boolean {
    const result = this.db
      .prepare(
        `
UPDATE runs
SET status = 'canceled',
    cancel_requested_at = COALESCE(cancel_requested_at, ${NOW_SQL}),
    finished_at = COALESCE(finished_at, ${NOW_SQL}),
    failure_summary = 'Run canceled'
WHERE run_id = ?
  AND status = 'queued'
        `.trim(),
      )
      .run(runId) as { changes: number };
    return result.changes > 0;
  }

  public isCancelRequested(runId: string): boolean {
    const row = this.db
      .prepare("SELECT cancel_requested_at FROM runs WHERE run_id = ?")
      .get(runId) as { cancel_requested_at: string | null } | undefined;
    return row?.cancel_requested_at !== null && row?.cancel_requested_at !== undefined;
  }

  public getRun(runId: string): StoredRun | null {
    const row = this.db
      .prepare(
        `
SELECT
  run_id,
  project_id,
  policy_id,
  task_id,
  status,
  input_json,
  resolved_project_json,
  runner_provider,
  runner_model,
  requested_runner_provider,
  requested_runner_model,
  external_ref,
  metadata_json,
  created_at,
  started_at,
  finished_at,
  max_attempts,
  current_attempt_index,
  cancel_requested_at,
  failure_summary,
  run_record_path
FROM runs
WHERE run_id = ?
        `.trim(),
      )
      .get(runId) as unknown as RunRow | undefined;

    if (!row) return null;

    return this.rowToRun(row);
  }

  public getRunByExternalRef(projectId: string, policyId: string, externalRef: string): StoredRun | null {
    const row = this.db
      .prepare(
        `
SELECT
  run_id,
  project_id,
  policy_id,
  task_id,
  status,
  input_json,
  resolved_project_json,
  runner_provider,
  runner_model,
  requested_runner_provider,
  requested_runner_model,
  external_ref,
  metadata_json,
  created_at,
  started_at,
  finished_at,
  max_attempts,
  current_attempt_index,
  cancel_requested_at,
  failure_summary,
  run_record_path
FROM runs
WHERE project_id = ?
  AND policy_id = ?
  AND external_ref = ?
ORDER BY created_at DESC
LIMIT 1
        `.trim(),
      )
      .get(projectId, policyId, externalRef) as unknown as RunRow | undefined;

    if (!row) return null;

    return this.rowToRun(row);
  }

  public listQueuedRuns(limit: number | null = null): StoredRun[] {
    const sql = `
SELECT
  run_id,
  project_id,
  policy_id,
  task_id,
  status,
  input_json,
  resolved_project_json,
  runner_provider,
  runner_model,
  requested_runner_provider,
  requested_runner_model,
  external_ref,
  metadata_json,
  created_at,
  started_at,
  finished_at,
  max_attempts,
  current_attempt_index,
  cancel_requested_at,
  failure_summary,
  run_record_path
FROM runs
WHERE status = 'queued'
ORDER BY created_at ASC, run_id ASC
${limit === null ? "" : "LIMIT ?"}
    `.trim();
    const statement = this.db.prepare(sql);
    const rows = (limit === null ? statement.all() : statement.all(limit)) as unknown as RunRow[];
    return rows.map((row) => this.rowToRun(row));
  }

  public getQueueCounts(): RunQueueCounts {
    const row = this.db
      .prepare(
        `
SELECT
  SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
  SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS active
FROM runs
        `.trim(),
      )
      .get() as { queued: number | null; active: number | null };

    return {
      queued: row.queued ?? 0,
      active: row.active ?? 0,
    };
  }

  public listRuns(options: ListRunsOptions): ListRunsResult {
    const where: string[] = [];
    const params: Array<string | number> = [];

    if (options.status) {
      where.push("status = ?");
      params.push(options.status);
    }
    if (options.projectId) {
      where.push("project_id = ?");
      params.push(options.projectId);
    }
    if (options.cursor) {
      where.push("(created_at < ? OR (created_at = ? AND run_id < ?))");
      params.push(options.cursor.createdAt, options.cursor.createdAt, options.cursor.runId);
    }

    const sql = `
SELECT
  run_id,
  project_id,
  policy_id,
  task_id,
  status,
  input_json,
  resolved_project_json,
  runner_provider,
  runner_model,
  requested_runner_provider,
  requested_runner_model,
  external_ref,
  metadata_json,
  created_at,
  started_at,
  finished_at,
  max_attempts,
  current_attempt_index,
  cancel_requested_at,
  failure_summary,
  run_record_path
FROM runs
${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
ORDER BY created_at DESC, run_id DESC
LIMIT ?
    `.trim();

    const rows = this.db.prepare(sql).all(...params, options.limit + 1) as unknown as RunRow[];
    const pageRows = rows.slice(0, options.limit);

    return {
      runs: pageRows.map((row) => this.rowToRun(row)),
      nextCursor:
        rows.length > options.limit
          ? {
              createdAt: pageRows[pageRows.length - 1].created_at,
              runId: pageRows[pageRows.length - 1].run_id,
            }
          : null,
    };
  }

  public getRunStatusCounts(): RunStatusCounts {
    const rows = this.db
      .prepare(
        `
SELECT status, COUNT(*) AS count
FROM runs
GROUP BY status
        `.trim(),
      )
      .all() as Array<{ status: RunStatus; count: number }>;

    const counts: RunStatusCounts = {
      queued: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      timed_out: 0,
      canceled: 0,
    };

    for (const row of rows) {
      counts[row.status] = row.count;
    }
    return counts;
  }

  private rowToRun(row: RunRow): StoredRun {
    return {
      run_id: row.run_id,
      project_id: row.project_id,
      policy_id: row.policy_id,
      task_id: row.task_id,
      status: row.status,
      input: parseJson(row.input_json),
      resolved_project: parseJson(row.resolved_project_json),
      runner: parseRunner(row.runner_provider, row.runner_model),
      requested_runner:
        row.requested_runner_provider === null ? null : parseRunner(row.requested_runner_provider, row.requested_runner_model),
      external_ref: row.external_ref,
      metadata: parseJson(row.metadata_json),
      created_at: row.created_at,
      started_at: row.started_at,
      finished_at: row.finished_at,
      max_attempts: row.max_attempts,
      current_attempt_index: row.current_attempt_index,
      cancel_requested_at: row.cancel_requested_at,
      failure_summary: row.failure_summary,
      run_record_path: row.run_record_path,
    };
  }

  public createAttempt(input: CreateAttemptInput): void {
    this.db
      .prepare(
        `
INSERT INTO attempts (
  attempt_id,
  run_id,
  attempt_index,
  status,
  runner_provider,
  runner_model,
  started_at,
  workspace_path,
  output_dir
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `.trim(),
      )
      .run(
        input.attempt_id,
        input.run_id,
        input.attempt_index,
        input.status,
        input.runner.provider,
        input.runner.model,
        input.started_at,
        input.workspace_path,
        input.output_dir,
      );
  }

  public finishAttempt(input: FinishAttemptInput): void {
    this.db
      .prepare(
        `
UPDATE attempts
SET status = ?,
    finished_at = ?,
    duration_ms = ?,
    failure_summary = ?
WHERE attempt_id = ?
        `.trim(),
      )
      .run(input.status, input.finished_at, input.duration_ms, input.failure_summary, input.attempt_id);
  }

  public listAttempts(runId: string): StoredAttempt[] {
    const rows = this.db
      .prepare(
        `
SELECT
  attempt_id,
  run_id,
  attempt_index,
  status,
  runner_provider,
  runner_model,
  started_at,
  finished_at,
  duration_ms,
  workspace_path,
  output_dir,
  failure_summary
FROM attempts
WHERE run_id = ?
ORDER BY attempt_index ASC
        `.trim(),
      )
      .all(runId) as Array<{
      attempt_id: string;
      run_id: string;
      attempt_index: number;
      status: AttemptStatus;
      runner_provider: string;
      runner_model: string | null;
      started_at: string;
      finished_at: string | null;
      duration_ms: number | null;
      workspace_path: string;
      output_dir: string;
      failure_summary: string | null;
    }>;

    return rows.map((row) => ({
      attempt_id: row.attempt_id,
      run_id: row.run_id,
      attempt_index: row.attempt_index,
      status: row.status,
      runner: parseRunner(row.runner_provider, row.runner_model),
      started_at: row.started_at,
      finished_at: row.finished_at,
      duration_ms: row.duration_ms,
      workspace_path: row.workspace_path,
      output_dir: row.output_dir,
      failure_summary: row.failure_summary,
    }));
  }

  public createCheckResult(input: CreateCheckResultInput): void {
    this.db
      .prepare(
        `
INSERT INTO check_results (
  run_id,
  attempt_id,
  attempt_index,
  check_order,
  name,
  command,
  on_fail,
  exit_code,
  passed,
  started_at,
  finished_at,
  duration_ms,
  stdout_path,
  stderr_path,
  output_ref,
  failure_effective
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `.trim(),
      )
      .run(
        input.run_id,
        input.attempt_id,
        input.attempt_index,
        input.check_order,
        input.name,
        input.command,
        input.on_fail,
        input.exit_code,
        input.passed ? 1 : 0,
        input.started_at,
        input.finished_at,
        input.duration_ms,
        input.stdout_path,
        input.stderr_path,
        input.output_ref,
        input.failure_effective ? 1 : 0,
      );
  }

  public listCheckResults(runId: string): StoredCheckResult[] {
    const rows = this.db
      .prepare(
        `
SELECT
  id,
  run_id,
  attempt_id,
  attempt_index,
  check_order,
  name,
  command,
  on_fail,
  exit_code,
  passed,
  started_at,
  finished_at,
  duration_ms,
  stdout_path,
  stderr_path,
  output_ref,
  failure_effective
FROM check_results
WHERE run_id = ?
ORDER BY attempt_index ASC, check_order ASC, id ASC
        `.trim(),
      )
      .all(runId) as Array<{
      id: number;
      run_id: string;
      attempt_id: string;
      attempt_index: number;
      check_order: number;
      name: string;
      command: string;
      on_fail: "retry" | "fail" | "ignore";
      exit_code: number | null;
      passed: number;
      started_at: string;
      finished_at: string;
      duration_ms: number | null;
      stdout_path: string | null;
      stderr_path: string | null;
      output_ref: string | null;
      failure_effective: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      run_id: row.run_id,
      attempt_id: row.attempt_id,
      attempt_index: row.attempt_index,
      check_order: row.check_order,
      name: row.name,
      command: row.command,
      on_fail: row.on_fail,
      exit_code: row.exit_code,
      passed: row.passed === 1,
      started_at: row.started_at,
      finished_at: row.finished_at,
      duration_ms: row.duration_ms,
      stdout_path: row.stdout_path,
      stderr_path: row.stderr_path,
      output_ref: row.output_ref,
      failure_effective: row.failure_effective === 1,
    }));
  }
}
