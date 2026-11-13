import type { Model } from "@mariozechner/pi-ai";
import { REASONING_EFFORTS, type AssistantConfig } from "./config.ts";

/**
 * The backend is any OpenAI-compatible /chat/completions endpoint (Ollama,
 * vLLM, LM Studio, ...). Model metadata is intentionally local: pi only uses it
 * for limits, pricing and compat flags.
 */
export function buildModel(config: AssistantConfig): Model<"openai-completions"> {
  const reasoning =
    config.reasoningEffort !== "off" ||
    config.allowedReasoningEfforts.some((effort) => effort !== "off");
  return {
    id: config.modelId,
    name: config.modelId,
    api: "openai-completions",
    provider: "assistant-backend",
    baseUrl: config.apiUrl,
    reasoning,
    ...(reasoning ? { thinkingLevelMap: { xhigh: "xhigh" } } : {}),
    input: config.vision ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: reasoning,
      supportsUsageInStreaming: true,
      maxTokensField: "max_tokens",
      requiresToolResultName: false,
      requiresAssistantAfterToolResult: false,
      requiresThinkingAsText: false,
      supportsStrictMode: false,
      thinkingFormat: "openai",
    },
  };
}

/**
 * omp reads reasoning metadata from a `/v1/models` row (top level or under
 * `metadata`) to build its thinking-level picker: `supported_reasoning_levels`
 * is the ladder it may send, `none` means thinking can be off, and
 * `default_reasoning_level` must be one of them. Without the ladder the row is
 * treated as non-reasoning even when requests accept `reasoning_effort`.
 *
 * `reasoning_effort` (OpenAI Chat Completions) is the wire field; Responses
 * clients send `reasoning.effort`. Both map through the same effort list.
 */
export function modelMetadata(
  config: Pick<
    AssistantConfig,
    "reasoningEffort" | "allowedReasoningEfforts" | "contextWindow" | "maxTokens"
  >,
): Record<string, unknown> {
  return {
    ...modelReasoningMetadata(config),
    // omp reads `max_model_len` first, then `context_length`; OpenRouter and
    // vLLM both use the latter. `max_output_tokens` is the accepted output cap.
    context_length: config.contextWindow,
    max_output_tokens: config.maxTokens,
  };
}

export function modelReasoningMetadata(
  config: Pick<AssistantConfig, "reasoningEffort" | "allowedReasoningEfforts">,
): Record<string, unknown> {
  const efforts = Array.from(new Set([config.reasoningEffort, ...config.allowedReasoningEfforts]));
  // Canonical low→high order; the configured default need not be the first tier.
  const levels = REASONING_EFFORTS.filter((effort) => effort !== "off" && efforts.includes(effort));
  if (!levels.length) return {};
  const configuredDefault = config.reasoningEffort === "off" ? undefined : config.reasoningEffort;
  return {
    supported_reasoning_levels: [
      ...(efforts.includes("off") ? [{ effort: "none" }] : []),
      ...levels.map((effort) => ({ effort })),
    ],
    ...(configuredDefault ? { default_reasoning_level: configuredDefault } : {}),
  };
}
