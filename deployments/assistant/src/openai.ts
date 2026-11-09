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
  type: "message" | "function_call";
  status: "completed";
  role?: "assistant";
  content?: { type: "output_text"; text: string; annotations: unknown[] }[];
  call_id?: string;
  name?: string;
  arguments?: string;
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

export class SseWriter {
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
