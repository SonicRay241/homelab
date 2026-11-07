import { createHash } from "crypto";
import type { InfisicalClient } from "./infisical.ts";

/** Stable, non-reversible key id used in logs and telemetry. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

export class TokenRegistry {
  /** token hash -> username (Infisical secret name). */
  private users = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly client: InfisicalClient,
    private readonly refreshMs: number
  ) {}

  /** False when no tokens are loaded at all: requests must fail closed (503), not open. */
  get ready(): boolean {
    return this.users.size > 0;
  }

  get size(): number {
    return this.users.size;
  }

  /** Username for a bearer token, or null when the token is unknown. */
  resolve(token: string): string | null {
    if (!token) return null;
    return this.users.get(hashToken(token)) ?? null;
  }

  /** Replace the token set atomically; a failed or empty fetch keeps the last known good set. */
  async refresh(): Promise<number> {
    const secrets = await this.client.listSecrets();
    const next = new Map<string, string>();
    for (const secret of secrets) {
      const name = secret.name.trim();
      const value = secret.value.trim();
      if (name && value) next.set(hashToken(value), name);
    }
    // ponytail: empty result means a misconfigured path, not "revoke everyone"; keep last good set.
    if (next.size === 0) throw new Error("Infisical returned no secrets");
    this.users = next;
    return next.size;
  }

  async start(): Promise<void> {
    try {
      console.log(`[auth] loaded ${await this.refresh()} API tokens from Infisical`);
    } catch (err) {
      console.error(`[auth] initial token load failed, serving 503 until it succeeds: ${String(err)}`);
    }
    this.timer = setInterval(() => {
      // Successful refreshes are silent; token changes show up as auth outcomes.
      this.refresh().catch(err => console.error(`[auth] token refresh failed, keeping previous tokens: ${String(err)}`));
    }, this.refreshMs);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
