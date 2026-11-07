export type InfisicalConfig = {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  projectId: string;
  environment: string;
  secretPath: string;
};

export type OtelConfig = {
  endpoint: string;
  serviceName: string;
};

export type Config = {
  port: number;
  ollamaUrl: string;
  /** Old SQLite usage file: replayed to OTLP once at startup, then renamed `.migrated`. */
  legacyDbPath: string;
  loggingDisabled: boolean;
  refreshMs: number;
  infisical: InfisicalConfig;
  otel: OtelConfig | null;
};

const asBool = (value: string | undefined) =>
  value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());

function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${key}`);
  return value;
}

function optional(env: Record<string, string | undefined>, key: string, fallback: string): string {
  const value = env[key]?.trim();
  return value || fallback;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const otelEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();

  return {
    port: Number.parseInt(optional(env, "PORT", "8080"), 10),
    ollamaUrl: optional(env, "OLLAMA_URL", "http://ollama:11434").replace(/\/+$/, ""),
    legacyDbPath: optional(env, "DB_PATH", "state/proxy-costs.db"),
    loggingDisabled: asBool(env.LOGGING_DISABLED),
    refreshMs: Math.max(1000, Number.parseInt(optional(env, "TOKEN_REFRESH_MS", "60000"), 10) || 60_000),
    infisical: {
      baseUrl: required(env, "INFISICAL_BASE_URL").replace(/\/+$/, ""),
      clientId: required(env, "INFISICAL_CLIENT_ID"),
      clientSecret: required(env, "INFISICAL_CLIENT_SECRET"),
      projectId: required(env, "INFISICAL_PROJECT_ID"),
      environment: required(env, "INFISICAL_ENV"),
      secretPath: optional(env, "INFISICAL_SECRET_PATH", "/"),
    },
    otel:
      asBool(env.OTEL_SDK_DISABLED) || !otelEndpoint
        ? null
        : { endpoint: otelEndpoint.replace(/\/+$/, ""), serviceName: optional(env, "OTEL_SERVICE_NAME", "ollama-gateway") },
  };
}
