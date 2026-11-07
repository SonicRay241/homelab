import type { InfisicalConfig } from "../config.ts";

export type InfisicalClient = {
  /** Secret values from the configured folder; each one is an API token. */
  listSecrets(): Promise<string[]>;
};

const TIMEOUT_MS = 10_000;
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

async function errorSnippet(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "";
  }
}

export function createInfisicalClient(cfg: InfisicalConfig): InfisicalClient {
  let cached: { token: string; expiresAt: number } | null = null;
  let pendingLogin: Promise<string> | null = null;

  function login(): Promise<string> {
    if (!pendingLogin) {
      pendingLogin = (async () => {
        const res = await fetch(`${cfg.baseUrl}/api/v1/auth/universal-auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientId: cfg.clientId, clientSecret: cfg.clientSecret }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`Infisical login failed: HTTP ${res.status} ${await errorSnippet(res)}`);

        const json = (await res.json()) as { accessToken?: string; expiresIn?: number };
        if (!json.accessToken) throw new Error("Infisical login response is missing accessToken");

        cached = {
          token: json.accessToken,
          expiresAt: Date.now() + (json.expiresIn ?? 3600) * 1000 - TOKEN_EXPIRY_MARGIN_MS,
        };
        return json.accessToken;
      })().finally(() => {
        pendingLogin = null;
      });
    }
    return pendingLogin;
  }

  async function accessToken(): Promise<string> {
    if (cached && cached.expiresAt > Date.now()) return cached.token;
    return login();
  }

  async function fetchSecrets(retryOnUnauthorized: boolean): Promise<string[]> {
    const query = new URLSearchParams({
      workspaceId: cfg.projectId,
      environment: cfg.environment,
      secretPath: cfg.secretPath,
    });
    const res = await fetch(`${cfg.baseUrl}/api/v3/secrets/raw?${query}`, {
      headers: { authorization: `Bearer ${await accessToken()}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (res.status === 401 && retryOnUnauthorized) {
      cached = null;
      return fetchSecrets(false);
    }
    if (!res.ok) throw new Error(`Infisical secrets request failed: HTTP ${res.status} ${await errorSnippet(res)}`);

    const json = (await res.json()) as { secrets?: { secretValue?: unknown }[] };
    return (json.secrets ?? []).flatMap(secret => (typeof secret.secretValue === "string" ? [secret.secretValue] : []));
  }

  return { listSecrets: () => fetchSecrets(true) };
}
