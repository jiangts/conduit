import type { CheckFailureAction, StoredRun } from "../types/run-types";

export interface RetryFeedbackCheckResult {
  name: string;
  command: string;
  on_fail: CheckFailureAction;
  exit_code: number | null;
  passed: boolean;
  stdout: string;
  stderr: string;
  stdout_path: string | null;
  stderr_path: string | null;
  failure_effective: boolean;
}

export interface RetryFeedbackPayload {
  run_id: string;
  task_id: string;
  attempt_index: number;
  failure_summary: string | null;
  checks: RetryFeedbackCheckResult[];
}

export interface RetryFeedbackFormatter {
  format(payload: RetryFeedbackPayload): string;
}

export function createRetryFeedbackPayload(input: {
  run: StoredRun;
  attemptIndex: number;
  failureSummary: string | null;
  checks: RetryFeedbackCheckResult[];
}): RetryFeedbackPayload {
  return {
    run_id: input.run.run_id,
    task_id: input.run.task_id,
    attempt_index: input.attemptIndex,
    failure_summary: input.failureSummary,
    checks: input.checks.filter((check) => !check.passed && check.failure_effective),
  };
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}\n...[truncated]`;
}

function renderCheckOutput(label: string, value: string): string[] {
  if (value.trim().length === 0) {
    return [];
  }
  return [`${label}:`, "```text", truncate(value.trim(), 4000), "```"];
}

export class DefaultRetryFeedbackFormatter implements RetryFeedbackFormatter {
  public format(payload: RetryFeedbackPayload): string {
    if (payload.checks.length === 0) {
      return payload.failure_summary ?? "Previous attempt failed without retryable check output.";
    }

    const lines: string[] = [
      "Previous attempt failed validation. Fix the issues below before the next checks run.",
    ];

    if (payload.failure_summary) {
      lines.push(`Failure summary: ${payload.failure_summary}`);
    }

    for (const check of payload.checks) {
      lines.push("");
      lines.push(`Check: ${check.name}`);
      lines.push(`Command: ${check.command}`);
      lines.push(`Exit code: ${check.exit_code === null ? "null" : String(check.exit_code)}`);
      if (check.stdout_path) {
        lines.push(`Stdout path: ${check.stdout_path}`);
      }
      if (check.stderr_path) {
        lines.push(`Stderr path: ${check.stderr_path}`);
      }
      lines.push(...renderCheckOutput("Stdout", check.stdout));
      lines.push(...renderCheckOutput("Stderr", check.stderr));
    }

    return lines.join("\n");
  }
}
