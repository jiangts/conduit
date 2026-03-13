import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { AbstractAgentRunner } from "../src/abstract-agent-runner";
import type { AgentQueueStore, SpawnInput } from "../src/types/agent-types";

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

class TestRunner extends AbstractAgentRunner {
  public readonly kind = "codex" as const;

  public constructor(store: AgentQueueStore) {
    super(store);
  }

  protected async spawnAgent(_input: SpawnInput) {
    const child = new EventEmitter() as never;
    return child;
  }
}

class DrainingStore extends NoopStore {
  private readonly firstClaim = Promise.resolve({
    id: "queue-1",
    threadId: "thread-1",
    prompt: "hi",
    workingDirectory: process.cwd(),
    metadata: {},
    state: "queued" as const,
  });

  public claimNextQueued = vi
    .fn<() => Promise<Awaited<ReturnType<AgentQueueStore["claimNextQueued"]>>>>()
    .mockImplementationOnce(() => this.firstClaim)
    .mockImplementationOnce(async () => null);

  public async markState(): Promise<void> {}
  public async attachPid(): Promise<void> {}
  public async finish(): Promise<void> {}
}

class ImmediateExitRunner extends AbstractAgentRunner {
  public readonly kind = "codex" as const;

  public constructor(store: AgentQueueStore) {
    super(store);
  }

  protected async spawnAgent(_input: SpawnInput) {
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stdout: null;
      stderr: null;
      once: typeof EventEmitter.prototype.once;
    };
    child.pid = 123;
    child.stdout = null;
    child.stderr = null;
    setTimeout(() => {
      child.emit("exit", 0, null);
    }, 0);
    return child as never;
  }
}

describe("AbstractAgentRunner.extractFinalMessage", () => {
  const runner = new TestRunner(new NoopStore());

  it("returns trimmed plain text stdout", () => {
    expect(runner.extractFinalMessage("  final answer  \n")).toBe("final answer");
  });

  it("returns the last result-like field from JSONL stdout", () => {
    const stdout = [
      JSON.stringify({ type: "status", message: "thinking" }),
      JSON.stringify({ type: "result", result: "final answer" }),
    ].join("\n");

    expect(runner.extractFinalMessage(stdout)).toBe("final answer");
  });

  it("extracts nested message content from JSON payloads", () => {
    const stdout = JSON.stringify({
      type: "response.completed",
      data: {
        content: [
          { type: "text", text: "final answer" },
        ],
      },
    });

    expect(runner.extractFinalMessage(stdout)).toBe("final answer");
  });

  it("ignores non-json lines and falls back to the raw stdout body", () => {
    const stdout = "first line\nnot-json\nsecond line";

    expect(runner.extractFinalMessage(stdout)).toBe("first line\nnot-json\nsecond line");
  });

  it("returns null for empty stdout", () => {
    expect(runner.extractFinalMessage(" \n\t")).toBeNull();
  });
});

describe("AbstractAgentRunner.awaitIdle", () => {
  it("waits for the drain loop to finish after process exit", async () => {
    const store = new DrainingStore();
    const runner = new ImmediateExitRunner(store);

    await runner.run("hi");
    await runner.awaitIdle();

    expect(store.claimNextQueued).toHaveBeenCalledTimes(2);
  });
});
