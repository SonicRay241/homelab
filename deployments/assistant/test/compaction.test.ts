import { describe, expect, it } from "bun:test";
import type { Message } from "@mariozechner/pi-ai";
import type { AssistantConfig } from "../src/config.ts";
import { compactMessages, compactionTokenThreshold, splitUnits } from "../src/compaction.ts";

const user = (text: string, timestamp = 0): Message => ({ role: "user", content: text, timestamp });

const assistant = (text: string, timestamp = 0): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-completions",
  provider: "test",
  model: "test",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop",
  timestamp,
});

const long = (text: string) => `${text} ${"x".repeat(3_000)}`;

const history: Message[] = [
  user(long("u1")),
  assistant(long("a1")),
  user(long("u2")),
  assistant(long("a2")),
  user(long("u3")),
  assistant(long("a3")),
  user(long("u4")),
  assistant(long("a4")),
];

function config(overrides: Partial<AssistantConfig> = {}): AssistantConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    apiUrl: "https://example/v1",
    apiKey: "key",
    modelId: "model",
    modelIds: ["model"],
    contextWindow: 1_000,
    maxTokens: 100,
    vision: false,
    maxInputTokens: 0,
    compactionThreshold: 0.75,
    compactionKeepTurns: 2,
    basedir: "/tmp",
    agentsDir: "/tmp/agents",
    agentDir: "/tmp/agent",
    agentId: "default",
    allowedUsers: [],
    deniedUsers: [],
    otel: null,
    reasoningEffort: "off",
    allowedReasoningEfforts: [],
    infisical: { baseUrl: "x", clientId: "x", clientSecret: "x", projectId: "x", environment: "prod", secretPath: "/" },
    refreshMs: 60_000,
    staticKeys: new Map(),
    ...overrides,
  };
}

describe("splitUnits", () => {
  it("keeps a user turn and its assistant/tool messages together", () => {
    const toolCall: Message = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      api: "openai-completions",
      provider: "test",
      model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: 0,
    };
    const toolResult: Message = {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      content: [{ type: "text", text: "contents" }],
      isError: false,
      timestamp: 0,
    };
    const units = splitUnits([user("u1"), toolCall, toolResult, assistant("done"), user("u2")]);
    expect(units.map((unit) => unit.length)).toEqual([4, 1]);
  });
});

describe("compactMessages", () => {
  it("summarizes older units and keeps the recent tail", async () => {
    const result = await compactMessages({
      systemPrompt: "",
      messages: history,
      tools: [],
      keepTurns: 2,
      thresholdTokens: 1,
      summarizer: async () => "SUMMARY",
    });
    expect(result.compacted).toBe(true);
    expect(result.droppedMessages).toBe(4);
    expect(result.messages).toHaveLength(5);
    expect(result.messages[0]?.role).toBe("user");
    expect(String(result.messages[0]?.content)).toContain("SUMMARY");
    expect(result.messages.slice(1)).toEqual(history.slice(-4));
    expect(result.afterTokens).toBeLessThan(result.beforeTokens);
  });

  it("falls back to a deterministic digest when the summarizer fails", async () => {
    const result = await compactMessages({
      systemPrompt: "",
      messages: history,
      tools: [],
      keepTurns: 1,
      thresholdTokens: 1,
      summarizer: async () => {
        throw new Error("model down");
      },
    });
    expect(result.compacted).toBe(true);
    expect(String(result.messages[0]?.content)).toContain("u1");
  });

  it("leaves the transcript alone when under threshold or disabled", async () => {
    const under = await compactMessages({
      systemPrompt: "",
      messages: history,
      tools: [],
      keepTurns: 2,
      thresholdTokens: 1_000_000,
      summarizer: async () => "SUMMARY",
    });
    expect(under.compacted).toBe(false);
    expect(under.messages).toBe(history);

    const disabled = await compactMessages({
      systemPrompt: "",
      messages: history,
      tools: [],
      keepTurns: 2,
      thresholdTokens: 0,
      summarizer: async () => "SUMMARY",
    });
    expect(disabled.compacted).toBe(false);
  });

  it("does not compact when there are not enough turns", async () => {
    const result = await compactMessages({
      systemPrompt: "",
      messages: [user("u1"), assistant("a1")],
      tools: [],
      keepTurns: 2,
      thresholdTokens: 1,
      summarizer: async () => "SUMMARY",
    });
    expect(result.compacted).toBe(false);
  });
});

describe("compactionTokenThreshold", () => {
  it("uses the context fraction and respects the hard input limit", () => {
    expect(compactionTokenThreshold(config())).toBe(750);
    expect(compactionTokenThreshold(config({ maxInputTokens: 400 }))).toBe(400);
    expect(compactionTokenThreshold(config({ compactionThreshold: 0 }))).toBe(0);
  });
});
