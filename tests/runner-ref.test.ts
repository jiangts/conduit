import { describe, expect, it } from "vitest";

import { parseRunnerRef } from "../src/cli/runner-ref";

describe("parseRunnerRef", () => {
  it("parses a provider-only runner", () => {
    expect(parseRunnerRef("codex")).toEqual({
      provider: "codex",
      model: null,
    });
  });

  it("parses an inline provider/model runner", () => {
    expect(parseRunnerRef("codex/gpt-5")).toEqual({
      provider: "codex",
      model: "gpt-5",
    });
  });

  it("uses the compatibility model option when no inline model is provided", () => {
    expect(parseRunnerRef("codex", { model: "gpt-5" })).toEqual({
      provider: "codex",
      model: "gpt-5",
    });
  });

  it("rejects specifying the model twice", () => {
    expect(() => parseRunnerRef("codex/gpt-5", { model: "gpt-5-mini" })).toThrow(
      "Specify runner model either in --runner or --model, not both",
    );
  });
});
