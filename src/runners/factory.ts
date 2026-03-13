import { AgentKind, AgentQueueStore, AgentRunner } from "../types/agent-types";
import { ClaudeRunner } from "./claude-runner";
import { CodexRunner } from "./codex-runner";
import { CursorRunner } from "./cursor-runner";
import { GeminiRunner } from "./gemini-runner";

export type RunnerFactory = (store: AgentQueueStore, passthroughArgs: string[]) => AgentRunner;

export const RUNNER_FACTORIES: Record<AgentKind, RunnerFactory> = {
  claude: (store, passthroughArgs) =>
    new ClaudeRunner(store, {
      baseArgs: passthroughArgs,
    }),
  codex: (store, passthroughArgs) =>
    new CodexRunner(store, {
      baseArgs: passthroughArgs,
    }),
  cursor: (store, passthroughArgs) =>
    new CursorRunner(store, {
      baseArgs: passthroughArgs,
    }),
  gemini: (store, passthroughArgs) =>
    new GeminiRunner(store, {
      baseArgs: passthroughArgs,
    }),
};

export function createRunner(
  kind: AgentKind,
  store: AgentQueueStore,
  passthroughArgs: string[] = [],
): AgentRunner {
  return RUNNER_FACTORIES[kind](store, passthroughArgs);
}
