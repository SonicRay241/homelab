import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Agent, type AgentEvent, type AgentTool } from "@mariozechner/pi-agent-core";
import {
  streamOpenAICompletions,
  Type,
  type AssistantMessage,
  type Message,
  type Model,
  type ToolCall,
} from "@mariozechner/pi-ai";
import type { AssistantConfig } from "./config.ts";
import { isRecord } from "./guards.ts";
import { MemoryStore, MEMORY_INSTRUCTIONS } from "./memory.ts";
import { isServerToolName, memoryTool, namespaceServerTool, SERVER_TOOL_INSTRUCTIONS } from "./tools.ts";
import { estimateInputTokens } from "./tokens.ts";
import {
  collectToolNames,
  convertInput,
  extractClientTools,
  outputFunctionCallItem,
  outputTextItem,
  responseShape,
  type ClientTool,
  type OutputItem,
  type RunUsage,
  type SseWriter,
} from "./openai.ts";

export class RequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "invalid_request_error",
  ) {
    super(message);
    this.name = "RequestError";
  }
}

interface StoredResponse {
  id: string;
  userId: string;
  agentId: string;
  baseSystemPrompt: string;
  messages: Message[];
  response: Record<string, unknown>;
  createdAt: number;
}

const STORE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const STORE_MAX = 500;
const responses = new Map<string, StoredResponse>();

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function pruneStore(): void {
  const cutoff = Date.now() - STORE_TTL_MS;
  for (const [id, entry] of responses) {
    if (entry.createdAt < cutoff) responses.delete(id);
  }
  while (responses.size > STORE_MAX) {
    const oldest = responses.keys().next().value;
    if (oldest === undefined) break;
    responses.delete(oldest);
  }
}

export function getStoredResponse(id: string, userId: string): Record<string, unknown> | undefined {
  const entry = responses.get(id);
  if (!entry || entry.userId !== userId) return undefined;
  if (Date.now() - entry.createdAt > STORE_TTL_MS) {
    responses.delete(id);
    return undefined;
  }
  return entry.response;
}

export function memoryDirectory(config: AssistantConfig, userId: string): string {
  return join(config.dataDir, "users", userId, "agents", config.agentId, "memories");
}

const DEFAULT_SOUL = `You are a helpful, direct assistant running inside a pi agent harness.
Prefer concise, factual answers. Use the tools you are given when they help.
When the user tells you a durable preference or fact about themselves, save it with the \`server_memory\` tool.`;

async function loadSoul(config: AssistantConfig): Promise<string> {
  try {
    const soul = await readFile(join(config.agentDir, "SOUL.md"), "utf8");
    return soul.trim();
  } catch {
    return DEFAULT_SOUL;
  }
}

async function buildBaseSystemPrompt(config: AssistantConfig, userId: string): Promise<string> {
  const store = new MemoryStore(memoryDirectory(config, userId));
  const snapshot = await store.snapshot();
  return [
    await loadSoul(config),
    SERVER_TOOL_INSTRUCTIONS,
    store.render("memory", snapshot.memory),
    store.render("user", snapshot.user),
    MEMORY_INSTRUCTIONS,
  ].join("\n\n");
}

function instructionsText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((part) => {
      if (typeof part === "string") return [part];
      if (!isRecord(part)) return [];
      if (typeof part.text === "string") return [part.text];
      const nested = instructionsText(part.content);
      return nested ? [nested] : [];
    })
    .join("\n")
    .trim();
}

function numberField(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function toolChoice(value: unknown): "auto" | "none" | "required" | { type: "function"; function: { name: string } } {
  if (value === "none" || value === "required" || value === "auto") return value;
  if (isRecord(value)) {
    const name =
      typeof value.name === "string"
        ? value.name
        : isRecord(value.function) && typeof value.function.name === "string"
          ? value.function.name
          : undefined;
    if (name) return { type: "function", function: { name } };
  }
  return "auto";
}

function clientToolStub(tool: ClientTool): AgentTool {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: Type.Unsafe(tool.parameters),
    execute: async () => ({
      content: [{ type: "text", text: "Tool execution delegated to the client." }],
      details: { client: true },
      terminate: true,
    }),
  };
}

