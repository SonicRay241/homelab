import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@mariozechner/pi-ai";
import { isRecord } from "./guards.ts";

export const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export interface ClientTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ConvertedInput {
  messages: Message[];
  instructions: string[];
  callNames: Map<string, string>;
}

const MAX_INPUT_ITEMS = 2_000;

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function textContent(text: string): TextContent {
  return { type: "text", text };
}

function imageContent(part: Record<string, unknown>): ImageContent | undefined {
  const url = stringField(part.image_url);
  if (!url?.startsWith("data:")) return undefined;
  const match = url.match(/^data:([^;,]+);base64,(.+)$/s);
  if (!match) return undefined;
  const mimeType = match[1];
  const data = match[2];
  if (!mimeType?.startsWith("image/") || !data) return undefined;
  return { type: "image", mimeType, data };
}

function convertParts(content: unknown): string | (TextContent | ImageContent)[] | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: (TextContent | ImageContent)[] = [];
  for (const raw of content) {
    if (!isRecord(raw)) continue;
    const type = stringField(raw.type);
    if (type === "input_text" || type === "output_text" || type === "text" || type === "summary_text") {
      const text = stringField(raw.text);
      if (text) parts.push(textContent(text));
    } else if (type === "refusal") {
      const refusal = stringField(raw.refusal);
      if (refusal) parts.push(textContent(refusal));
    } else if (type === "input_image") {
      const image = imageContent(raw);
      if (image) parts.push(image);
    }
  }
  return parts.length ? parts : undefined;
}

function partsToText(content: string | (TextContent | ImageContent)[] | undefined): string {
  if (typeof content === "string") return content;
  if (!content) return "";
  return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "assistant-backend",
    model: "",
    usage: EMPTY_USAGE,
    stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
}

function toolResult(
  callId: string,
  name: string,
  output: unknown,
  isError = false,
): ToolResultMessage {
  let content: (TextContent | ImageContent)[];
  if (typeof output === "string") {
    content = [textContent(output)];
  } else {
    const parts = convertParts(output);
    content =
      typeof parts === "string"
        ? [textContent(parts)]
        : (parts ?? [textContent(output === undefined ? "" : JSON.stringify(output))]);
  }
  return {
    role: "toolResult",
    toolCallId: callId,
    toolName: name || "unknown",
    content,
    isError,
    timestamp: Date.now(),
  };
}

/** Names for function calls already present in a stored transcript. */
export function collectToolNames(messages: Message[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type === "toolCall") names.set(part.id, part.name);
    }
  }
  return names;
}

/**
 * Converts Responses API input items (string or array) into pi messages.
 * Unsupported items (reasoning, item_reference, built-in tool calls) are ignored.
 */
