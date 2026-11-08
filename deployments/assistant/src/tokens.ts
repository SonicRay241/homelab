import type { ImageContent, Message, TextContent, Tool } from "@mariozechner/pi-ai";

/** Rough token estimate for guardrails only; not a model tokenizer. */
const CHARS_PER_TOKEN = 4;
const IMAGE_TOKENS = 1_000;
const MESSAGE_OVERHEAD_TOKENS = 4;

function contentTokens(content: string | (TextContent | ImageContent)[]): number {
  if (typeof content === "string") return Math.ceil(content.length / CHARS_PER_TOKEN);
  let tokens = 0;
  for (const part of content) {
    tokens += part.type === "image" ? IMAGE_TOKENS : Math.ceil(part.text.length / CHARS_PER_TOKEN);
  }
  return tokens;
}

export function estimateMessageTokens(message: Message): number {
  if (message.role === "user") return contentTokens(message.content) + MESSAGE_OVERHEAD_TOKENS;

  if (message.role === "toolResult") {
    return (
      contentTokens(message.content) +
      Math.ceil(message.toolName.length / CHARS_PER_TOKEN) +
      MESSAGE_OVERHEAD_TOKENS
    );
  }

  let tokens = MESSAGE_OVERHEAD_TOKENS;
  for (const part of message.content) {
    if (part.type === "text") tokens += Math.ceil(part.text.length / CHARS_PER_TOKEN);
    else if (part.type === "thinking") tokens += Math.ceil(part.thinking.length / CHARS_PER_TOKEN);
    else if (part.type === "toolCall") {
      tokens += Math.ceil((part.name.length + JSON.stringify(part.arguments).length) / CHARS_PER_TOKEN);
    }
  }
  return tokens;
}

export function estimateToolTokens(tools: Tool[]): number {
  if (!tools.length) return 0;
  const schemas = tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  return Math.ceil(JSON.stringify(schemas).length / CHARS_PER_TOKEN);
}

/**
 * Estimates the full prompt: system prompt + messages + tool schemas.
 * Used for `MAX_INPUT_TOKENS` / `maxInputTokens`; approximate, conservative guardrail.
 */
export function estimateInputTokens(systemPrompt: string, messages: Message[], tools: Tool[]): number {
  let tokens = Math.ceil(systemPrompt.length / CHARS_PER_TOKEN) + estimateToolTokens(tools);
  for (const message of messages) tokens += estimateMessageTokens(message);
  return tokens;
}
