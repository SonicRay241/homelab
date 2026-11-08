import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultAgent, discoverAgents, resolveAgent } from "../src/agents.ts";
import type { AssistantConfig } from "../src/config.ts";

const dirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function agent(root: string, name: string, config?: string): Promise<void> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SOUL.md"), `You are ${name}.`, "utf8");
  if (config !== undefined) await writeFile(join(dir, "config.yaml"), config, "utf8");
}

function baseConfig(agentsDir: string, agentDir: string): AssistantConfig {
  return {
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
    agentsDir,
    agentDir,
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
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("discoverAgents", () => {
  it("lists SOUL.md directories plus the env default, with per-agent config applied", async () => {
    const root = await tempDir("assistant-agents-");
    const defaultDir = await tempDir("assistant-default-");
    await writeFile(join(defaultDir, "SOUL.md"), "You are the default.", "utf8");
    await agent(root, "alpha", "model: alpha:cloud\napiKey: alpha-key\nmaxInputTokens: 4000\n");
    await agent(root, "beta");

    const base = baseConfig(root, defaultDir);
    const agents = discoverAgents(base);

    expect(agents.map((entry) => entry.id)).toEqual(["default", "alpha", "beta"]);
    expect(agents[0]?.config.agentDir).toBe(defaultDir);
    expect(agents[0]?.model.id).toBe("env-model");

    const alpha = agents.find((entry) => entry.id === "alpha");
    expect(alpha?.config.agentId).toBe("alpha");
    expect(alpha?.config.agentDir).toBe(join(root, "alpha"));
    expect(alpha?.config.apiKey).toBe("alpha-key");
    expect(alpha?.config.modelId).toBe("alpha:cloud");
    expect(alpha?.config.modelIds).toEqual(["alpha:cloud"]);
    expect(alpha?.config.maxInputTokens).toBe(4000);
    expect(alpha?.model.id).toBe("alpha:cloud");
  });

  it("skips directories without SOUL.md and invalid names", async () => {
    const root = await tempDir("assistant-agents-");
    const defaultDir = await tempDir("assistant-default-");
    await writeFile(join(defaultDir, "SOUL.md"), "default", "utf8");
    await mkdir(join(root, "no-soul"), { recursive: true });
    await writeFile(join(root, "no-soul", "config.yaml"), "model: x\n", "utf8");
    await mkdir(join(root, "bad:name"), { recursive: true });
    await writeFile(join(root, "bad:name", "SOUL.md"), "bad", "utf8");

    const agents = discoverAgents(baseConfig(root, defaultDir));
    expect(agents.map((entry) => entry.id)).toEqual(["default"]);
  });

  it("lets the env-configured default win over a same-named scan directory", async () => {
    const root = await tempDir("assistant-agents-");
    const defaultDir = await tempDir("assistant-default-");
    await writeFile(join(defaultDir, "SOUL.md"), "env default", "utf8");
    await agent(root, "default", "model: scan:cloud\n");

    const agents = discoverAgents(baseConfig(root, defaultDir));
    expect(agents).toHaveLength(1);
    expect(agents[0]?.config.agentDir).toBe(defaultDir);
    expect(agents[0]?.config.modelId).toBe("env-model");
  });
});

describe("resolveAgent", () => {
  it("selects by agent id, falls back to backend aliases for the default, and rejects unknowns", async () => {
    const root = await tempDir("assistant-agents-");
    const defaultDir = await tempDir("assistant-default-");
    await writeFile(join(defaultDir, "SOUL.md"), "default", "utf8");
    await agent(root, "alpha");

    const agents = discoverAgents(baseConfig(root, defaultDir));

    expect(defaultAgent(agents, "default")?.id).toBe("default");
    expect(resolveAgent(agents, "default", undefined)?.id).toBe("default");
    expect(resolveAgent(agents, "default", "alpha")?.id).toBe("alpha");
    expect(resolveAgent(agents, "default", "env-model")?.id).toBe("default");
    expect(resolveAgent(agents, "default", "env-alias")?.id).toBe("default");
    expect(resolveAgent(agents, "default", "nope")).toBeUndefined();
  });
});
