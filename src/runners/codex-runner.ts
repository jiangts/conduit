import { spawn } from "node:child_process";

import { AbstractAgentRunner, AgentRunnerInitOptions } from "../abstract-agent-runner";
import { AgentQueueStore, AgentRunUsage, OutputStream, SpawnInput } from "../types/agent-types";

export interface CodexRunnerOptions extends AgentRunnerInitOptions {
  command?: string;
  baseArgs?: string[];
  verbose?: boolean;
  ignoreSnapshotValidationErrors?: boolean;
  env?: NodeJS.ProcessEnv;
}

export class CodexRunner extends AbstractAgentRunner {
  public readonly kind = "codex" as const;

  private readonly command: string;
  private readonly baseArgs: string[];
  private readonly verbose: boolean;
  private readonly ignoreSnapshotValidationErrors: boolean;
  private readonly env: NodeJS.ProcessEnv;

  public constructor(store: AgentQueueStore, options: CodexRunnerOptions = {}) {
    super(store, options);
    this.command = options.command ?? "codex";
    this.baseArgs = options.baseArgs ?? [];
    this.verbose = options.verbose ?? false;
    this.ignoreSnapshotValidationErrors = options.ignoreSnapshotValidationErrors ?? true;
    this.env = options.env ?? {};
  }

  protected async spawnAgent(input: SpawnInput) {
    const sessionId =
      input.metadata.codexSessionId ??
      input.metadata.sessionId ??
      input.metadata.resumeSessionId ??
      input.metadata.providerThreadId;

    const args = sessionId
      ? ["exec", "resume", "--json", sessionId, input.prompt, ...this.baseArgs]
      : ["exec", "--json", input.prompt, ...this.baseArgs];

    if (this.verbose) {
      process.stderr.write(`[codex-runner] ${this.command} ${args.join(" ")}\n`);
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

  protected shouldEmitOutput(stream: OutputStream, chunk: string): boolean {
    if (stream !== "stderr" || !this.ignoreSnapshotValidationErrors) {
      return true;
    }

    // Codex can emit host-specific shell snapshot validation noise on startup.
    // Suppress only the known diagnostic lines so real failures still surface.
    if (chunk.includes("codex_core::shell_snapshot")) {
      return false;
    }
    if (chunk.includes(".codex/shell_snapshots/") && chunk.includes("syntax error near unexpected token `|'")) {
      return false;
    }
    return true;
  }

  public extractFinalMessage(stdout: string): string | null {
    let finalMessage: string | null = null;

    for (const event of this.parseJsonLines(stdout)) {
      if (!event || typeof event !== "object") {
        continue;
      }

      const record = event as Record<string, unknown>;
      if (record.type !== "item.completed") {
        continue;
      }

      const item = record.item;
      if (!item || typeof item !== "object") {
        continue;
      }

      const itemRecord = item as Record<string, unknown>;
      if (itemRecord.type !== "agent_message") {
        continue;
      }

      const text = this.extractText(itemRecord.text);
      if (text !== null) {
        finalMessage = text;
      }
    }

    return finalMessage ?? super.extractFinalMessage(stdout);
  }

  public extractUsage(stdout: string): AgentRunUsage | null {
    for (const event of this.parseJsonLines(stdout)) {
      if (!event || typeof event !== "object") {
        continue;
      }

      const record = event as Record<string, unknown>;
      if (record.type !== "turn.completed") {
        continue;
      }

      const usage = record.usage;
      if (!usage || typeof usage !== "object") {
        continue;
      }

      const usageRecord = usage as Record<string, unknown>;
      return this.createUsage({
        inputTokens: typeof usageRecord.input_tokens === "number" ? usageRecord.input_tokens : null,
        outputTokens: typeof usageRecord.output_tokens === "number" ? usageRecord.output_tokens : null,
        cachedInputTokens: typeof usageRecord.cached_input_tokens === "number" ? usageRecord.cached_input_tokens : null,
      });
    }

    return null;
  }
}
