import { describe, expect, it } from "bun:test";
import { modelMetadata, modelReasoningMetadata } from "../src/model.ts";
import { normalizeReasoningEffort, piThinkingLevel, type ReasoningEffort } from "../src/config.ts";

function config(reasoningEffort: ReasoningEffort, allowedReasoningEfforts: ReasoningEffort[]) {
  return { reasoningEffort, allowedReasoningEfforts };
}

const limits = { contextWindow: 128_000, maxTokens: 8_192 };

describe("reasoning effort aliases", () => {
  it("accepts max and maps it to pi's xhigh", () => {
    expect(normalizeReasoningEffort("max")).toBe("max");
    expect(piThinkingLevel("max")).toBe("xhigh");
    expect(piThinkingLevel("high")).toBe("high");
    expect(piThinkingLevel("off")).toBe("off");
  });
});

describe("modelReasoningMetadata", () => {
  it("advertises the configured ladder and default", () => {
    expect(modelReasoningMetadata(config("medium", ["low", "medium", "high"]))).toEqual({
      supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }],
      default_reasoning_level: "medium",
    });
  });

  it("includes none only when thinking off is allowed", () => {
    expect(modelReasoningMetadata(config("off", ["low", "high"])).supported_reasoning_levels).toEqual([
      { effort: "none" },
      { effort: "low" },
      { effort: "high" },
    ]);
    expect(
      modelReasoningMetadata(config("high", ["high"])).supported_reasoning_levels,
    ).toEqual([{ effort: "high" }]);
  });

  it("omits the ladder for a non-reasoning agent", () => {
    expect(modelReasoningMetadata(config("off", []))).toEqual({});
  });

  it("advertises max as the top tier", () => {
    expect(modelReasoningMetadata(config("high", ["high", "max"]))).toEqual({
      supported_reasoning_levels: [{ effort: "high" }, { effort: "max" }],
      default_reasoning_level: "high",
    });
  });

  it("reports context window and output cap", () => {
    expect(modelMetadata({ ...config("off", []), ...limits })).toEqual({
      context_length: 128_000,
      max_output_tokens: 8_192,
    });
    expect(modelMetadata({ ...config("low", ["low", "max"]), ...limits })).toMatchObject({
      context_length: 128_000,
      max_output_tokens: 8_192,
      default_reasoning_level: "low",
    });
  });

  it("does not advertise a default outside the ladder", () => {
    // The default is always part of the effort list by construction.
    const metadata = modelReasoningMetadata(config("off", ["low"]));
    expect(metadata.default_reasoning_level).toBeUndefined();
    expect(metadata.supported_reasoning_levels).toEqual([{ effort: "none" }, { effort: "low" }]);
  });
});
