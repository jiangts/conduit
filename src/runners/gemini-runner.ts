import { spawn } from "node:child_process";

import { AbstractAgentRunner, AgentRunnerInitOptions } from "../abstract-agent-runner";
import { AgentQueueStore, AgentRunUsage, SpawnInput } from "../types/agent-types";

export interface GeminiRunnerOptions extends AgentRunnerInitOptions {
  command?: string;
  baseArgs?: string[];
  env?: NodeJS.ProcessEnv;
}

export class GeminiRunner extends AbstractAgentRunner {
  public readonly kind = "gemini" as const;

  private readonly command: string;
  private readonly baseArgs: string[];
  private readonly env: NodeJS.ProcessEnv;

  public constructor(store: AgentQueueStore, options: GeminiRunnerOptions = {}) {
    super(store, options);
    this.command = options.command ?? "gemini";
    this.baseArgs = options.baseArgs ?? [];
    this.env = options.env ?? {};
  }

  protected async spawnAgent(input: SpawnInput) {
    const args = ["-p", input.prompt, "--output-format", "stream-json", ...this.baseArgs];

    const sessionId =
      input.metadata.geminiSessionId ??
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
      if (record.type === "message" && record.role === "assistant") {
        const text = this.extractText(record.content);
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

      const stats = record.stats;
      if (!stats || typeof stats !== "object") {
        continue;
      }

      const statsRecord = stats as Record<string, unknown>;
      return this.createUsage({
        inputTokens: typeof statsRecord.input_tokens === "number" ? statsRecord.input_tokens : null,
        outputTokens: typeof statsRecord.output_tokens === "number" ? statsRecord.output_tokens : null,
        cachedInputTokens: typeof statsRecord.cached === "number" ? statsRecord.cached : null,
        totalTokens: typeof statsRecord.total_tokens === "number" ? statsRecord.total_tokens : null,
      });
    }

    return null;
  }
}
