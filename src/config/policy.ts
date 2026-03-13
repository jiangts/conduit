import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import type { ResolvedPolicy, RunnerRef } from "../types/run-types";

const HookListSchema = z.array(z.string()).default([]);
const RunnerSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1).nullable().optional(),
  })
  .strict();
const CheckSchema = z
  .object({
    name: z.string().min(1),
    command: z.string().min(1),
    timeout_seconds: z.number().int().positive().nullable().optional(),
    on_fail: z.enum(["retry", "fail", "ignore"]).optional(),
  })
  .strict();
const PolicySchema = z
  .object({
    policy_id: z.string().min(1),
    task_id: z.string().min(1),
    runner: RunnerSchema.optional(),
    hooks: z
      .object({
        init: HookListSchema.optional(),
        before_attempt: HookListSchema.optional(),
        after_attempt: HookListSchema.optional(),
        on_success: HookListSchema.optional(),
        on_failure: HookListSchema.optional(),
      })
      .strict()
      .optional(),
    checks: z.array(CheckSchema).optional(),
    retry: z
      .object({
        max_attempts: z.number().int().positive().optional(),
        timeout_seconds: z.number().int().positive().nullable().optional(),
        escalation: z
          .array(
            z
              .object({
                runner: RunnerSchema,
              })
              .strict(),
          )
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export async function loadPolicy(projectPath: string, policyId: string, defaultRunner: RunnerRef): Promise<ResolvedPolicy> {
  const policyDir = join(projectPath, ".conduit", "policies", policyId);
  const policyPath = join(policyDir, "policy.yaml");
  const raw = await readFile(policyPath, "utf8");
  const parsed = PolicySchema.parse(parseYaml(raw) as unknown);

  if (parsed.policy_id !== policyId) {
    throw new Error(`Policy id mismatch for "${policyId}"`);
  }

  return {
    policy_id: parsed.policy_id,
    task_id: parsed.task_id,
    runner: {
      provider: parsed.runner?.provider ?? defaultRunner.provider,
      model: parsed.runner?.model ?? defaultRunner.model,
    },
    hooks: {
      init: parsed.hooks?.init ?? [],
      before_attempt: parsed.hooks?.before_attempt ?? [],
      after_attempt: parsed.hooks?.after_attempt ?? [],
      on_success: parsed.hooks?.on_success ?? [],
      on_failure: parsed.hooks?.on_failure ?? [],
    },
    checks: (parsed.checks ?? []).map((check) => ({
      name: check.name,
      command: check.command,
      timeout_seconds: check.timeout_seconds ?? null,
      on_fail: check.on_fail ?? "retry",
    })),
    retry: {
      max_attempts: parsed.retry?.max_attempts ?? 1,
      timeout_seconds: parsed.retry?.timeout_seconds ?? null,
      escalation: (parsed.retry?.escalation ?? []).map((item) => ({
        provider: item.runner.provider,
        model: item.runner.model ?? null,
      })),
    },
    policy_dir: policyDir,
  };
}
