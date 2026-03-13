import type { ResolvedPolicy, RunSpec, StoredRun } from "../types/run-types";

export function buildAttemptPrompt(input: {
  run: StoredRun;
  spec: RunSpec;
  policy: ResolvedPolicy;
  attemptIndex: number;
  retryFeedback: string | null;
}): string {
  const lines = [
    "You are executing a Conduit run inside the target repository.",
    "Make the requested code changes in the working directory and leave the repo ready for validation checks.",
    "",
    `Task ID: ${input.policy.task_id}`,
    `Policy ID: ${input.policy.policy_id}`,
    `Project ID: ${input.spec.project_id}`,
    `Attempt: ${input.attemptIndex}`,
    "",
    "Run input:",
    "```json",
    JSON.stringify(input.spec.input, null, 2),
    "```",
  ];

  if (input.retryFeedback) {
    lines.push("", "Retry feedback:", "", input.retryFeedback);
  }

  return lines.join("\n");
}
