import { describe, expect, it } from "bun:test";
import { normalizeReasoningEffort, type ReasoningEffort } from "../src/config.ts";
import {
  isReasoningEffortAllowed,
  reasoningEffortsForConfig,
  requestReasoningEffort,
} from "../src/runner.ts";

describe("reasoning effort parsing", () => {
  it("accepts Responses reasoning objects, legacy fields and none", () => {
    expect(requestReasoningEffort({ reasoning: { effort: "high" } })).toBe("high");
    expect(requestReasoningEffort({ reasoning_effort: "LOW" })).toBe("low");
    expect(requestReasoningEffort({ reasoning: { effort: "none" } })).toBe("off");
    expect(requestReasoningEffort({ reasoning: { effort: null } })).toBeUndefined();
    expect(requestReasoningEffort({})).toBeUndefined();
    expect(normalizeReasoningEffort("off")).toBe("off");
    expect(normalizeReasoningEffort("turbo")).toBeUndefined();
  });

  it("rejects malformed effort values", () => {
    expect(() => requestReasoningEffort({ reasoning: { effort: 3 } })).toThrow("must be a string");
    expect(() => requestReasoningEffort({ reasoning_effort: "turbo" })).toThrow("must be one of");
  });
});

describe("reasoning effort allowlist", () => {
  it("always permits the configured default and only listed alternatives", () => {
    const config: { reasoningEffort: ReasoningEffort; allowedReasoningEfforts: ReasoningEffort[] } = {
      reasoningEffort: "off",
      allowedReasoningEfforts: ["low", "high"],
    };
    expect(reasoningEffortsForConfig(config)).toEqual(["off", "low", "high"]);
    expect(isReasoningEffortAllowed(config, "off")).toBe(true);
    expect(isReasoningEffortAllowed(config, "high")).toBe(true);
    expect(isReasoningEffortAllowed(config, "medium")).toBe(false);
  });

  it("allows only the default when no alternatives are configured", () => {
    const config = { reasoningEffort: "medium" as const, allowedReasoningEfforts: [] };
    expect(isReasoningEffortAllowed(config, "medium")).toBe(true);
    expect(isReasoningEffortAllowed(config, "off")).toBe(false);
    expect(isReasoningEffortAllowed(config, "high")).toBe(false);
  });
});
