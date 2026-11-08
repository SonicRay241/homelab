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
  maxInputTokens: 0,
  compactionThreshold: 0.75,
  compactionKeepTurns: 6,
  dataDir: "/tmp/assistant-data",
  agentsDir: "/tmp/assistant-agents",
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

  it("reads apiUrl, apiKey, model and limits", async () => {
    const dir = await agentDir(`
apiUrl: https://other.example/v1/
apiKey: sk-other
model: other:cloud
maxInputTokens: 9000
compactionThreshold: 0.5
compactionKeepTurns: 4
`);
    expect(loadAgentOverrides(dir)).toEqual({
      apiUrl: "https://other.example/v1",
      apiKey: "sk-other",
      model: "other:cloud",
      maxInputTokens: 9000,
      compactionThreshold: 0.5,
      compactionKeepTurns: 4,
    });
  });

  it("allows maxInputTokens: 0 to disable the limit per agent", async () => {
    expect(loadAgentOverrides(await agentDir("maxInputTokens: 0\n"))).toEqual({ maxInputTokens: 0 });
  });

  it("treats comments and an empty file as no overrides", async () => {
    expect(loadAgentOverrides(await agentDir("# nothing here\n"))).toEqual({});
    expect(loadAgentOverrides(await agentDir(""))).toEqual({});
  });

  it("rejects unknown keys, non-strings, empty values and invalid limits", async () => {
    await expect(async () => loadAgentOverrides(await agentDir("model: x\napi_key: y\n"))).toThrow("unknown key");
    await expect(async () => loadAgentOverrides(await agentDir("model: 42\n"))).toThrow("must be a string");
    await expect(async () => loadAgentOverrides(await agentDir('apiUrl: "   "\n'))).toThrow("must not be empty");
    await expect(async () => loadAgentOverrides(await agentDir("- a\n- b\n"))).toThrow("expected a YAML mapping");
    await expect(async () => loadAgentOverrides(await agentDir("maxInputTokens: -1\n"))).toThrow(
      "non-negative integer",
    );
    await expect(async () => loadAgentOverrides(await agentDir("maxInputTokens: 1.5\n"))).toThrow(
      "non-negative integer",
    );
    await expect(async () => loadAgentOverrides(await agentDir('maxInputTokens: "100"\n'))).toThrow(
      "non-negative integer",
    );
    await expect(async () => loadAgentOverrides(await agentDir("compactionThreshold: 1.5\n"))).toThrow(
      "between 0 and 1",
    );
    await expect(async () => loadAgentOverrides(await agentDir("compactionThreshold: -0.1\n"))).toThrow(
      "between 0 and 1",
    );
    await expect(async () => loadAgentOverrides(await agentDir("compactionKeepTurns: 0\n"))).toThrow(
      "positive integer",
    );
    await expect(async () => loadAgentOverrides(await agentDir("compactionKeepTurns: 1.5\n"))).toThrow(
      "positive integer",
    );
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
    expect(config.maxInputTokens).toBe(0);
  });

  it("overrides the input token limit", () => {
    const config = applyAgentOverrides(BASE, { maxInputTokens: 32_000 });
    expect(config.maxInputTokens).toBe(32_000);
    expect(BASE.maxInputTokens).toBe(0);
  });

  it("overrides compaction settings", () => {
    const config = applyAgentOverrides(BASE, { compactionThreshold: 0.5, compactionKeepTurns: 4 });
    expect(config.compactionThreshold).toBe(0.5);
    expect(config.compactionKeepTurns).toBe(4);
    expect(BASE.compactionThreshold).toBe(0.75);
    expect(BASE.compactionKeepTurns).toBe(6);
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
