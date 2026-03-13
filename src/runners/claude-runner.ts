import { spawn } from "node:child_process";

import { AbstractAgentRunner, AgentRunnerInitOptions } from "../abstract-agent-runner";
import { AgentQueueStore, AgentRunUsage, SpawnInput } from "../types/agent-types";

export interface ClaudeRunnerOptions extends AgentRunnerInitOptions {
  command?: string;
  baseArgs?: string[];
  includePartialMessages?: boolean;
  verbose?: boolean;
  env?: NodeJS.ProcessEnv;
}

export class ClaudeRunner extends AbstractAgentRunner {
  public readonly kind = "claude" as const;

  private readonly command: string;
  private readonly baseArgs: string[];
  private readonly includePartialMessages: boolean;
  private readonly verbose: boolean;
  private readonly env: NodeJS.ProcessEnv;

  public constructor(store: AgentQueueStore, options: ClaudeRunnerOptions = {}) {
    super(store, options);
    this.command = options.command ?? "claude";
    this.baseArgs = options.baseArgs ?? [];
    this.includePartialMessages = options.includePartialMessages ?? true;
    this.verbose = options.verbose ?? true;
    this.env = options.env ?? {};
  }

  protected async spawnAgent(input: SpawnInput) {
    const args = ["-p", input.prompt, "--output-format", "stream-json", ...this.baseArgs];
    if (this.verbose) args.push("--verbose");
    if (this.includePartialMessages) args.push("--include-partial-messages");

    const sessionId =
      input.metadata.claudeSessionId ??
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
      return this.extractUsageFromRecord(usage, record.total_cost_usd);
    }

    return null;
  }

  private extractUsageFromRecord(value: unknown, totalCostUsd: unknown): AgentRunUsage | null {
    if (!value || typeof value !== "object") {
      return this.createUsage({
        costUsd: typeof totalCostUsd === "number" ? totalCostUsd : null,
      });
    }

    const usage = value as Record<string, unknown>;
    const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : null;
    const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : null;
    const cacheCreation = typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : null;
    const cacheRead = typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : null;

    return this.createUsage({
      inputTokens,
      outputTokens,
      cachedInputTokens:
        cacheCreation !== null || cacheRead !== null
          ? (cacheCreation ?? 0) + (cacheRead ?? 0)
          : null,
      totalTokens: inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null,
      costUsd: typeof totalCostUsd === "number" ? totalCostUsd : null,
    });
  }
}
