import { resolve } from "node:path";

export const PROJECT_ROOT = resolve(import.meta.dir, "..");

export function resolveBasedir(value: string | undefined = process.env.BASEDIR): string {
  return resolve(PROJECT_ROOT, value?.trim() || ".");
}

export function resolveAgentsDir(basedir: string, value: string | undefined = process.env.AGENTS_DIR): string {
  return resolve(basedir, value?.trim() || "agent");
}

export function resolveAgentDir(
  basedir: string,
  agentsDir: string,
  agentId: string,
  value: string | undefined = process.env.AGENT_DIR,
): string {
  const override = value?.trim();
  return override ? resolve(basedir, override) : resolve(agentsDir, agentId);
}
