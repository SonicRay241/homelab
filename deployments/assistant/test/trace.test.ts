import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { SseWriter } from "../src/openai.ts";
import { ResponseEmitter } from "../src/runner.ts";
import { formatTrace, parseTraceMode } from "../src/trace.ts";

function fakeSse() {
  const chunks: Uint8Array[] = [];
  const controller = {
    enqueue(chunk: Uint8Array) {
      chunks.push(chunk);
    },
    close() {},
  } as unknown as ReadableStreamDefaultController<Uint8Array>;
  return {
    writer: new SseWriter(controller),
    text: () => chunks.map((chunk) => new TextDecoder().decode(chunk)).join(""),
  };
}

function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "toolUse",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "assistant-backend",
    model: "default",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function run(trace: "no" | "text" | "openwebui", output = "hello") {
  const sse = fakeSse();
  const emitter = new ResponseEmitter({
    id: "resp_test",
    model: "default",
    instructions: "",
    tools: [],
    toolChoice: "auto",
    parallelToolCalls: true,
    temperature: 1,
    topP: 1,
    store: false,
    metadata: {},
    reasoningEffort: "off",
    clientToolNames: new Set(),
    trace,
    sse: sse.writer,
  });

  emitter.start();
  emitter.onEvent({
    type: "message_update",
    message: assistant([{ type: "text", text: "Calling" }]),
    assistantMessageEvent: { type: "text_delta", delta: "Calling" } as never,
  });
  emitter.onEvent({
    type: "message_end",
    message: assistant([
      { type: "text", text: "Calling" },
      { type: "toolCall", id: "call_1", name: "server_read", arguments: { path: "README.md" } },
    ]),
  });
  emitter.onEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "server_read",
    args: { path: "README.md" },
  });
  emitter.onEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "server_read",
    result: { content: [{ type: "text", text: output }] },
    isError: false,
  });
  emitter.onEvent({
    type: "message_update",
    message: assistant([{ type: "text", text: "Done" }], "stop"),
    assistantMessageEvent: { type: "text_delta", delta: "Done" } as never,
  });
  emitter.onEvent({
    type: "message_end",
    message: assistant([{ type: "text", text: "Done" }], "stop"),
  });

  const response = emitter.complete() as { output: unknown[]; output_text: string };
  return { response, sse: sse.text() };
}

describe("trace mode", () => {
  it("defaults to none and accepts the documented values", () => {
    expect(parseTraceMode(undefined)).toBe("no");
    expect(parseTraceMode("")).toBe("no");
    expect(parseTraceMode("no")).toBe("no");
    expect(parseTraceMode("TEXT")).toBe("text");
    expect(parseTraceMode(" openwebui ")).toBe("openwebui");
    expect(parseTraceMode("bogus")).toBe("no");
  });

  it("truncates output and keeps code fences safe", () => {
    const long = "x".repeat(600);
    const trace = formatTrace({
      mode: "text",
      toolCallId: "call_1",
      toolName: "server_read",
      args: { path: "README.md" },
      result: long,
      isError: false,
    });
    expect(trace).toContain("…");
    expect(trace).toContain(`${"x".repeat(500)}…`);
    expect(trace).not.toContain("x".repeat(501));
    expect(trace.startsWith("```text")).toBe(true);

    const fenced = formatTrace({
      mode: "text",
      toolCallId: "call_2",
      toolName: "server_read",
      args: {},
      result: "before ``` after",
      isError: false,
    });
    expect(fenced.startsWith("````text")).toBe(true);
    expect(fenced.endsWith("````")).toBe(true);
  });

  it("escapes OpenWebUI details bodies and attributes", () => {
    const trace = formatTrace({
      mode: "openwebui",
      toolCallId: 'call_"1',
      toolName: "server_read",
      args: { path: "<README.md>" },
      result: "<b>ok</b>",
      isError: false,
    });
    expect(trace).toContain('<details type="tool_calls" done="true" id="call_&quot;1"');
    expect(trace).toContain('id="call_&quot;1"');
    expect(trace).toContain("&lt;b&gt;ok&lt;/b&gt;");
    expect(trace).not.toContain("<b>ok</b>");
  });

  it("keeps server traces out of output by default", () => {
    const { response, sse } = run("no");
    expect(response.output_text).toBe("CallingDone");
    expect(response.output_text).not.toContain("server_read");
    expect(sse).not.toContain("server_read");
  });

  it("inlines text traces into one assistant message", () => {
    const { response, sse } = run("text");
    expect(response.output).toHaveLength(1);
    expect(response.output_text).toContain("Calling");
    expect(response.output_text).toContain("```text");
    expect(response.output_text).toContain("server_read");
    expect(response.output_text).toContain("hello");
    expect(response.output_text).toContain("Done");
    expect(sse).toContain("response.output_text.delta");
    expect(sse).toContain("server_read");
  });

  it("inlines OpenWebUI details blocks", () => {
    const { response } = run("openwebui", "<b>ok</b>");
    expect(response.output_text).toContain('<details type="tool_calls" done="true"');
    expect(response.output_text).toContain("&lt;b&gt;ok&lt;/b&gt;");
    expect(response.output_text).toContain("</details>");
    expect(response.output).toHaveLength(1);
  });
});
