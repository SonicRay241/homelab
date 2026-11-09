import { afterAll, describe, expect, it } from "bun:test";
import { streamSimpleOpenAICompletions, type Model } from "@mariozechner/pi-ai";

let captured: Record<string, unknown> | undefined;

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 });
    captured = (await req.json()) as Record<string, unknown>;
    const chunk = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
    const body =
      chunk({
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: 0,
        model: "fake",
        choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }],
      }) +
      chunk({
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: 0,
        model: "fake",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }) +
      "data: [DONE]\n\n";
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  },
});

const model: Model<"openai-completions"> = {
  id: "fake",
  name: "fake",
  api: "openai-completions",
  provider: "assistant-backend",
  baseUrl: `http://127.0.0.1:${server.port}/v1`,
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000,
  maxTokens: 100,
  compat: {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: true,
    supportsUsageInStreaming: true,
    maxTokensField: "max_tokens",
    requiresToolResultName: false,
    requiresAssistantAfterToolResult: false,
    requiresThinkingAsText: false,
    supportsStrictMode: false,
    thinkingFormat: "openai",
  },
};

const context = { systemPrompt: "", messages: [{ role: "user" as const, content: "hi", timestamp: 0 }] };

afterAll(() => server.stop(true));

describe("reasoning payload", () => {
  it("sends reasoning_effort when a level is selected and omits it when off", async () => {
    const high = streamSimpleOpenAICompletions(model, context, {
      apiKey: "test",
      reasoning: "high",
      maxTokens: 10,
    });
    for await (const _event of high) {
      // consume
    }
    expect(captured?.reasoning_effort).toBe("high");

    captured = undefined;
    const off = streamSimpleOpenAICompletions(model, context, {
      apiKey: "test",
      maxTokens: 10,
    });
    for await (const _event of off) {
      // consume
    }
    expect((captured as Record<string, unknown> | undefined)?.reasoning_effort).toBeUndefined();
  });
});
