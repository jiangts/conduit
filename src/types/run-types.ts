export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "timed_out" | "canceled";

export type AttemptStatus = "running" | "succeeded" | "failed" | "timed_out" | "canceled";

export type CheckFailureAction = "retry" | "fail" | "ignore";

export interface RunnerRef {
  provider: string;
  model: string | null;
}

export interface RunSpec {
  project_id: string;
  policy_id: string;
  input: Record<string, unknown>;
  requested_runner?: RunnerRef | undefined;
  timeout_seconds?: number | undefined;
  external_ref?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface ResolvedProjectSnapshot {
  project_id: string;
  path: string;
  baseline_ref: string | null;
}

export interface StoredRun {
  run_id: string;
  project_id: string;
  policy_id: string;
  task_id: string;
  status: RunStatus;
  input: Record<string, unknown>;
  resolved_project: ResolvedProjectSnapshot;
  runner: RunnerRef;
  requested_runner: RunnerRef | null;
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

export interface StoredAttempt {
  attempt_id: string;
  run_id: string;
  attempt_index: number;
  status: AttemptStatus;
  runner: RunnerRef;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  workspace_path: string;
  output_dir: string;
  failure_summary: string | null;
}

export interface StoredCheckResult {
  id: number;
  run_id: string;
  attempt_id: string;
  attempt_index: number;
  check_order: number;
  name: string;
  command: string;
  on_fail: CheckFailureAction;
  exit_code: number | null;
  passed: boolean;
  started_at: string;
  finished_at: string;
  duration_ms: number | null;
  stdout_path: string | null;
  stderr_path: string | null;
  output_ref: string | null;
  failure_effective: boolean;
}

export interface PolicyCheck {
  name: string;
  command: string;
  timeout_seconds: number | null;
  on_fail: CheckFailureAction;
}

export interface ResolvedPolicy {
  policy_id: string;
  task_id: string;
  runner: RunnerRef;
  hooks: {
    init: string[];
    before_attempt: string[];
    after_attempt: string[];
    on_success: string[];
    on_failure: string[];
  };
  checks: PolicyCheck[];
  retry: {
    max_attempts: number;
    timeout_seconds: number | null;
    escalation: RunnerRef[];
  };
  policy_dir: string;
}
