import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@mariozechner/pi-ai";
import type { AssistantConfig } from "../src/config.ts";
import { HandoffStore } from "../src/handoffs.ts";
import {
  ChatCompletionStream,
  chatCompletionShape,
  chatRequestToResponses,
  convertInput,
  extractClientTools,
} from "../src/openai.ts";
import { runResponse } from "../src/runner.ts";
import { SessionStore } from "../src/sessions.ts";

const captured: Record<string, unknown>[] = [];
type BackendMode = "text" | "tool" | "reasoning";
let backendMode: BackendMode = "text";

function chunk(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function delta(value: Record<string, unknown>, finish: string | null = null, usage?: Record<string, unknown>): string {
  return chunk({
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 0,
    model: "fake",
    choices: [{ index: 0, delta: value, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  });
}

const backend = Bun.serve({
  port: 0,
  async fetch(req) {
    if (new URL(req.url).pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 });
    captured.push((await req.json()) as Record<string, unknown>);
    const usage = { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 };
    const parts: string[] = [];
    if (backendMode === "tool") {
      parts.push(
        delta({
          tool_calls: [
            { index: 0, id: "call_new", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } },
          ],
        }),
      );
      parts.push(delta({}, "tool_calls", usage));
    } else if (backendMode === "reasoning") {
      parts.push(delta({ reasoning_content: "think " }));
      parts.push(delta({ reasoning_content: "more" }));
      parts.push(delta({ content: "answer" }));
      parts.push(delta({}, "stop", usage));
    } else {
      parts.push(delta({ content: "ok" }));
      parts.push(delta({}, "stop", usage));
    }
    parts.push("data: [DONE]\n\n");
    return new Response(parts.join(""), { headers: { "content-type": "text/event-stream" } });
  },
});

const model: Model<"openai-completions"> = {
  id: "fake",
  name: "fake",
  api: "openai-completions",
  provider: "assistant-backend",
  baseUrl: `http://127.0.0.1:${backend.port}/v1`,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
  compat: {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    supportsUsageInStreaming: true,
    maxTokensField: "max_tokens",
    requiresToolResultName: false,
    requiresAssistantAfterToolResult: false,
    requiresThinkingAsText: false,
    supportsStrictMode: false,
    thinkingFormat: "openai",
  },
};

const dirs: string[] = [];
const stores: (SessionStore | HandoffStore)[] = [];

async function setup(): Promise<{ config: AssistantConfig; sessions: SessionStore; handoffs: HandoffStore }> {
  const root = await mkdtemp(join(tmpdir(), "assistant-chat-"));
  dirs.push(root);
  const agentDir = join(root, "agent");
  const sessions = new SessionStore(join(agentDir, "sessions.db"));
  const handoffs = new HandoffStore(join(agentDir, "handoffs.db"));
  stores.push(sessions, handoffs);
  const config: AssistantConfig = {
    port: 8787,
    hostname: "0.0.0.0",
    apiUrl: `http://127.0.0.1:${backend.port}/v1`,
    apiKey: "test",
    modelId: "fake",
    modelIds: ["fake"],
    contextWindow: 128_000,
    maxTokens: 8_192,
    vision: false,
    maxInputTokens: 0,
    compactionThreshold: 1,
    compactionKeepTurns: 6,
    memoryLimits: { memory: 2_200, user: 1_375 },
    basedir: root,
    agentsDir: join(root, "agents"),
    agentDir,
    agentId: "default",
    allowedUsers: [],
    deniedUsers: [],
    otel: null,
    reasoningEffort: "off",
    allowedReasoningEfforts: [],
    infisical: {
      baseUrl: "https://secrets.example",
      clientId: "id",
      clientSecret: "secret",
      projectId: "project",
      environment: "prod",
      secretPath: "/",
    },
    refreshMs: 60_000,
    staticKeys: new Map(),
  };
  return { config, sessions, handoffs };
}

/** Runs a chat completion and returns the raw SSE payload lines. */
async function streamChat(
  config: AssistantConfig,
  sessions: SessionStore,
  handoffs: HandoffStore,
  messages: unknown[],
  includeUsage = false,
): Promise<string[]> {
  const body = chatRequestToResponses({ model: "default", messages, stream: true });
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const sink = new ChatCompletionStream(controller, includeUsage);
      try {
        await runResponse({
          config,
          model,
          requestedModel: "default",
          userId: "alice",
          userHash: "hash",
          sessionStore: sessions,
          handoffStore: handoffs,
          agentIds: ["default"],
          knownUsers: [],
          mcpTools: [],
          body,
          trace: "no",
          sse: sink,
        });
      } finally {
        sink.close();
      }
    },
  });
  const text = await new Response(stream).text();
  return text.split("\n\n").filter(Boolean);
}

