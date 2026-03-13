import process from "node:process";

import { buildFinalMessagePreview, buildUsageSummary, persistChatOutputs } from "../chat/outputs";
import { resolveEffectiveRunnerArgs } from "../config";
import { createRunner, SqliteAgentQueueStore } from "../index";
import type { AgentKind, ExitEvent } from "../types/agent-types";
import type { ConduitConfig } from "../config";
import type { RunnerRef } from "../types/run-types";

interface OutputWriter {
  write(chunk: string): unknown;
}

export interface ChatCommandArgs {
  prompt: string;
  runner: RunnerRef;
  resume?: string;
  cwd: string;
  db: string;
  passthroughArgs: string[];
}

export async function runChatCommand(
  args: ChatCommandArgs,
  config: ConduitConfig,
  streams: { stdout: OutputWriter; stderr: OutputWriter },
): Promise<number> {
  const effectiveRunnerArgs = resolveEffectiveRunnerArgs(config, args.runner.provider as AgentKind, args.passthroughArgs);
  const store = new SqliteAgentQueueStore(args.db);
  const runner = createRunner(args.runner.provider as AgentKind, store, effectiveRunnerArgs);

  try {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let queueItemId: string | null = null;
    let threadId: string | null = null;
    const exit = await new Promise<ExitEvent>((resolve, reject) => {
      void runner
        .run(args.prompt, {
          workingDirectory: args.cwd,
          resumeThreadId: args.resume,
          metadata: {
            ...(args.resume
              ? {
                  sessionId: args.resume,
                }
              : {}),
            ...(args.runner.model
              ? {
                  requestedModel: args.runner.model,
                }
              : {}),
          },
          callbacks: {
            onQueued: (event) => {
              threadId = event.threadId;
              queueItemId = event.queueItemId;
            },
            onStdout: (event) => {
              stdoutChunks.push(event.chunk);
              streams.stdout.write(`${event.chunk}\n`);
            },
            onStderr: (event) => {
              stderrChunks.push(event.chunk);
              streams.stderr.write(`${event.chunk}\n`);
            },
            onError: (event) => {
              reject(event.error);
            },
            onExit: (event) => {
              resolve(event);
            },
          },
        })
        .catch(reject);
    });

    const stdout = stdoutChunks.join("\n");
    const stderr = stderrChunks.join("\n");
    const finalMessage = runner.extractFinalMessage(stdout);
    const usage = runner.extractUsage(stdout);

    if (threadId && queueItemId) {
      const outputs = await persistChatOutputs({
        stateDir: config.stateDir,
        threadId,
        queueItemId,
        prompt: args.prompt,
        stdout,
        stderr,
        finalMessage,
        usage,
        exit,
      });
      await store.mergeMetadata(queueItemId, {
        finalOutputPath: outputs.finalOutputPath ?? "",
        finalMessagePreview: buildFinalMessagePreview(finalMessage) ?? "",
        resultOutputPath: outputs.resultOutputPath,
        outputDir: outputs.outputDir,
        usageSummary: buildUsageSummary(usage) ?? "",
      });
    }

    if (exit.finalState === "cancelled") {
      return 130;
    }
    return exit.code ?? 0;
  } finally {
    await runner.awaitIdle?.();
    store.close();
  }
}
