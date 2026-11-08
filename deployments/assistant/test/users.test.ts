import { describe, expect, it } from "bun:test";
import type { InfisicalClient, SecretEntry } from "../src/auth/infisical.ts";
import { hashToken, requestToken, UserRegistry } from "../src/auth/users.ts";

class FakeClient implements InfisicalClient {
  secrets: SecretEntry[] = [];
  error: Error | undefined;

  async listSecrets(): Promise<SecretEntry[]> {
    if (this.error) throw this.error;
    return this.secrets;
  }
}

describe("UserRegistry", () => {
  it("resolves Infisical secret values and uses secret names as user ids", async () => {
    const client = new FakeClient();
    client.secrets = [
      { name: "Mifu", value: "key-mifu-0123456789" },
      { name: "Ray", value: "key-ray-0123456789" },
    ];
    const registry = new UserRegistry(client, 60_000);

    expect(registry.ready).toBe(false);
    expect(await registry.refresh()).toBe(2);
    expect(registry.ready).toBe(true);
    expect(registry.resolve("key-mifu-0123456789")).toBe("Mifu");
    expect(registry.resolve("key-ray-0123456789")).toBe("Ray");
    expect(registry.resolve("unknown")).toBeNull();
  });

  it("keeps the last known good set when a refresh fails or is empty", async () => {
    const client = new FakeClient();
    client.secrets = [{ name: "Mifu", value: "key-mifu-0123456789" }];
    const registry = new UserRegistry(client, 60_000);
    await registry.refresh();

    client.error = new Error("network down");
    await expect(registry.refresh()).rejects.toThrow("network down");
    expect(registry.resolve("key-mifu-0123456789")).toBe("Mifu");

    client.error = undefined;
    client.secrets = [];
    await expect(registry.refresh()).rejects.toThrow("no usable secrets");
    expect(registry.resolve("key-mifu-0123456789")).toBe("Mifu");
  });

  it("merges optional static fallback keys and skips invalid secret names", async () => {
    const client = new FakeClient();
    client.secrets = [
      { name: "Ray", value: "key-ray-0123456789" },
      { name: "../evil", value: "key-evil-0123456789" },
      { name: "", value: "key-empty-0123456789" },
    ];
    const registry = new UserRegistry(client, 60_000, new Map([["key-local-0123456789", "local"]]));
    expect(registry.resolve("key-local-0123456789")).toBe("local");

    await registry.refresh();
    expect(registry.size).toBe(2);
    expect(registry.resolve("key-local-0123456789")).toBe("local");
    expect(registry.resolve("key-ray-0123456789")).toBe("Ray");
    expect(registry.resolve("key-evil-0123456789")).toBeNull();
  });

  it("fails closed when no keys are available", async () => {
    const registry = new UserRegistry(new FakeClient(), 60_000);
    await expect(registry.refresh()).rejects.toThrow();
    expect(registry.ready).toBe(false);
  });
});

describe("requestToken", () => {
  it("accepts bearer, x-api-key and api-key headers", () => {
    expect(requestToken(new Request("http://x", { headers: { authorization: "Bearer abc" } }))).toBe("abc");
    expect(requestToken(new Request("http://x", { headers: { "x-api-key": "def" } }))).toBe("def");
    expect(requestToken(new Request("http://x", { headers: { "api-key": "ghi" } }))).toBe("ghi");
    expect(requestToken(new Request("http://x"))).toBe("");
  });
});

describe("hashToken", () => {
  it("is stable and does not contain the raw key", () => {
    const token = "sk-pi-secret-value";
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).toHaveLength(64);
    expect(hashToken(token)).not.toContain(token);
  });
});
