import { describe, expect, it } from "vitest";

import { ClaudeRunner } from "../src/runners/claude-runner";
import { CodexRunner } from "../src/runners/codex-runner";
import { CursorRunner } from "../src/runners/cursor-runner";
import { GeminiRunner } from "../src/runners/gemini-runner";
import type { AgentQueueStore } from "../src/types/agent-types";

class NoopStore implements AgentQueueStore {
  public async enqueue(): Promise<void> {}
  public async claimNextQueued() {
    return null;
  }
  public async markState(): Promise<void> {}
  public async attachPid(): Promise<void> {}
  public async finish(): Promise<void> {}
  public async mergeMetadata(): Promise<void> {}
  public async getQueueCounts() {
    return { queued: 0, active: 0 };
  }
  public async getLatestByThreadId() {
    return null;
  }
  public async appendOutput(): Promise<void> {}
}

describe("provider output parsing", () => {
  const store = new NoopStore();

  it("parses Codex final message and usage", () => {
    const runner = new CodexRunner(store);
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "t1" }),
      JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "hi" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 3, output_tokens: 2 } }),
    ].join("\n");

    expect(runner.extractFinalMessage(stdout)).toBe("hi");
    expect(runner.extractUsage(stdout)).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      cachedInputTokens: 3,
      cacheWriteTokens: null,
      totalTokens: null,
      costUsd: null,
    });
  });

  it("parses Claude final message and usage", () => {
    const runner = new ClaudeRunner(store);
    const stdout = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "hi",
        total_cost_usd: 0.12,
        usage: {
          input_tokens: 100,
          output_tokens: 25,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 40,
        },
      }),
    ].join("\n");

    expect(runner.extractFinalMessage(stdout)).toBe("hi");
    expect(runner.extractUsage(stdout)).toEqual({
      inputTokens: 100,
      outputTokens: 25,
      cachedInputTokens: 70,
      cacheWriteTokens: null,
      totalTokens: 125,
      costUsd: 0.12,
    });
  });

  it("parses Cursor final message and usage", () => {
    const runner = new CursorRunner(store);
    const stdout = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "\nhi" }] } }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "\nhi",
        usage: {
          inputTokens: 50,
          outputTokens: 5,
          cacheReadTokens: 12,
          cacheWriteTokens: 7,
        },
      }),
    ].join("\n");

    expect(runner.extractFinalMessage(stdout)).toBe("hi");
    expect(runner.extractUsage(stdout)).toEqual({
      inputTokens: 50,
      outputTokens: 5,
      cachedInputTokens: 12,
      cacheWriteTokens: 7,
      totalTokens: 55,
      costUsd: null,
    });
  });

  it("parses Gemini final message and usage", () => {
    const runner = new GeminiRunner(store);
    const stdout = [
      "Warning: noisy prelude",
      JSON.stringify({ type: "message", role: "assistant", content: "hi", delta: true }),
      JSON.stringify({
        type: "result",
        status: "success",
        stats: {
          total_tokens: 75,
          input_tokens: 60,
          output_tokens: 15,
          cached: 9,
        },
      }),
    ].join("\n");

    expect(runner.extractFinalMessage(stdout)).toBe("hi");
    expect(runner.extractUsage(stdout)).toEqual({
      inputTokens: 60,
      outputTokens: 15,
      cachedInputTokens: 9,
      cacheWriteTokens: null,
      totalTokens: 75,
      costUsd: null,
    });
  });
});
