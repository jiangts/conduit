import type { AgentKind } from "../types/agent-types";
import type { RunnerRef } from "../types/run-types";

const RUNNER_KINDS = new Set<AgentKind>(["claude", "codex", "cursor", "gemini"]);

function isAgentKind(value: string): value is AgentKind {
  return RUNNER_KINDS.has(value as AgentKind);
}

export function parseRunnerRef(value: string, options?: { model?: string | undefined }): RunnerRef {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    throw new Error("Runner cannot be empty");
  }

  const match = /^(claude|codex|cursor|gemini)(?:[/:](.+))?$/.exec(trimmedValue);
  if (!match) {
    throw new Error(`Unsupported runner provider "${trimmedValue}"`);
  }

  const provider = match[1];
  const inlineModel = match[2] ?? null;
  const optionModel = options?.model?.trim();

  if (!isAgentKind(provider)) {
    throw new Error(`Unsupported runner provider "${provider}"`);
  }
  if (inlineModel !== null && inlineModel.length === 0) {
    throw new Error("Runner model cannot be empty");
  }
  if (inlineModel !== null && optionModel) {
    throw new Error("Specify runner model either in --runner or --model, not both");
  }

  return {
    provider,
    model: inlineModel ?? optionModel ?? null,
  };
}
