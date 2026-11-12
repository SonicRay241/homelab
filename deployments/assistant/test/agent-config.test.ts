import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAgentOverrides, loadAgentOverrides } from "../src/agent-config.ts";
import { isUserAllowed, type AssistantConfig } from "../src/config.ts";

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
  vision: false,
  maxInputTokens: 0,
  compactionThreshold: 0.75,
  compactionKeepTurns: 6,
  memoryLimits: { memory: 2_200, user: 1_375 },
  basedir: "/tmp/assistant-data",
  agentsDir: "/tmp/assistant-agents",
  agentDir: "/tmp/assistant-agent",
  agentId: "default",
  allowedUsers: [],
  deniedUsers: [],
  otel: null,
  reasoningEffort: "off",
  allowedReasoningEfforts: [],
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
allowedUsers:
  - alice
  - bob
deniedUsers:
  - mallory
`);
    expect(loadAgentOverrides(dir)).toEqual({
      apiUrl: "https://other.example/v1",
      apiKey: "sk-other",
      model: "other:cloud",
      maxInputTokens: 9000,
      compactionThreshold: 0.5,
      compactionKeepTurns: 4,
      allowedUsers: ["alice", "bob"],
      deniedUsers: ["mallory"],
    });
  });

  it("reads reasoning effort and the per-request allowlist", async () => {
    const dir = await agentDir(`
reasoningEffort: high
allowedReasoningEfforts:
  - low
  - high
  - none
`);
    expect(loadAgentOverrides(dir)).toEqual({
      reasoningEffort: "high",
      allowedReasoningEfforts: ["low", "high", "off"],
    });
  });

  it("reads per-agent memory markdown limits", async () => {
    expect(loadAgentOverrides(await agentDir("memoryLimit: 500\nuserLimit: 90\n"))).toEqual({
      memoryLimit: 500,
      userLimit: 90,
    });
  });

  it("rejects invalid memory limits", async () => {
    for (const yaml of ["memoryLimit: 0\n", "memoryLimit: -1\n", "memoryLimit: 1.5\n", 'memoryLimit: "500"\n']) {
      await expect(async () => loadAgentOverrides(await agentDir(yaml))).toThrow("must be a positive integer");
    }
    await expect(async () => loadAgentOverrides(await agentDir("userLimit: 0\n"))).toThrow(
      "must be a positive integer",
    );
  });

  it("reads the vision flag", async () => {
    expect(loadAgentOverrides(await agentDir("vision: true\n"))).toEqual({ vision: true });
    expect(loadAgentOverrides(await agentDir("vision: false\n"))).toEqual({ vision: false });
  });

  it("rejects non-boolean vision values", async () => {
    await expect(async () => loadAgentOverrides(await agentDir('vision: "true"\n'))).toThrow(
      "must be true or false",
    );
    await expect(async () => loadAgentOverrides(await agentDir("vision: 1\n"))).toThrow("must be true or false");
  });

  it("rejects invalid reasoning effort values", async () => {
    await expect(async () => loadAgentOverrides(await agentDir("reasoningEffort: turbo\n"))).toThrow(
      "must be one of",
    );
    await expect(async () => loadAgentOverrides(await agentDir("allowedReasoningEfforts: low\n"))).toThrow(
      "must be an array",
    );
    await expect(async () => loadAgentOverrides(await agentDir("allowedReasoningEfforts: [turbo]\n"))).toThrow(
      "must be one of",
    );
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
    await expect(async () => loadAgentOverrides(await agentDir("allowedUsers: alice\n"))).toThrow(
      "must be an array",
    );
    await expect(async () => loadAgentOverrides(await agentDir("allowedUsers: [bad/user]\n"))).toThrow(
      "invalid user id",
    );
    await expect(async () => loadAgentOverrides(await agentDir("deniedUsers: [123]\n"))).toThrow(
      "must be strings",
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

  it("overrides vision and keeps the base default otherwise", () => {
    expect(applyAgentOverrides(BASE, { vision: true }).vision).toBe(true);
    expect(applyAgentOverrides(BASE, {}).vision).toBe(false);
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

  it("overrides each memory markdown limit independently", () => {
    expect(applyAgentOverrides(BASE, { memoryLimit: 4_000 }).memoryLimits).toEqual({
      memory: 4_000,
      user: 1_375,
    });
    expect(applyAgentOverrides(BASE, { userLimit: 800 }).memoryLimits).toEqual({
      memory: 2_200,
      user: 800,
    });
    expect(applyAgentOverrides(BASE, {}).memoryLimits).toEqual({ memory: 2_200, user: 1_375 });
    expect(BASE.memoryLimits).toEqual({ memory: 2_200, user: 1_375 });
  });

  it("overrides reasoning effort and allowlist", () => {
    const config = applyAgentOverrides(BASE, {
      reasoningEffort: "medium",
      allowedReasoningEfforts: ["low", "medium", "high"],
    });
    expect(config.reasoningEffort).toBe("medium");
    expect(config.allowedReasoningEfforts).toEqual(["low", "medium", "high"]);
    expect(BASE.reasoningEffort).toBe("off");
  });

  it("overrides access lists", () => {
    const config = applyAgentOverrides(BASE, { allowedUsers: ["alice"], deniedUsers: ["mallory"] });
    expect(config.allowedUsers).toEqual(["alice"]);
    expect(config.deniedUsers).toEqual(["mallory"]);
    expect(isUserAllowed(config, "alice")).toBe(true);
    expect(isUserAllowed(config, "bob")).toBe(false);
    expect(isUserAllowed(config, "mallory")).toBe(false);
    expect(isUserAllowed(BASE, "anyone")).toBe(true);
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
