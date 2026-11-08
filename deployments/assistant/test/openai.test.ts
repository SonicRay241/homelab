import { describe, expect, it } from "bun:test";
import { collectToolNames, convertInput, extractClientTools, outputFunctionCallItem, responseShape } from "../src/openai.ts";

describe("convertInput", () => {
  it("converts text, instructions, tool calls and their outputs", () => {
    const input = [
      { role: "system", content: [{ type: "input_text", text: "Be terse." }] },
      { role: "user", content: [{ type: "input_text", text: "weather?" }] },
      { type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"city":"Paris"}' },
      { type: "function_call", call_id: "call_2", name: "get_weather", arguments: '{"city":"Oslo"}' },
      { type: "function_call_output", call_id: "call_1", output: "sunny" },
      { type: "function_call_output", call_id: "call_2", output: "rain" },
    ];

    const converted = convertInput(input);
    expect(converted.instructions).toEqual(["Be terse."]);
    expect(converted.messages).toHaveLength(4);

    const [user, assistant, ...results] = converted.messages;
    expect(user?.role).toBe("user");
    if (assistant?.role !== "assistant") throw new Error("expected assistant");
    expect(assistant.content).toHaveLength(2);
    expect(assistant.content[0]).toMatchObject({ type: "toolCall", id: "call_1", name: "get_weather" });

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ role: "toolResult", toolCallId: "call_1", toolName: "get_weather" });
    expect(results[1]).toMatchObject({ role: "toolResult", toolCallId: "call_2", toolName: "get_weather" });
  });

  it("resolves tool names from a previous transcript", () => {
    const previous = convertInput("hi").messages;
    const names = collectToolNames([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_9", name: "lookup", arguments: {} }],
        api: "openai-completions",
        provider: "test",
        model: "test",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse",
        timestamp: 0,
      },
      ...previous,
    ]);
    const converted = convertInput([{ type: "function_call_output", call_id: "call_9", output: "ok" }], names);
    expect(converted.messages[0]).toMatchObject({ role: "toolResult", toolName: "lookup" });
  });

  it("merges replayed assistant text and tool calls", () => {
    const converted = convertInput([
      { role: "assistant", content: [{ type: "output_text", text: "checking" }] },
      { type: "function_call", call_id: "c1", name: "lookup", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "done" },
    ]);
    expect(converted.messages).toHaveLength(2);
    const [assistant] = converted.messages;
    if (assistant?.role !== "assistant") throw new Error("expected assistant");
    expect(assistant.content.map((part) => part.type)).toEqual(["text", "toolCall"]);
  });

  it("converts data-url images and drops remote images", () => {
    const converted = convertInput([
      {
        role: "user",
        content: [
          { type: "input_text", text: "what is this?" },
          { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
          { type: "input_image", image_url: "https://example.com/x.png" },
        ],
      },
    ]);
    const [message] = converted.messages;
    if (message?.role !== "user") throw new Error("expected user");
    expect(Array.isArray(message.content)).toBe(true);
    if (!Array.isArray(message.content)) throw new Error("expected parts");
    expect(message.content.map((part) => part.type)).toEqual(["text", "image"]);
  });
});

describe("extractClientTools", () => {
  it("accepts responses and chat-completions shapes", () => {
    const tools = extractClientTools([
      { type: "function", name: "a", description: "A", parameters: { type: "object", properties: {} } },
      { type: "function", function: { name: "b", description: "B" } },
      { type: "web_search" },
      { type: "function", name: "a" },
    ]);
    expect(tools.map((tool) => tool.name)).toEqual(["a", "b"]);
    expect(tools[1]?.parameters).toEqual({ type: "object", properties: {} });
  });
});

describe("responseShape", () => {
  it("hides usage while in progress and exposes it when completed", () => {
    const inProgress = responseShape({
      id: "resp_1",
      createdAt: 1,
      status: "in_progress",
      model: "m",
      output: [],
      usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 },
      instructions: "",
      tools: [],
      toolChoice: "auto",
      parallelToolCalls: true,
      temperature: 1,
      topP: 1,
      store: true,
      metadata: {},
    });
    expect(inProgress.usage).toBeNull();

    const item = outputFunctionCallItem("fc_1", "call_1", "lookup", { q: "x" });
    expect(item.arguments).toBe('{"q":"x"}');
  });
});