export interface RunOptions {
  config: AssistantConfig;
  model: Model<"openai-completions">;
  /** Agent id or backend alias supplied by the client; echoed in the response. */
  requestedModel: string;
  userId: string;
  body: Record<string, unknown>;
  sse?: SseWriter;
  signal?: AbortSignal;
}

interface Normalized {
  requestedModel: string;
  stream: boolean;
  store: boolean;
  previousResponseId?: string;
  clientTools: ClientTool[];
  toolsEcho: unknown[];
  parallelToolCalls: boolean;
  temperature: number;
  topP: number;
  maxOutputTokens?: number;
  metadata: Record<string, unknown>;
  choice: ReturnType<typeof toolChoice>;
  input: unknown;
  rawInstructions: string;
}

function normalize(config: AssistantConfig, body: Record<string, unknown>, requestedModel: string): Normalized {
  if (body.previous_response_id !== undefined && body.previous_response_id !== null && typeof body.previous_response_id !== "string") {
    throw new RequestError("previous_response_id must be a string or null");
  }
  const maxOutputTokens = body.max_output_tokens;
  if (maxOutputTokens !== undefined && maxOutputTokens !== null && typeof maxOutputTokens !== "number") {
    throw new RequestError("max_output_tokens must be a number");
  }
  return {
    requestedModel,
    stream: body.stream === true,
    store: body.store !== false,
    previousResponseId: typeof body.previous_response_id === "string" ? body.previous_response_id : undefined,
    clientTools: extractClientTools(body.tools),
    toolsEcho: Array.isArray(body.tools) ? body.tools : [],
    parallelToolCalls: body.parallel_tool_calls !== false,
    temperature: numberField(body.temperature, 1),
    topP: numberField(body.top_p, 1),
    maxOutputTokens: typeof maxOutputTokens === "number" ? maxOutputTokens : undefined,
    metadata: isRecord(body.metadata) ? body.metadata : {},
    choice: toolChoice(body.tool_choice),
    input: body.input,
    rawInstructions: instructionsText(body.instructions),
  };
}

class ResponseEmitter {
  readonly output: OutputItem[] = [];
  readonly usage: RunUsage = { inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 };
  failure?: { code: string; message: string };
  incomplete = false;

  private message?: { id: string; text: string; index: number };
  private readonly createdAt = Math.floor(Date.now() / 1000);

  constructor(
    private readonly options: {
      id: string;
      model: string;
      instructions: string;
      previousResponseId?: string;
      tools: unknown[];
      toolChoice: unknown;
      parallelToolCalls: boolean;
      temperature: number;
      topP: number;
      maxOutputTokens?: number;
      store: boolean;
      metadata: Record<string, unknown>;
      clientToolNames: Set<string>;
      sse?: SseWriter;
    },
  ) {}

  private get sse(): SseWriter | undefined {
    return this.options.sse;
  }

  response(status: "in_progress" | "completed" | "failed" | "incomplete"): Record<string, unknown> {
    return responseShape({
      id: this.options.id,
      createdAt: this.createdAt,
      status,
      model: this.options.model,
      output: this.output,
      usage: this.usage,
      instructions: this.options.instructions,
      previousResponseId: this.options.previousResponseId,
      tools: this.options.tools,
      toolChoice: this.options.toolChoice,
      parallelToolCalls: this.options.parallelToolCalls,
      temperature: this.options.temperature,
      topP: this.options.topP,
      maxOutputTokens: this.options.maxOutputTokens,
      store: this.options.store,
      metadata: this.options.metadata,
      error: this.failure,
      incompleteReason: this.incomplete ? "max_output_tokens" : undefined,
    });
  }

  start(): void {
    this.sse?.send("response.created", { response: this.response("in_progress") });
    this.sse?.send("response.in_progress", { response: this.response("in_progress") });
  }

