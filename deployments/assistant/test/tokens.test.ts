import { describe, expect, it } from "bun:test";
import type { Message, Tool } from "@mariozechner/pi-ai";
import { estimateInputTokens, estimateMessageTokens, estimateToolTokens } from "../src/tokens.ts";

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });

describe("token estimates", () => {
  it("uses the 4-chars-per-token heuristic for the system prompt", () => {
    expect(estimateInputTokens("", [], [])).toBe(0);
    expect(estimateInputTokens("x".repeat(400), [], [])).toBe(100);
  });

  it("counts messages and per-message overhead", () => {
    expect(estimateMessageTokens(user("x".repeat(400)))).toBe(104);
    expect(estimateInputTokens("", [user("x".repeat(400)), user("x".repeat(400))], [])).toBe(208);
  });

  it("counts tool schemas", () => {
    const tool: Tool = {
      name: "lookup",
      description: "Look something up",
      parameters: { type: "object", properties: { q: { type: "string" } } },
    };
    expect(estimateToolTokens([])).toBe(0);
    expect(estimateToolTokens([tool])).toBeGreaterThan(0);
    expect(estimateInputTokens("", [], [tool])).toBe(estimateToolTokens([tool]));
  });

  it("counts images at a fixed estimate instead of their base64 length", () => {
    const message: Message = {
      role: "user",
      content: [{ type: "image", data: "a".repeat(400_000), mimeType: "image/png" }],
      timestamp: 0,
    };
    expect(estimateMessageTokens(message)).toBe(1_004);
  });
});