afterAll(() => backend.stop(true));

afterEach(async () => {
  backendMode = "text";
  for (const store of stores.splice(0)) store.close();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("chatRequestToResponses", () => {
  it("converts chat messages, tool calls, tool results, images and max_tokens", () => {
    const body = chatRequestToResponses({
      model: "default",
      max_tokens: 200,
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
      messages: [
        { role: "system", content: "Be terse." },
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
          ],
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "result" },
      ],
    });

    expect(body.max_output_tokens).toBe(200);
    expect(extractClientTools(body.tools).map((tool) => tool.name)).toEqual(["lookup"]);

    const converted = convertInput(body.input);
    expect(converted.instructions).toEqual(["Be terse."]);
    expect(converted.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);

    const [user, assistant] = converted.messages;
    if (user?.role !== "user" || !Array.isArray(user.content)) throw new Error("expected user parts");
    expect(user.content.map((part) => part.type)).toEqual(["text", "image"]);
    if (assistant?.role !== "assistant") throw new Error("expected assistant");
    expect(assistant.content[0]).toMatchObject({ type: "toolCall", id: "call_1", name: "lookup" });
  });

  it("drops empty content but keeps tool-call-only assistant turns", () => {
    const body = chatRequestToResponses({
      messages: [
        { role: "user", content: "" },
        { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "f", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: "ok" },
      ],
    });
    expect(body.input).toEqual([
      { type: "function_call", call_id: "c1", name: "f", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "ok" },
    ]);
  });

  it("never continues a stored session: chat clients replay the transcript", () => {
    const body = chatRequestToResponses({
      previous_response_id: "resp_old",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(body.previous_response_id).toBeUndefined();
  });
});

describe("chatCompletionShape", () => {
  it("projects text, client tool calls and usage into a chat completion", () => {
    const response = {
      id: "resp_abc",
      created_at: 42,
      status: "completed",
      model: "default",
      output: [
        {
          id: "msg_1",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "hi", annotations: [] }],
        },
        { id: "fc_1", type: "function_call", status: "completed", call_id: "call_1", name: "lookup", arguments: '{"q":"x"}' },
      ],
      usage: {
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 2 },
        output_tokens: 3,
        output_tokens_details: { reasoning_tokens: 1 },
        total_tokens: 13,
      },
    };

    expect(chatCompletionShape(response, "fallback")).toEqual({
      id: "chatcmpl-abc",
      object: "chat.completion",
      created: 42,
      model: "default",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "hi",
            tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } }],
          },
          finish_reason: "tool_calls",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 3,
        total_tokens: 13,
        prompt_tokens_details: { cached_tokens: 2 },
        completion_tokens_details: { reasoning_tokens: 1 },
      },
    });
  });
});

describe("ChatCompletionStream", () => {
  it("translates text and client tool calls, then emits finish, usage and [DONE]", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
    const sink = new ChatCompletionStream(controller, true);

    sink.send("response.created", { response: { id: "resp_1", model: "default" } });
    sink.send("response.output_text.delta", { delta: "hello" });
    sink.send("response.output_item.added", {
      output_index: 1,
      item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "lookup" },
    });
    sink.send("response.function_call_arguments.delta", { output_index: 1, delta: '{"q":"x"}' });
    sink.send("response.output_text.delta", { delta: " world" });
    sink.send("response.completed", {
      response: { usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } },
    });
    sink.close();

    const text = await new Response(stream).text();
    const data = text
      .split("\n\n")
      .filter(Boolean)
      .map((line) => line.replace(/^data: /, ""));

    expect(data.at(-1)).toBe("[DONE]");
    const events = data.slice(0, -1).map((line) => JSON.parse(line) as Record<string, any>);
    const choice = (index: number): Record<string, any> => events[index]!.choices[0];

    expect(events[0]).toMatchObject({
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      model: "default",
      choices: [{ index: 0, delta: { role: "assistant", content: "" } }],
    });
    expect(choice(1).delta).toEqual({ content: "hello" });
    expect(choice(2).delta.tool_calls[0]).toEqual({
      index: 0,
      id: "call_1",
      type: "function",
      function: { name: "lookup", arguments: "" },
    });
    expect(choice(3).delta).toEqual({ tool_calls: [{ index: 0, function: { arguments: '{"q":"x"}' } }] });
    expect(choice(4).delta).toEqual({ content: " world" });
    expect(choice(5)).toMatchObject({ delta: {}, finish_reason: "tool_calls" });
    expect(events[6]).toMatchObject({
      choices: [],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    });
  });

  it("omits usage unless stream_options.include_usage is set", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
    const sink = new ChatCompletionStream(controller);
    sink.send("response.created", { response: { id: "resp_1", model: "default" } });
    sink.send("response.completed", { response: { usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } });
    sink.close();
    const text = await new Response(stream).text();
    expect(text).not.toContain('"usage"');
  });
});

