import type { Model } from "@mariozechner/pi-ai";
import type { AssistantConfig } from "./config.ts";

/**
 * The backend is any OpenAI-compatible /chat/completions endpoint (Ollama,
 * vLLM, LM Studio, ...). Model metadata is intentionally local: pi only uses it
 * for limits, pricing and compat flags.
 */
export function buildModel(config: AssistantConfig): Model<"openai-completions"> {
  return {
    id: config.modelId,
    name: config.modelId,
    api: "openai-completions",
    provider: "assistant-backend",
    baseUrl: config.apiUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
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
}