export function convertInput(
  input: unknown,
  knownToolNames: Map<string, string> = new Map(),
): ConvertedInput {
  const messages: Message[] = [];
  const instructions: string[] = [];
  const callNames = new Map(knownToolNames);
  const items: unknown[] = typeof input === "string" ? [input] : Array.isArray(input) ? input : [];
  let pendingCalls: ToolCall[] = [];

  const flushCalls = () => {
    if (!pendingCalls.length) return;
    messages.push(assistantMessage(pendingCalls));
    pendingCalls = [];
  };

  for (const item of items.slice(0, MAX_INPUT_ITEMS)) {
    if (typeof item === "string") {
      flushCalls();
      if (item) messages.push({ role: "user", content: item, timestamp: Date.now() });
      continue;
    }
    if (!isRecord(item)) continue;

    const type = stringField(item.type);
    if (type === "function_call") {
      const callId = stringField(item.call_id) ?? stringField(item.id) ?? "";
      const name = stringField(item.name) ?? "";
      let args: Record<string, unknown> = {};
      const rawArgs = item.arguments;
      if (typeof rawArgs === "string") {
        try {
          const parsed: unknown = JSON.parse(rawArgs || "{}");
          if (isRecord(parsed)) args = parsed;
        } catch {
          args = {};
        }
      } else if (isRecord(rawArgs)) {
        args = rawArgs;
      }
      if (callId && name) {
        callNames.set(callId, name);
        pendingCalls.push({ type: "toolCall", id: callId, name, arguments: args });
      }
      continue;
    }

    flushCalls();

    if (type === "function_call_output") {
      const callId = stringField(item.call_id) ?? "";
      if (!callId) continue;
      const name = callNames.get(callId) ?? "unknown";
      messages.push(toolResult(callId, name, item.output, item.is_error === true));
      continue;
    }

    if (type === "reasoning" || type === "item_reference") continue;

    const role = stringField(item.role);
    if (!role) continue;
    const content = convertParts(item.content);

    if (role === "system" || role === "developer") {
      const text = partsToText(content);
      if (text) instructions.push(text);
      continue;
    }

    if (role === "user") {
      if (!content) continue;
      const user: UserMessage = { role: "user", content, timestamp: Date.now() };
      messages.push(user);
      continue;
    }

    if (role === "assistant") {
      const parts: AssistantMessage["content"] = [];
      if (typeof content === "string") parts.push(textContent(content));
      else if (content) {
        for (const part of content) if (part.type === "text") parts.push(part);
      }
      if (parts.length) messages.push(assistantMessage(parts));
      continue;
    }

    if (role === "tool") {
      const callId = stringField(item.tool_call_id) ?? "";
      if (callId) messages.push(toolResult(callId, callNames.get(callId) ?? "unknown", item.content));
    }
  }
  flushCalls();

  return { messages: mergeAssistantMessages(messages), instructions, callNames };
}

/** OpenAI providers dislike consecutive assistant messages; merge replayed items. */
function mergeAssistantMessages(messages: Message[]): Message[] {
  const merged: Message[] = [];
  for (const message of messages) {
    const last = merged[merged.length - 1];
    if (message.role === "assistant" && last?.role === "assistant") {
      last.content.push(...message.content);
      if (message.content.some((part) => part.type === "toolCall")) last.stopReason = "toolUse";
      continue;
    }
    merged.push(message);
  }
  return merged;
}

