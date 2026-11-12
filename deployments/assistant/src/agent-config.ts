import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  isValidUserId,
  normalizeReasoningEffort,
  REASONING_EFFORTS,
  type AssistantConfig,
  type ReasoningEffort,
} from "./config.ts";
import { isRecord } from "./guards.ts";

export const AGENT_CONFIG_FILE = "config.yaml";
const ALLOWED_KEYS = new Set([
  "apiUrl",
  "apiKey",
  "model",
  "vision",
  "maxInputTokens",
  "compactionThreshold",
  "compactionKeepTurns",
  "memoryLimit",
  "userLimit",
  "allowedUsers",
  "deniedUsers",
  "reasoningEffort",
  "allowedReasoningEfforts",
]);

export interface AgentOverrides {
  apiUrl?: string;
  apiKey?: string;
  model?: string;
  vision?: boolean;
  maxInputTokens?: number;
  compactionThreshold?: number;
  compactionKeepTurns?: number;
  /** Character budget for MEMORY.md. */
  memoryLimit?: number;
  /** Character budget for USER.md. */
  userLimit?: number;
  allowedUsers?: string[];
  deniedUsers?: string[];
  reasoningEffort?: ReasoningEffort;
  allowedReasoningEfforts?: ReasoningEffort[];
}

function userList(value: unknown, key: string, file: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${file}: ${key} must be an array of user ids`);
  const users: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") throw new Error(`${file}: ${key} entries must be strings`);
    const user = entry.trim();
    if (!isValidUserId(user)) {
      throw new Error(`${file}: ${key} contains an invalid user id ${JSON.stringify(user)}`);
    }
    users.push(user);
  }
  return Array.from(new Set(users));
}

function reasoningEffortValue(value: unknown, key: string, file: string): ReasoningEffort {
  if (typeof value !== "string") throw new Error(`${file}: ${key} must be a string`);
  const effort = normalizeReasoningEffort(value);
  if (!effort) throw new Error(`${file}: ${key} must be one of: ${REASONING_EFFORTS.join(", ")}`);
  return effort;
}

function reasoningEffortList(value: unknown, key: string, file: string): ReasoningEffort[] {
  if (!Array.isArray(value)) throw new Error(`${file}: ${key} must be an array of efforts`);
  return Array.from(new Set(value.map((entry) => reasoningEffortValue(entry, key, file))));
}

function positiveInteger(value: unknown, key: string, file: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${file}: ${key} must be a positive integer`);
  }
  return value;
}

function stringValue(value: unknown, key: string, file: string): string {
  if (typeof value !== "string") throw new Error(`${file}: ${key} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${file}: ${key} must not be empty`);
  return trimmed;
}

function booleanValue(value: unknown, key: string, file: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${file}: ${key} must be true or false`);
  return value;
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
  if ("vision" in parsed) overrides.vision = booleanValue(parsed.vision, "vision", file);
  if ("maxInputTokens" in parsed) {
    const value = parsed.maxInputTokens;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new Error(`${file}: maxInputTokens must be a non-negative integer`);
    }
    overrides.maxInputTokens = value;
  }
  if ("compactionThreshold" in parsed) {
    const value = parsed.compactionThreshold;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`${file}: compactionThreshold must be between 0 and 1`);
    }
    overrides.compactionThreshold = value;
  }
  if ("compactionKeepTurns" in parsed) {
    const value = parsed.compactionKeepTurns;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      throw new Error(`${file}: compactionKeepTurns must be a positive integer`);
    }
    overrides.compactionKeepTurns = value;
  }
  if ("memoryLimit" in parsed) overrides.memoryLimit = positiveInteger(parsed.memoryLimit, "memoryLimit", file);
  if ("userLimit" in parsed) overrides.userLimit = positiveInteger(parsed.userLimit, "userLimit", file);
  if ("allowedUsers" in parsed) overrides.allowedUsers = userList(parsed.allowedUsers, "allowedUsers", file);
  if ("deniedUsers" in parsed) overrides.deniedUsers = userList(parsed.deniedUsers, "deniedUsers", file);
  if ("reasoningEffort" in parsed) {
    overrides.reasoningEffort = reasoningEffortValue(parsed.reasoningEffort, "reasoningEffort", file);
  }
  if ("allowedReasoningEfforts" in parsed) {
    overrides.allowedReasoningEfforts = reasoningEffortList(
      parsed.allowedReasoningEfforts,
      "allowedReasoningEfforts",
      file,
    );
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
    vision: overrides.vision ?? config.vision,
    maxInputTokens: overrides.maxInputTokens ?? config.maxInputTokens,
    compactionThreshold: overrides.compactionThreshold ?? config.compactionThreshold,
    compactionKeepTurns: overrides.compactionKeepTurns ?? config.compactionKeepTurns,
    memoryLimits: {
      memory: overrides.memoryLimit ?? config.memoryLimits.memory,
      user: overrides.userLimit ?? config.memoryLimits.user,
    },
    allowedUsers: overrides.allowedUsers ?? config.allowedUsers,
    deniedUsers: overrides.deniedUsers ?? config.deniedUsers,
    reasoningEffort: overrides.reasoningEffort ?? config.reasoningEffort,
    allowedReasoningEfforts: overrides.allowedReasoningEfforts ?? config.allowedReasoningEfforts,
    // A model override replaces the advertised list; env aliases belong to the default model.
    modelIds: overrides.model ? [modelId] : config.modelIds,
  };
}

/** Writes the agent's config.yaml from parsed overrides (used by the CLI). */
export function writeAgentOverrides(agentDir: string, overrides: AgentOverrides): void {
  mkdirSync(agentDir, { recursive: true });
  const clean = Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined));
  writeFileSync(join(agentDir, AGENT_CONFIG_FILE), Bun.YAML.stringify(clean, null, 2), "utf8");
}
