import { describe, expect, it } from "bun:test";
import { modelReasoningMetadata } from "../src/model.ts";
import type { ReasoningEffort } from "../src/config.ts";

function config(reasoningEffort: ReasoningEffort, allowedReasoningEfforts: ReasoningEffort[]) {
  return { reasoningEffort, allowedReasoningEfforts };
}

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

  it("does not advertise a default outside the ladder", () => {
    // The default is always part of the effort list by construction.
    const metadata = modelReasoningMetadata(config("off", ["low"]));
    expect(metadata.default_reasoning_level).toBeUndefined();
    expect(metadata.supported_reasoning_levels).toEqual([{ effort: "none" }, { effort: "low" }]);
  });
});