export function extractClientTools(raw: unknown): ClientTool[] {
  if (!Array.isArray(raw)) return [];
  const tools: ClientTool[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const type = stringField(entry.type);
    if (type && type !== "function") continue;
    const fn = isRecord(entry.function) ? entry.function : entry;
    const name = stringField(fn.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const description = stringField(fn.description) ?? "";
    const parameters = isRecord(fn.parameters) ? fn.parameters : { type: "object", properties: {} };
    tools.push({ name, description, parameters });
  }
  return tools;
}

export interface RunUsage {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface OutputItem {
  id: string;
  type: "message" | "function_call" | "reasoning";
  status: "completed";
  role?: "assistant";
  content?: { type: "output_text"; text: string; annotations: unknown[] }[];
  summary?: { type: "summary_text"; text: string }[];
  call_id?: string;
  name?: string;
  arguments?: string;
}

export function outputReasoningItem(id: string, text: string): OutputItem {
  return { id, type: "reasoning", status: "completed", summary: [{ type: "summary_text", text }] };
}

export function outputTextItem(id: string, text: string): OutputItem {
  return {
    id,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

export function outputFunctionCallItem(
  id: string,
  callId: string,
  name: string,
  args: Record<string, unknown>,
): OutputItem {
  return { id, type: "function_call", status: "completed", call_id: callId, name, arguments: JSON.stringify(args) };
}

export interface ResponseShapeOptions {
  id: string;
  createdAt: number;
  status: "in_progress" | "completed" | "failed" | "incomplete";
  model: string;
  output: OutputItem[];
  usage: RunUsage;
  instructions: string;
  previousResponseId?: string | null;
  tools: unknown[];
  toolChoice: unknown;
  parallelToolCalls: boolean;
  temperature: number;
  topP: number;
  maxOutputTokens?: number;
  store: boolean;
  metadata: Record<string, unknown>;
  reasoningEffort?: string | null;
  error?: { code: string; message: string } | null;
  incompleteReason?: "max_output_tokens" | "content_filter";
}

export function responseShape(options: ResponseShapeOptions): Record<string, unknown> {
  return {
    id: options.id,
    object: "response",
    created_at: options.createdAt,
    status: options.status,
    background: false,
    error: options.error ?? null,
    incomplete_details: options.incompleteReason ? { reason: options.incompleteReason } : null,
    instructions: options.instructions || null,
    max_output_tokens: options.maxOutputTokens ?? null,
    model: options.model,
    output: options.output,
    output_text: options.output.flatMap((item) => item.content?.map((part) => part.text) ?? []).join(""),
    parallel_tool_calls: options.parallelToolCalls,
    previous_response_id: options.previousResponseId ?? null,
    reasoning: { effort: options.reasoningEffort ?? null, summary: null },
    store: options.store,
    temperature: options.temperature,
    text: { format: { type: "text" } },
    tool_choice: options.toolChoice ?? "auto",
    tools: options.tools,
    top_p: options.topP,
    truncation: "disabled",
    usage:
      options.status === "in_progress"
        ? null
        : {
            input_tokens: options.usage.inputTokens,
            input_tokens_details: { cached_tokens: options.usage.cachedTokens },
            output_tokens: options.usage.outputTokens,
            output_tokens_details: { reasoning_tokens: options.usage.reasoningTokens },
            total_tokens: options.usage.totalTokens,
          },
    user: null,
    metadata: options.metadata,
  };
}

/** Minimal sink so the runner can emit its Responses events into either SSE format. */
export interface SseSink {
  send(type: string, payload: Record<string, unknown>): void;
  close(): void;
}

function objectField(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function numericField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Chat parts (`text`, `image_url`) become Responses parts (`input_text`, `input_image`). */
function chatContent(content: unknown): unknown {
  if (content === null) return undefined;
  if (!Array.isArray(content)) return typeof content === "string" && !content ? undefined : content;
  const parts: unknown[] = [];
  for (const raw of content) {
    if (!isRecord(raw)) continue;
    const type = stringField(raw.type);
    if (type === "text" || type === "input_text") {
      const text = stringField(raw.text);
      if (text) parts.push({ type: "input_text", text });
    } else if (type === "image_url") {
      const imageUrl = isRecord(raw.image_url) ? stringField(raw.image_url.url) : stringField(raw.image_url);
      if (imageUrl) parts.push({ type: "input_image", image_url: imageUrl });
    } else if (type === "input_image") {
      parts.push(raw);
    }
  }
  return parts.length ? parts : undefined;
}

/**
 * Rewrites a Chat Completions request into the Responses-shaped body `runResponse`
 * consumes. Unsupported chat fields (`n`, `response_format`, `stop`, `logprobs`)
 * are ignored here; `n` is rejected by the HTTP handler.
 */
export function chatRequestToResponses(body: Record<string, unknown>): Record<string, unknown> {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const input: unknown[] = [];

  for (const raw of messages.slice(0, MAX_INPUT_ITEMS)) {
    if (!isRecord(raw)) continue;
    const role = stringField(raw.role);
    if (!role) continue;

    if (role === "system" || role === "developer" || role === "user") {
      const content = chatContent(raw.content);
      if (content !== undefined) input.push({ role, content });
      continue;
    }

    if (role === "assistant") {
      const content = chatContent(raw.content);
      if (content !== undefined) input.push({ role: "assistant", content });
      for (const call of Array.isArray(raw.tool_calls) ? raw.tool_calls : []) {
        if (!isRecord(call)) continue;
        const fn = objectField(call.function);
        const callId = stringField(call.id);
        const name = stringField(fn.name);
        if (!callId || !name) continue;
        input.push({
          type: "function_call",
          call_id: callId,
          name,
          arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
        });
      }
      continue;
    }

    if (role === "tool") {
      const callId = stringField(raw.tool_call_id);
      if (callId) input.push({ type: "function_call_output", call_id: callId, output: raw.content ?? "" });
    }
  }

  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  return {
    ...body,
    // Chat clients replay the whole conversation; never merge stored history on top.
    previous_response_id: undefined,
    input,
    ...(typeof maxTokens === "number" ? { max_output_tokens: maxTokens } : {}),
  };
}

function chatCompletionId(id: string): string {
  return id.startsWith("resp_") ? `chatcmpl-${id.slice("resp_".length)}` : id;
}

function chatUsage(value: unknown): Record<string, unknown> {
  const usage = objectField(value);
  return {
    prompt_tokens: numericField(usage.input_tokens),
    completion_tokens: numericField(usage.output_tokens),
    total_tokens: numericField(usage.total_tokens),
    prompt_tokens_details: { cached_tokens: numericField(objectField(usage.input_tokens_details).cached_tokens) },
    completion_tokens_details: {
      reasoning_tokens: numericField(objectField(usage.output_tokens_details).reasoning_tokens),
    },
  };
}

function chatText(output: unknown[]): string {
  return output
    .flatMap((item) => {
      if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) return [];
      return item.content.flatMap((part) => (isRecord(part) && typeof part.text === "string" ? [part.text] : []));
    })
    .join("");
}

function chatReasoning(output: unknown[]): string {
  return output
    .flatMap((item) => {
      if (!isRecord(item) || item.type !== "reasoning" || !Array.isArray(item.summary)) return [];
      return item.summary.flatMap((part) => (isRecord(part) && typeof part.text === "string" ? [part.text] : []));
    })
    .join("");
}

function chatToolCalls(output: unknown[]): Record<string, unknown>[] {
  return output.flatMap((item) => {
    if (!isRecord(item) || item.type !== "function_call") return [];
    return [
      {
        id: stringField(item.call_id) ?? stringField(item.id) ?? "",
        type: "function",
        function: { name: stringField(item.name) ?? "", arguments: stringField(item.arguments) ?? "{}" },
      },
    ];
  });
}

/** Projects a completed Responses object into the Chat Completions response shape. */
export function chatCompletionShape(
  response: Record<string, unknown>,
  fallbackModel: string,
): Record<string, unknown> {
  const output = Array.isArray(response.output) ? response.output : [];
  const text = chatText(output);
  const reasoning = chatReasoning(output);
  const toolCalls = chatToolCalls(output);
  const status = stringField(response.status) ?? "completed";
  return {
    id: chatCompletionId(stringField(response.id) ?? ""),
    object: "chat.completion",
    created: typeof response.created_at === "number" ? response.created_at : Math.floor(Date.now() / 1_000),
    model: stringField(response.model) ?? fallbackModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text ? text : toolCalls.length ? null : "",
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length ? "tool_calls" : status === "incomplete" ? "length" : "stop",
        logprobs: null,
      },
    ],
    usage: chatUsage(response.usage),
  };
}

export class SseWriter implements SseSink {
  private sequence = 0;
  private closed = false;
  private readonly encoder = new TextEncoder();

  constructor(private readonly controller: ReadableStreamDefaultController<Uint8Array>) {}

  send(type: string, payload: Record<string, unknown>): void {
    if (this.closed) return;
    const data = { type, sequence_number: this.sequence++, ...payload };
    try {
      this.controller.enqueue(this.encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
    } catch {
      this.closed = true;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.controller.close();
    } catch {
      // client disconnected
    }
  }
}

/**
 * Translates the runner's Responses events into Chat Completions chunks.
 * Only client function calls are emitted as `tool_calls` deltas; server tool
 * calls execute inside the agent loop and surface only through the trace text
 * when `x-pi-trace` is set, exactly like the Responses endpoint.
 */
export class ChatCompletionStream implements SseSink {
  private readonly encoder = new TextEncoder();
  private readonly created = Math.floor(Date.now() / 1_000);
  private readonly toolIndexes = new Map<number, number>();
  private chatId = "chatcmpl-pending";
  private model = "";
  private toolCalls = false;
  private finished = false;
  private closed = false;

  constructor(
    private readonly controller: ReadableStreamDefaultController<Uint8Array>,
    private readonly includeUsage = false,
  ) {}

  private write(data: unknown): void {
    if (this.closed) return;
    const text = typeof data === "string" ? data : JSON.stringify(data);
    try {
      this.controller.enqueue(this.encoder.encode(`data: ${text}\n\n`));
    } catch {
      this.closed = true;
    }
  }

  private chunk(choices: unknown[], extra?: Record<string, unknown>): void {
    this.write({
      id: this.chatId,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices,
      ...extra,
    });
  }

  private delta(delta: Record<string, unknown>): void {
    this.chunk([{ index: 0, delta, finish_reason: null, logprobs: null }]);
  }

  private finish(response: Record<string, unknown>, reason: string): void {
    if (this.finished) return;
    this.finished = true;
    this.chunk([{ index: 0, delta: {}, finish_reason: reason, logprobs: null }]);
    if (this.includeUsage) this.chunk([], { usage: chatUsage(response.usage) });
    this.write("[DONE]");
  }

  fail(code: string, message: string): void {
    if (this.finished) return;
    this.finished = true;
    this.write({ error: { message, type: "server_error", param: null, code } });
    this.write("[DONE]");
  }

  send(type: string, payload: Record<string, unknown>): void {
    if (this.finished) return;
    switch (type) {
      case "response.created": {
        const response = objectField(payload.response);
        this.chatId = chatCompletionId(stringField(response.id) ?? "");
        this.model = stringField(response.model) ?? "";
        this.delta({ role: "assistant", content: "" });
        return;
      }
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        const text = stringField(payload.delta);
        if (text) this.delta({ reasoning_content: text });
        return;
      }
      case "response.output_text.delta": {
        const text = stringField(payload.delta);
        if (text) this.delta({ content: text });
        return;
      }
      case "response.output_item.added": {
        const item = objectField(payload.item);
        if (item.type !== "function_call") return;
        const outputIndex = typeof payload.output_index === "number" ? payload.output_index : this.toolIndexes.size;
        const index = this.toolIndexes.size;
        this.toolIndexes.set(outputIndex, index);
        this.toolCalls = true;
        this.delta({
          tool_calls: [
            {
              index,
              id: stringField(item.call_id) ?? stringField(item.id) ?? "",
              type: "function",
              function: { name: stringField(item.name) ?? "", arguments: "" },
            },
          ],
        });
        return;
      }
      case "response.function_call_arguments.delta": {
        const index =
          typeof payload.output_index === "number" ? this.toolIndexes.get(payload.output_index) : undefined;
        if (index === undefined) return;
        this.delta({ tool_calls: [{ index, function: { arguments: stringField(payload.delta) ?? "" } }] });
        return;
      }
      case "response.completed":
      case "response.incomplete": {
        const reason = type === "response.incomplete" ? "length" : this.toolCalls ? "tool_calls" : "stop";
        this.finish(objectField(payload.response), reason);
        return;
      }
      case "response.failed": {
        const error = objectField(objectField(payload.response).error);
        this.fail(
          stringField(error.code) ?? "server_error",
          stringField(error.message) ?? "The model request failed.",
        );
        return;
      }
      case "error": {
        this.fail(
          stringField(payload.code) ?? "server_error",
          stringField(payload.message) ?? "Internal Server Error",
        );
        return;
      }
      default:
        return;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.controller.close();
    } catch {
      // client disconnected
    }
  }
}