describe("chat completions through runResponse", () => {
  it("does not merge stored sessions into a replayed conversation", async () => {
    const { config, sessions, handoffs } = await setup();
    await streamChat(config, sessions, handoffs, [{ role: "user", content: "hi" }]);
    await streamChat(config, sessions, handoffs, [
      { role: "user", content: "hi" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "again" },
    ]);

    const second = captured.at(-1);
    if (!second || !Array.isArray(second.messages)) throw new Error("expected backend messages");
    const conversation = (second.messages as Record<string, unknown>[])
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => [message.role, message.content]);
    expect(conversation).toEqual([
      ["user", "hi"],
      ["assistant", "ok"],
      ["user", "again"],
    ]);
  });

  it("streams the chat chunk shape from a full run", async () => {
    const { config, sessions, handoffs } = await setup();
    const lines = await streamChat(config, sessions, handoffs, [{ role: "user", content: "hi" }], true);
    const data = lines.map((line) => line.replace(/^data: /, ""));
    expect(data[0]).toContain('"object":"chat.completion.chunk"');
    expect(data.join("\n")).toContain('"content":"ok"');
    expect(data.join("\n")).toContain('"finish_reason":"stop"');
    expect(data.at(-1)).toBe("[DONE]");
  });
});

describe("reasoning streaming", () => {
  it("emits reasoning items and reasoning_content for chat clients", async () => {
    const { config, sessions, handoffs } = await setup();
    backendMode = "reasoning";
    const events: { type: string; [key: string]: unknown }[] = [];
    const response = await runResponse({
      config,
      model,
      requestedModel: "default",
      userId: "alice",
      userHash: "hash",
      sessionStore: sessions,
      handoffStore: handoffs,
      agentIds: ["default"],
      knownUsers: [],
      mcpTools: [],
      body: { input: "hi" },
      trace: "no",
      sse: {
        send: (type, payload) => events.push({ type, ...payload }),
        close: () => {},
      },
    });

    const deltas = events.filter((event) => event.type === "response.reasoning_summary_text.delta");
    expect(deltas.map((event) => event.delta)).toEqual(["think ", "more"]);
    expect(events.some((event) => event.type === "response.reasoning_summary_text.done")).toBe(true);

    const output = Array.isArray(response.output) ? (response.output as Record<string, unknown>[]) : [];
    expect(output[0]).toMatchObject({
      type: "reasoning",
      summary: [{ type: "summary_text", text: "think more" }],
    });
    expect(output[1]).toMatchObject({ type: "message", content: [{ type: "output_text", text: "answer" }] });

    const chat = chatCompletionShape(response, "default") as {
      choices: { message: Record<string, unknown> }[];
    };
    expect(chat.choices[0]?.message.reasoning_content).toBe("think more");
  });

  it("streams reasoning_content chunks for streamed chat completions", async () => {
    const { config, sessions, handoffs } = await setup();
    backendMode = "reasoning";
    const lines = await streamChat(config, sessions, handoffs, [{ role: "user", content: "hi" }]);
    const text = lines.join("\n");
    expect(text).toContain('"reasoning_content":"think "');
    expect(text).toContain('"reasoning_content":"more"');
    expect(text).toContain('"content":"answer"');
  });
});

describe("replayed transcripts", () => {
  it("does not re-emit client tool calls from the input as new output", async () => {
    const { config, sessions, handoffs } = await setup();
    backendMode = "tool";
    const body = {
      input: [
        { role: "user", content: "review" },
        { type: "function_call", call_id: "call_old", name: "bash", arguments: '{"command":"git status"}' },
        { type: "function_call_output", call_id: "call_old", output: "clean" },
      ],
      tools: [
        {
          type: "function",
          name: "bash",
          description: "Run a shell command",
          parameters: { type: "object", properties: { command: { type: "string" } } },
        },
      ],
    };
    const response = await runResponse({
      config,
      model,
      requestedModel: "default",
      userId: "alice",
      userHash: "hash",
      sessionStore: sessions,
      handoffStore: handoffs,
      agentIds: ["default"],
      knownUsers: [],
      mcpTools: [],
      body,
      trace: "no",
    });

    const output = Array.isArray(response.output) ? (response.output as Record<string, unknown>[]) : [];
    const calls = output.filter((item) => item.type === "function_call").map((item) => item.call_id);
    expect(calls).toEqual(["call_new"]);
  });
});
