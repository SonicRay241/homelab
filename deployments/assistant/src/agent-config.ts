import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantConfig } from "./config.ts";
import { isRecord } from "./guards.ts";

export const AGENT_CONFIG_FILE = "config.yaml";
const ALLOWED_KEYS = new Set(["apiUrl", "apiKey", "model", "maxInputTokens"]);

export interface AgentOverrides {
  apiUrl?: string;
  apiKey?: string;
  model?: string;
  maxInputTokens?: number;
}

function stringValue(value: unknown, key: string, file: string): string {
  if (typeof value !== "string") throw new Error(`${file}: ${key} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${file}: ${key} must not be empty`);
  return trimmed;
}

/**
 * Reads optional per-agent backend overrides from `<agentDir>/config.yaml`.
 * `.env` stays authoritative for everything not listed here; a missing file is fine.
 * The file is gitignored because `apiKey` is usually a secret.
 */
export function loadAgentOverrides(agentDir: string): AgentOverrides {
  const file = join(agentDir, AGENT_CONFIG_FILE);
  if (!existsSync(file)) return {};

  const raw = readFileSync(file, "utf8");
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${file}: invalid YAML: ${message}`);
  }
  if (parsed === null || parsed === undefined) return {};
  if (!isRecord(parsed)) throw new Error(`${file}: expected a YAML mapping`);

  for (const key of Object.keys(parsed)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(`${file}: unknown key ${JSON.stringify(key)} (allowed: ${[...ALLOWED_KEYS].join(", ")})`);
    }
  }

  const overrides: AgentOverrides = {};
  if ("apiUrl" in parsed) overrides.apiUrl = stringValue(parsed.apiUrl, "apiUrl", file).replace(/\/+$/, "");
  if ("apiKey" in parsed) overrides.apiKey = stringValue(parsed.apiKey, "apiKey", file);
  if ("model" in parsed) overrides.model = stringValue(parsed.model, "model", file);
  if ("maxInputTokens" in parsed) {
    const value = parsed.maxInputTokens;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new Error(`${file}: maxInputTokens must be a non-negative integer`);
    }
    overrides.maxInputTokens = value;
  }
  return overrides;
}

/** Applies agent overrides on top of the required `.env` defaults without mutating the base config. */
export function applyAgentOverrides(config: AssistantConfig, overrides: AgentOverrides): AssistantConfig {
  const modelId = overrides.model ?? config.modelId;
  return {
    ...config,
    apiUrl: overrides.apiUrl ?? config.apiUrl,
    apiKey: overrides.apiKey ?? config.apiKey,
    modelId,
    maxInputTokens: overrides.maxInputTokens ?? config.maxInputTokens,
    // A model override replaces the advertised list; env aliases belong to the default model.
    modelIds: overrides.model ? [modelId] : config.modelIds,
  };
}
