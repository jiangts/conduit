import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentRunUsage, ExitEvent } from "../types/agent-types";

type ChatExitSummary = Pick<ExitEvent, "code" | "signal" | "finalState" | "endedAt">;

export interface PersistedChatOutputs {
  outputDir: string;
  promptPath: string;
  stdoutPath: string;
  stderrPath: string;
  finalOutputPath: string | null;
  resultOutputPath: string;
}

export async function persistChatOutputs(input: {
  stateDir: string;
  threadId: string;
  queueItemId: string;
  prompt: string;
  stdout: string;
  stderr: string;
  finalMessage: string | null;
  usage: AgentRunUsage | null;
  exit: ChatExitSummary;
}): Promise<PersistedChatOutputs> {
  const outputDir = join(input.stateDir, "chats", input.threadId, input.queueItemId);
  await mkdir(outputDir, { recursive: true });

  const promptPath = join(outputDir, "prompt.txt");
  const stdoutPath = join(outputDir, "stdout.log");
  const stderrPath = join(outputDir, "stderr.log");
  const finalOutputPath = input.finalMessage !== null ? join(outputDir, "final.txt") : null;
  const resultOutputPath = join(outputDir, "result.json");

  await writeFile(promptPath, `${input.prompt}\n`, "utf8");
  await writeFile(stdoutPath, input.stdout, "utf8");
  await writeFile(stderrPath, input.stderr, "utf8");
  if (finalOutputPath !== null) {
    await writeFile(finalOutputPath, `${input.finalMessage}\n`, "utf8");
  }
  await writeFile(
    resultOutputPath,
    `${JSON.stringify(
      {
        threadId: input.threadId,
        queueItemId: input.queueItemId,
        finalMessage: input.finalMessage,
        usage: input.usage,
        exit: input.exit,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    outputDir,
    promptPath,
    stdoutPath,
    stderrPath,
    finalOutputPath,
    resultOutputPath,
  };
}

export function buildFinalMessagePreview(finalMessage: string | null, maxLength = 160): string | null {
  if (finalMessage === null) {
    return null;
  }

  const normalized = finalMessage.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return null;
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function buildUsageSummary(usage: AgentRunUsage | null): string | null {
  if (usage === null) {
    return null;
  }

  const parts: string[] = [];
  if (usage.inputTokens !== null) parts.push(`in ${usage.inputTokens}`);
  if (usage.outputTokens !== null) parts.push(`out ${usage.outputTokens}`);
  if (usage.cachedInputTokens !== null) parts.push(`cached ${usage.cachedInputTokens}`);
  if (usage.totalTokens !== null) parts.push(`total ${usage.totalTokens}`);
  return parts.length > 0 ? parts.join(" | ") : null;
}
