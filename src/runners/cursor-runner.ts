import { spawn } from "node:child_process";

import { AbstractAgentRunner, AgentRunnerInitOptions } from "../abstract-agent-runner";
import { AgentQueueStore, AgentRunUsage, SpawnInput } from "../types/agent-types";

export interface CursorRunnerOptions extends AgentRunnerInitOptions {
  command?: string;
  baseArgs?: string[];
  env?: NodeJS.ProcessEnv;
}

export class CursorRunner extends AbstractAgentRunner {
  public readonly kind = "cursor" as const;

  private readonly command: string;
  private readonly baseArgs: string[];
  private readonly env: NodeJS.ProcessEnv;

  public constructor(store: AgentQueueStore, options: CursorRunnerOptions = {}) {
    super(store, options);
    this.command = options.command ?? "cursor-agent";
    this.baseArgs = options.baseArgs ?? [];
    this.env = options.env ?? {};
  }

  protected async spawnAgent(input: SpawnInput) {
    const args = ["-p", input.prompt, "--output-format", "stream-json", ...this.baseArgs];

    const sessionId =
      input.metadata.cursorSessionId ??
      input.metadata.sessionId ??
      input.metadata.resumeSessionId ??
      input.metadata.providerThreadId;
    if (sessionId) {
      args.push("--resume", sessionId);
    }

    return spawn(this.command, args, {
      cwd: input.workingDirectory,
      env: {
        ...process.env,
        ...this.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  public extractFinalMessage(stdout: string): string | null {
    let assistantMessage: string | null = null;

    for (const event of this.parseJsonLines(stdout)) {
      if (!event || typeof event !== "object") {
        continue;
      }

      const record = event as Record<string, unknown>;
      if (record.type === "result") {
        const text = this.extractText(record.result);
        if (text !== null) {
          return text;
        }
      }

      if (record.type === "assistant") {
        const text = this.extractText(record.message);
        if (text !== null) {
          assistantMessage = text;
        }
      }
    }

    return assistantMessage ?? super.extractFinalMessage(stdout);
  }

  public extractUsage(stdout: string): AgentRunUsage | null {
    for (const event of this.parseJsonLines(stdout)) {
      if (!event || typeof event !== "object") {
        continue;
      }

      const record = event as Record<string, unknown>;
      if (record.type !== "result") {
        continue;
      }

      const usage = record.usage;
      if (!usage || typeof usage !== "object") {
        continue;
      }

      const usageRecord = usage as Record<string, unknown>;
      const inputTokens = typeof usageRecord.inputTokens === "number" ? usageRecord.inputTokens : null;
      const outputTokens = typeof usageRecord.outputTokens === "number" ? usageRecord.outputTokens : null;

      return this.createUsage({
        inputTokens,
        outputTokens,
        cachedInputTokens: typeof usageRecord.cacheReadTokens === "number" ? usageRecord.cacheReadTokens : null,
        cacheWriteTokens: typeof usageRecord.cacheWriteTokens === "number" ? usageRecord.cacheWriteTokens : null,
        totalTokens:
          inputTokens !== null && outputTokens !== null
            ? inputTokens + outputTokens
            : null,
      });
    }

    return null;
  }
}
