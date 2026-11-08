import { createHash } from "node:crypto";
import type { InfisicalClient } from "./infisical.ts";

const USER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Stable, non-reversible key id. Never store or log raw client keys. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Short key hash used for per-user session filtering and workspace directories. */
export function keyHash(token: string): string {
  return hashToken(token).slice(0, 16);
}

export function requestToken(request: Request): string {
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  return (bearer ?? request.headers.get("x-api-key") ?? request.headers.get("api-key") ?? "").trim();
}

/**
 * Infisical secret name -> user id, secret value -> client API key.
 * Refreshes atomically; a failed or empty fetch keeps the last known good set.
 * With no usable keys the registry is not ready and the server fails closed (503).
 */
export class UserRegistry {
  private users = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly staticUsers: Map<string, string>;

  constructor(
    private readonly client: InfisicalClient,
    private readonly refreshMs: number,
    staticKeys: Map<string, string> = new Map(),
  ) {
    this.staticUsers = new Map(
      Array.from(staticKeys, ([key, user]) => [hashToken(key), user] as const),
    );
    this.users = new Map(this.staticUsers);
  }

  get ready(): boolean {
    return this.users.size > 0;
  }

  get size(): number {
    return this.users.size;
  }

  /** User id for a bearer token, or null when the token is unknown. */
  resolve(token: string): string | null {
    if (!token) return null;
    return this.users.get(hashToken(token)) ?? null;
  }

  /** Replace the key set atomically. Throws on an empty result without touching current users. */
  async refresh(): Promise<number> {
    const secrets = await this.client.listSecrets();
    const next = new Map(this.staticUsers);
    const invalid: string[] = [];
    let loaded = 0;
    for (const secret of secrets) {
      const name = secret.name.trim();
      const value = secret.value.trim();
      if (!name || !value) continue;
      if (!USER_ID.test(name)) {
        invalid.push(name);
        continue;
      }
      next.set(hashToken(value), name);
      loaded++;
    }
    // ponytail: empty means a misconfigured path, not "revoke everyone"; keep the last good set.
    if (loaded === 0) throw new Error("Infisical returned no usable secrets");
    if (invalid.length) {
      console.warn(`[auth] ignoring secrets with invalid user ids: ${invalid.join(", ")}`);
    }
    this.users = next;
    return next.size;
  }

  async start(): Promise<void> {
    try {
      console.log(`[auth] loaded ${await this.refresh()} API keys`);
    } catch (error) {
      console.error(`[auth] initial key load failed, serving 503 until it succeeds: ${String(error)}`);
    }
    this.timer = setInterval(() => {
      this.refresh().catch((error) =>
        console.error(`[auth] key refresh failed, keeping previous keys: ${String(error)}`),
      );
    }, this.refreshMs);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
