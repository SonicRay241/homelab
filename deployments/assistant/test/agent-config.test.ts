import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAgentOverrides, loadAgentOverrides } from "../src/agent-config.ts";
import type { AssistantConfig } from "../src/config.ts";

const dirs: string[] = [];

async function agentDir(yaml?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "assistant-agent-"));
  dirs.push(dir);
  if (yaml !== undefined) await writeFile(join(dir, "config.yaml"), yaml, "utf8");
  return dir;
}

const BASE: AssistantConfig = {
  port: 8787,
  hostname: "0.0.0.0",
  apiUrl: "https://env.example/v1",
  apiKey: "env-key",
  modelId: "env-model",
  modelIds: ["env-model", "env-alias"],
  contextWindow: 128_000,
  maxTokens: 8_192,
  dataDir: "/tmp/assistant-data",
  agentDir: "/tmp/assistant-agent",
  agentId: "default",
  infisical: {
    baseUrl: "https://secrets.example",
    clientId: "id",
    clientSecret: "secret",
    projectId: "project",
    environment: "prod",
    secretPath: "/",
  },
  refreshMs: 60_000,
  staticKeys: new Map(),
};

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loadAgentOverrides", () => {
  it("returns no overrides when config.yaml is absent", async () => {
    expect(loadAgentOverrides(await agentDir())).toEqual({});
  });

  it("reads apiUrl, apiKey and model", async () => {
    const dir = await agentDir(`
apiUrl: https://other.example/v1/
apiKey: sk-other
model: other:cloud
`);
    expect(loadAgentOverrides(dir)).toEqual({
      apiUrl: "https://other.example/v1",
      apiKey: "sk-other",
      model: "other:cloud",
    });
  });

  it("treats comments and an empty file as no overrides", async () => {
    expect(loadAgentOverrides(await agentDir("# nothing here\n"))).toEqual({});
    expect(loadAgentOverrides(await agentDir(""))).toEqual({});
  });

  it("rejects unknown keys, non-strings and empty values", async () => {
    await expect(async () => loadAgentOverrides(await agentDir("model: x\napi_key: y\n"))).toThrow("unknown key");
    await expect(async () => loadAgentOverrides(await agentDir("model: 42\n"))).toThrow("must be a string");
    await expect(async () => loadAgentOverrides(await agentDir('apiUrl: "   "\n'))).toThrow("must not be empty");
    await expect(async () => loadAgentOverrides(await agentDir("- a\n- b\n"))).toThrow("expected a YAML mapping");
  });

  it("reports invalid YAML with the file name", async () => {
    await expect(async () => loadAgentOverrides(await agentDir("apiUrl: [\n"))).toThrow("invalid YAML");
  });
});

describe("applyAgentOverrides", () => {
  it("keeps .env defaults when the yaml is empty", () => {
    const config = applyAgentOverrides(BASE, {});
    expect(config.apiUrl).toBe(BASE.apiUrl);
    expect(config.apiKey).toBe(BASE.apiKey);
    expect(config.modelId).toBe(BASE.modelId);
    expect(config.modelIds).toEqual(["env-model", "env-alias"]);
  });

  it("overrides backend credentials and replaces the advertised model", () => {
    const config = applyAgentOverrides(BASE, {
      apiUrl: "https://other.example/v1",
      apiKey: "sk-other",
      model: "other:cloud",
    });
    expect(config.apiUrl).toBe("https://other.example/v1");
    expect(config.apiKey).toBe("sk-other");
    expect(config.modelId).toBe("other:cloud");
    expect(config.modelIds).toEqual(["other:cloud"]);
    expect(config.staticKeys).toBe(BASE.staticKeys);
    expect(BASE.modelId).toBe("env-model");
  });

  it("keeps the env model list when only credentials are overridden", () => {
    const config = applyAgentOverrides(BASE, { apiKey: "sk-other" });
    expect(config.modelId).toBe("env-model");
    expect(config.modelIds).toEqual(["env-model", "env-alias"]);
  });
});
