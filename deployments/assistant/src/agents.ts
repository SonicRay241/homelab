import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Model } from "@mariozechner/pi-ai";
import { applyAgentOverrides, loadAgentOverrides } from "./agent-config.ts";
import type { AssistantConfig } from "./config.ts";
import { buildModel } from "./model.ts";

const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface AgentDefinition {
  /** Directory name and `/v1/models` id. */
  id: string;
  dir: string;
  config: AssistantConfig;
  model: Model<"openai-completions">;
}

function defineAgent(base: AssistantConfig, id: string, dir: string): AgentDefinition {
  const overrides = loadAgentOverrides(dir);
  const config: AssistantConfig = { ...applyAgentOverrides(base, overrides), agentId: id, agentDir: dir };
  return { id, dir, config, model: buildModel(config) };
}

/**
 * Discovers selectable agents under `agentsDir` plus the env-configured default.
 * A subdirectory is an agent when it contains SOUL.md; its name is the model id.
 * The env agent wins if the same id is also present in the directory scan.
 */
export function discoverAgents(base: AssistantConfig): AgentDefinition[] {
  const agents = new Map<string, AgentDefinition>();
  agents.set(base.agentId, defineAgent(base, base.agentId, base.agentDir));

  if (existsSync(base.agentsDir)) {
    for (const entry of readdirSync(base.agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !AGENT_ID.test(entry.name) || agents.has(entry.name)) continue;
      const dir = join(base.agentsDir, entry.name);
      if (!existsSync(join(dir, "SOUL.md"))) continue;
      agents.set(entry.name, defineAgent(base, entry.name, dir));
    }
  }

  return [...agents.values()].sort((a, b) => {
    if (a.id === base.agentId) return -1;
    if (b.id === base.agentId) return 1;
    return a.id.localeCompare(b.id);
  });
}

/** The default agent, falling back to the first discovered one. */
export function defaultAgent(agents: AgentDefinition[], id: string): AgentDefinition | undefined {
  return agents.find((agent) => agent.id === id) ?? agents[0];
}

/**
 * Resolves the request's `model` field: agent id first, then the default agent's
 * backend model ids/aliases. Unknown ids return undefined.
 */
export function resolveAgent(
  agents: AgentDefinition[],
  defaultId: string,
  requestedModel: unknown,
): AgentDefinition | undefined {
  const model = typeof requestedModel === "string" ? requestedModel.trim() : "";
  if (!model) return defaultAgent(agents, defaultId);

  const byId = agents.find((agent) => agent.id === model);
  if (byId) return byId;

  const fallback = defaultAgent(agents, defaultId);
  return fallback?.config.modelIds.includes(model) ? fallback : undefined;
}