  private ensureMessageItem(): { id: string; text: string; index: number } {
    if (this.message) return this.message;
    const index = this.output.length;
    const id = newId("msg");
    this.message = { id, text: "", index };
    this.sse?.send("response.output_item.added", {
      output_index: index,
      item: { id, type: "message", status: "in_progress", role: "assistant", content: [] },
    });
    this.sse?.send("response.content_part.added", {
      item_id: id,
      output_index: index,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
    return this.message;
  }

  private finishMessage(): void {
    const message = this.message;
    this.message = undefined;
    if (!message || !message.text) return;
    const item = outputTextItem(message.id, message.text);
    this.output.push(item);
    const part = item.content?.[0];
    this.sse?.send("response.output_text.done", {
      item_id: message.id,
      output_index: message.index,
      content_index: 0,
      text: message.text,
    });
    this.sse?.send("response.content_part.done", {
      item_id: message.id,
      output_index: message.index,
      content_index: 0,
      part,
    });
    this.sse?.send("response.output_item.done", { output_index: message.index, item });
  }

  private emitFunctionCall(call: ToolCall): void {
    const item = outputFunctionCallItem(newId("fc"), call.id || newId("call"), call.name, call.arguments);
    const index = this.output.length;
    this.output.push(item);
    this.sse?.send("response.output_item.added", {
      output_index: index,
      item: { ...item, status: "in_progress" },
    });
    this.sse?.send("response.function_call_arguments.delta", {
      item_id: item.id,
      output_index: index,
      delta: item.arguments ?? "{}",
    });
    this.sse?.send("response.function_call_arguments.done", {
      item_id: item.id,
      output_index: index,
      arguments: item.arguments ?? "{}",
    });
    this.sse?.send("response.output_item.done", { output_index: index, item });
  }

  private addUsage(message: AssistantMessage): void {
    const usage = message.usage;
    const input = usage.input + usage.cacheRead + usage.cacheWrite;
    this.usage.inputTokens += input;
    this.usage.cachedTokens += usage.cacheRead;
    this.usage.outputTokens += usage.output;
    this.usage.totalTokens += usage.totalTokens || input + usage.output;
  }

  onEvent(event: AgentEvent): void {
    switch (event.type) {
      case "message_update": {
        const update = event.assistantMessageEvent;
        if (update.type !== "text_delta") return;
        const message = this.ensureMessageItem();
        message.text += update.delta;
        this.sse?.send("response.output_text.delta", {
          item_id: message.id,
          output_index: message.index,
          content_index: 0,
          delta: update.delta,
          logprobs: [],
        });
        return;
      }
      case "message_end": {
        const message = event.message;
        if (message.role !== "assistant") return;
        this.addUsage(message);
        this.finishMessage();
        for (const part of message.content) {
          if (part.type !== "toolCall") continue;
          if (!part.id) part.id = newId("call");
          if (this.options.clientToolNames.has(part.name)) this.emitFunctionCall(part);
        }
        if (message.stopReason === "error" || message.stopReason === "aborted") {
          this.failure = {
            code: message.stopReason === "aborted" ? "cancelled" : "server_error",
            message: message.errorMessage || "The model request failed.",
          };
        } else if (message.stopReason === "length") {
          this.incomplete = true;
        }
        return;
      }
      default:
        return;
    }
  }

  complete(): Record<string, unknown> {
    this.finishMessage();
    const status = this.failure ? "failed" : this.incomplete ? "incomplete" : "completed";
    const response = this.response(status);
    if (this.failure) {
      this.sse?.send("response.failed", { response });
    } else if (this.incomplete) {
      this.sse?.send("response.incomplete", { response });
    } else {
      this.sse?.send("response.completed", { response });
    }
    return response;
  }
}

/**
 * Runs one Responses API request. Uses pi-agent-core's Agent as the loop:
 * server tools execute inline; client tools terminate the loop immediately and
 * are returned as function_call output items for the caller to execute.
 */
export async function runResponse(options: RunOptions): Promise<Record<string, unknown>> {
  const { config, model, requestedModel, userId, body } = options;
  const normalized = normalize(config, body, requestedModel);

  const previous = normalized.previousResponseId ? responses.get(normalized.previousResponseId) : undefined;
  if (
    normalized.previousResponseId &&
    (!previous || previous.userId !== userId || previous.agentId !== config.agentId)
  ) {
    throw new RequestError(`Unknown previous_response_id ${JSON.stringify(normalized.previousResponseId)}`, 404, "not_found");
  }

  const knownNames = collectToolNames(previous?.messages ?? []);
  const converted = convertInput(normalized.input, knownNames);
  const history = previous?.messages ?? [];
  if (!history.length && !converted.messages.length) {
    throw new RequestError("input is required");
  }

  const baseSystemPrompt = previous?.baseSystemPrompt ?? (await buildBaseSystemPrompt(config, userId));
  const instructions = [normalized.rawInstructions, ...converted.instructions].filter(Boolean).join("\n\n");
  const systemPrompt = instructions
    ? `${baseSystemPrompt}\n\n# Client instructions\n${instructions}`
    : baseSystemPrompt;

  const reservedClientTools = normalized.clientTools.filter((tool) => isServerToolName(tool.name));
  if (reservedClientTools.length) {
    throw new RequestError(
      `Client tool names must not start with the reserved prefix: ${reservedClientTools.map((tool) => tool.name).join(", ")}`,
      400,
      "invalid_tool_name",
    );
  }

  const serverTools: AgentTool[] = [
    namespaceServerTool(memoryTool(new MemoryStore(memoryDirectory(config, userId)))),
  ];
  const clientToolNames = new Set(normalized.clientTools.map((tool) => tool.name));
  const tools: AgentTool[] = [...serverTools, ...normalized.clientTools.map(clientToolStub)];

  const estimatedInputTokens = estimateInputTokens(systemPrompt, [...history, ...converted.messages], tools);
  if (config.maxInputTokens > 0 && estimatedInputTokens > config.maxInputTokens) {
    throw new RequestError(
      `Estimated input is ${estimatedInputTokens} tokens, over the configured limit of ${config.maxInputTokens}`,
      400,
      "context_length_exceeded",
    );
  }

  const id = newId("resp");
  const emitter = new ResponseEmitter({
    id,
    model: normalized.requestedModel,
    instructions,
    previousResponseId: normalized.previousResponseId,
    tools: normalized.toolsEcho,
    toolChoice: normalized.choice,
    parallelToolCalls: normalized.parallelToolCalls,
    temperature: normalized.temperature,
    topP: normalized.topP,
    maxOutputTokens: normalized.maxOutputTokens,
    store: normalized.store,
    metadata: normalized.metadata,
    clientToolNames,
    sse: options.sse,
  });

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      messages: history,
      tools,
      thinkingLevel: "off",
    },
    getApiKey: () => config.apiKey,
    toolExecution: normalized.parallelToolCalls ? "parallel" : "sequential",
    streamFn: (streamModel, context, streamOptions) => {
      // Agent widens Model<Api>; our initial state and registry guarantee openai-completions.
      const typedModel: Model<"openai-completions"> = streamModel as Model<"openai-completions">;
      return streamOpenAICompletions(typedModel, context, {
        ...streamOptions,
        temperature: normalized.temperature,
        maxTokens: normalized.maxOutputTokens,
        toolChoice: normalized.choice,
      });
    },
    afterToolCall: async ({ assistantMessage }) => {
      const hasClientCall = assistantMessage.content.some(
        (part) => part.type === "toolCall" && clientToolNames.has(part.name),
      );
      return hasClientCall ? { terminate: true } : undefined;
    },
  });

  emitter.start();
  const abort = () => agent.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  agent.subscribe((event) => emitter.onEvent(event));
  try {
    await agent.prompt(converted.messages);
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }

  const response = emitter.complete();

  if (normalized.store) {
    const storedMessages = agent.state.messages.filter(
      (message) => !(message.role === "toolResult" && clientToolNames.has(message.toolName)),
    );
    responses.set(id, {
      id,
      userId,
      agentId: config.agentId,
      baseSystemPrompt,
      messages: storedMessages,
      response,
      createdAt: Date.now(),
    });
    pruneStore();
  }

  return response;
}
