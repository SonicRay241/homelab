import { resolve } from "node:path";

export interface InfisicalConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  projectId: string;
  environment: string;
  secretPath: string;
}

export interface AssistantConfig {
  port: number;
  hostname: string;
  /** OpenAI-compatible backend base URL, e.g. https://host/v1 */
  apiUrl: string;
  /** Backend credential. Never exposed to clients. */
  apiKey: string;
  /** Model id sent to the backend. */
  modelId: string;
  /** Model ids advertised by /v1/models (aliases map to the backend model). */
  modelIds: string[];
  contextWindow: number;
  maxTokens: number;
  /** Estimated input-token cap for one request; 0 disables the check. */
  maxInputTokens: number;
  /** Fraction of contextWindow that triggers automatic compaction; 0 disables it. */
  compactionThreshold: number;
  /** Number of recent conversation units kept verbatim after compaction. */
  compactionKeepTurns: number;
  dataDir: string;
  /** Root directory holding one subdirectory per selectable agent. */
  agentsDir: string;
  agentDir: string;
  agentId: string;
  infisical: InfisicalConfig;
  refreshMs: number;
  /** Optional local fallback merged with Infisical secrets: client key -> user id. */
  staticKeys: Map<string, string>;
}

const ROOT = resolve(import.meta.dir, "..");
const USER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function intEnv(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  return Math.floor(n);
}

function nonNegativeIntEnv(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

function ratioEnv(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`${name} must be between 0 and 1`);
  return n;
}

/**
 * Accepts either a JSON object ({"sk-key":"user"}), a JSON array
 * ([{"key":"sk-key","user":"alice"}]), or "key:user,key2:user2" pairs.
 */
export function parseApiKeys(raw: string | undefined): Map<string, string> {
  const keys = new Map<string, string>();
  const text = raw?.trim();
  if (!text) return keys;

  if (text.startsWith("{")) {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("ASSISTANT_API_KEYS object must map keys to user ids");
    }
    for (const [key, user] of Object.entries(parsed)) {
      if (typeof user !== "string") throw new Error("ASSISTANT_API_KEYS values must be user ids");
      keys.set(key.trim(), user.trim());
    }
  } else if (text.startsWith("[")) {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error("ASSISTANT_API_KEYS array must contain {key,user}");
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") throw new Error("ASSISTANT_API_KEYS array entries must be objects");
      if (!("key" in entry) || !("user" in entry)) {
        throw new Error("ASSISTANT_API_KEYS array entries need string key and user");
      }
      const key: unknown = entry.key;
      const user: unknown = entry.user;
      if (typeof key !== "string" || typeof user !== "string") {
        throw new Error("ASSISTANT_API_KEYS array entries need string key and user");
      }
      keys.set(key.trim(), user.trim());
    }
  } else {
    for (const pair of text.split(/[,;]\s*/)) {
      if (!pair) continue;
      const separator = pair.includes(":") ? ":" : "=";
      const index = pair.indexOf(separator);
      if (index < 0) {
        keys.set(pair.trim(), "default");
        continue;
      }
      keys.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim() || "default");
    }
  }

  for (const [key, user] of keys) {
    if (key.length < 12) throw new Error("ASSISTANT_API_KEYS contains a key shorter than 12 characters");
    if (!USER_ID.test(user)) throw new Error(`Invalid user id ${JSON.stringify(user)}; use [A-Za-z0-9_-], max 64 chars`);
  }
  return keys;
}

export function loadConfig(): AssistantConfig {
  const staticKeys = parseApiKeys(process.env.ASSISTANT_API_KEYS);
  const single = process.env.ASSISTANT_API_KEY?.trim();
  if (single) {
    if (single.length < 12) throw new Error("ASSISTANT_API_KEY must be at least 12 characters");
    const user = process.env.ASSISTANT_USER?.trim() || "default";
    if (!USER_ID.test(user)) throw new Error(`Invalid ASSISTANT_USER ${JSON.stringify(user)}`);
    staticKeys.set(single, user);
  }

  const modelId = (process.env.MODEL?.trim() || "beam:cloud");
  const aliases = (process.env.MODEL_ALIASES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const modelIds = Array.from(new Set([modelId, ...aliases]));

  const agentId = process.env.AGENT_ID?.trim() || "default";
  if (!USER_ID.test(agentId)) throw new Error(`Invalid AGENT_ID ${JSON.stringify(agentId)}`);
  const agentsDir = resolve(ROOT, process.env.AGENTS_DIR?.trim() || "agents");
  const agentDir = process.env.AGENT_DIR?.trim()
    ? resolve(ROOT, process.env.AGENT_DIR.trim())
    : resolve(agentsDir, agentId);

  return {
    port: intEnv("PORT", 8787),
    hostname: process.env.BIND_HOST?.trim() || "0.0.0.0",
    apiUrl: required("BASE_API_URL").replace(/\/+$/, ""),
    apiKey: required("API_KEY"),
    modelId,
    modelIds,
    contextWindow: intEnv("CONTEXT_WINDOW", 128_000),
    maxTokens: intEnv("MAX_TOKENS", 8_192),
    maxInputTokens: nonNegativeIntEnv("MAX_INPUT_TOKENS", 0),
    compactionThreshold: ratioEnv("COMPACTION_THRESHOLD", 0.75),
    compactionKeepTurns: Math.max(1, intEnv("COMPACTION_KEEP_TURNS", 6)),
    dataDir: resolve(ROOT, process.env.DATA_DIR?.trim() || "data"),
    agentsDir,
    agentDir,
    agentId,
    infisical: {
      baseUrl: required("INFISICAL_BASE_URL").replace(/\/+$/, ""),
      clientId: required("INFISICAL_CLIENT_ID"),
      clientSecret: required("INFISICAL_CLIENT_SECRET"),
      projectId: required("INFISICAL_PROJECT_ID"),
      environment: required("INFISICAL_ENV"),
      secretPath: optional("INFISICAL_SECRET_PATH", "/"),
    },
    refreshMs: Math.max(1_000, intEnv("TOKEN_REFRESH_MS", 60_000)),
    staticKeys,
  };
}
