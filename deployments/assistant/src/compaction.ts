import { completeSimple, type Message, type Model, type Tool } from "@mariozechner/pi-ai";
import type { AssistantConfig } from "./config.ts";
import { estimateInputTokens } from "./tokens.ts";

export const COMPACTION_PREFIX = "[CONTEXT COMPACTION — REFERENCE ONLY]";
const SUMMARY_MAX_TOKENS = 1_200;
const MAX_SUMMARY_INPUT_CHARS = 120_000;
const FALLBACK_SUMMARY_CHARS = 8_000;

export type Summarizer = (transcript: string) => Promise<string>;

export interface CompactOptions {
  systemPrompt: string;
  messages: Message[];
  tools: Tool[];
  keepTurns: number;
  thresholdTokens: number;
  summarizer: Summarizer;
}

export interface CompactionResult {
  messages: Message[];
  compacted: boolean;
  beforeTokens: number;
  afterTokens: number;
  droppedMessages: number;
}

/**
 * Conversation units: a user message plus every assistant/tool message after it,
 * up to the next user message. This keeps tool-call/tool-result pairs together.
 */
export function splitUnits(messages: Message[]): Message[][] {
  const units: Message[][] = [];
  for (const message of messages) {
    const last = units[units.length - 1];
    if (message.role === "user" || !last) units.push([message]);
    else last.push(message);
  }
  return units;
}

function messageToText(message: Message): string {
  if (message.role === "user") {
    return `User: ${typeof message.content === "string" ? message.content : message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n")}`;
  }
  if (message.role === "toolResult") {
    const output = message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
    return `Tool ${message.toolName}${message.isError ? " (error)" : ""}: ${output}`;
  }
  const parts: string[] = [];
  for (const part of message.content) {
    if (part.type === "text") parts.push(part.text);
    else if (part.type === "toolCall") parts.push(`[tool call ${part.name} ${JSON.stringify(part.arguments)}]`);
  }
  return `Assistant: ${parts.join("\n")}`;
}

export function transcriptForSummary(messages: Message[]): string {
  const text = messages.map(messageToText).join("\n\n");
  if (text.length <= MAX_SUMMARY_INPUT_CHARS) return text;
  const head = Math.floor(MAX_SUMMARY_INPUT_CHARS / 4);
  const tail = MAX_SUMMARY_INPUT_CHARS - head;
  return `${text.slice(0, head)}\n\n[...middle truncated...]\n\n${text.slice(-tail)}`;
}

function fallbackSummary(messages: Message[]): string {
  return messages
    .map(messageToText)
    .join("\n")
    .slice(0, FALLBACK_SUMMARY_CHARS);
}

export function compactionTokenThreshold(config: AssistantConfig): number {
  if (config.compactionThreshold <= 0) return 0;
  const window = Math.floor(config.contextWindow * config.compactionThreshold);
  return config.maxInputTokens > 0 ? Math.min(window, config.maxInputTokens) : window;
}

/**
 * Summarizes older conversation units when the estimated prompt exceeds the
 * threshold, keeping recent units verbatim. Falls back to a deterministic
 * transcript digest if the summarizer fails, so a chat never wedges.
 */
export async function compactMessages(options: CompactOptions): Promise<CompactionResult> {
  const beforeTokens = estimateInputTokens(options.systemPrompt, options.messages, options.tools);
  const units = splitUnits(options.messages);
  const keep = Math.max(1, Math.floor(options.keepTurns));
  if (options.thresholdTokens <= 0 || beforeTokens <= options.thresholdTokens || units.length <= keep) {
    return {
      messages: options.messages,
      compacted: false,
      beforeTokens,
      afterTokens: beforeTokens,
      droppedMessages: 0,
    };
  }

  const older = units.slice(0, -keep).flat();
  const tail = units.slice(-keep).flat();
  let summary = "";
  try {
    summary = (await options.summarizer(transcriptForSummary(older))).trim();
  } catch {
    summary = "";
  }
  if (!summary) summary = fallbackSummary(older);

  const summaryMessage: Message = {
    role: "user",
    content:
      `${COMPACTION_PREFIX} Earlier turns were compacted into this handoff summary. ` +
      `Treat it as reference; the recent tail remains verbatim.\n\n${summary}`,
    timestamp: Date.now(),
  };
  const messages = [summaryMessage, ...tail];
  const afterTokens = estimateInputTokens(options.systemPrompt, messages, options.tools);
  if (afterTokens >= beforeTokens) {
    return {
      messages: options.messages,
      compacted: false,
      beforeTokens,
      afterTokens: beforeTokens,
      droppedMessages: 0,
    };
  }
  return {
    messages,
    compacted: true,
    beforeTokens,
    afterTokens,
    droppedMessages: older.length,
  };
}

export function createLlmSummarizer(model: Model<"openai-completions">, apiKey: string): Summarizer {
  return async (transcript) => {
    const result = await completeSimple(
      model,
      {
        systemPrompt:
          "You compress conversation context for another assistant. Preserve durable facts, user preferences, " +
          "decisions, constraints, file paths, open tasks, and errors. Drop pleasantries and repetition. " +
          "Write a compact structured summary; do not answer the conversation.",
        messages: [{ role: "user", content: `Summarize these earlier turns:\n\n${transcript}`, timestamp: Date.now() }],
      },
      { apiKey, maxTokens: SUMMARY_MAX_TOKENS, temperature: 0, signal: AbortSignal.timeout(60_000) },
    );
    if (result.stopReason === "error" || result.stopReason === "aborted") {
      throw new Error(result.errorMessage || "summary model failed");
    }
    const text = result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n").trim();
    if (!text) throw new Error("summary model returned no text");
    return text;
  };
}
