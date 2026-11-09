#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAgentOverrides, writeAgentOverrides, type AgentOverrides } from "./src/agent-config.ts";
import { resolveBasedir, resolveAgentsDir } from "./src/basedir.ts";
import { isValidUserId } from "./src/config.ts";
import { mcpConfigFile, parseMcpConfig } from "./src/mcp.ts";

const CONFIG_EXAMPLE = `# Optional per-agent overrides. Everything unset comes from .env.
# This file is gitignored because apiKey is usually a secret.
#
# apiUrl: https://ollama.example.com/v1
# apiKey: sk-...
# model: beam:cloud
# maxInputTokens: 100000
# compactionThreshold: 0.75
# compactionKeepTurns: 6
# allowedUsers:
#   - alice
# deniedUsers:
#   - mallory
`;

const MCP_EXAMPLE = `{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {}
}
`;

const SET_KEYS = new Set([
  "apiUrl",
  "apiKey",
  "model",
  "maxInputTokens",
  "compactionThreshold",
  "compactionKeepTurns",
  "allowedUsers",
  "deniedUsers",
]);

function parseFlags(args: string[]): { positionals: string[]; flags: Map<string, string | true> } {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg?.startsWith("--")) {
      if (arg) positionals.push(arg);
      continue;
    }
    const parts = arg.slice(2).split("=", 2);
    const key = parts[0];
    if (!key) continue;
    const inline = parts[1];
    if (inline !== undefined) {
      flags.set(key, inline);
    } else {
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
    }
  }
  return { positionals, flags };
}

function splitUsers(value: string | true | undefined): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((user) => user.trim())
    .filter(Boolean);
}

function validateUser(user: string): string {
  if (!isValidUserId(user)) throw new Error(`invalid user id ${JSON.stringify(user)}`);
  return user;
}

function parseValue(key: string, raw: string): string | number | string[] {
  if (key === "allowedUsers" || key === "deniedUsers") {
    return raw
      .split(",")
      .map((user) => user.trim())
      .filter(Boolean)
      .map(validateUser);
  }
  if (key === "maxInputTokens") {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) throw new Error("maxInputTokens must be a non-negative integer");
    return value;
  }
  if (key === "compactionKeepTurns") {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) throw new Error("compactionKeepTurns must be a positive integer");
    return value;
  }
  if (key === "compactionThreshold") {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("compactionThreshold must be between 0 and 1");
    return value;
  }
  return raw;
}

function agentPath(name: string): string {
  const agentsDir = resolveAgentsDir(resolveBasedir());
  return join(agentsDir, name);
}

function requireAgent(name: string): string {
  if (!isValidUserId(name)) throw new Error(`invalid agent name ${JSON.stringify(name)}`);
  const dir = agentPath(name);
  if (!existsSync(join(dir, "SOUL.md"))) throw new Error(`agent not found: ${name}`);
  return dir;
}

function listAgents(): string[] {
  const agentsDir = resolveAgentsDir(resolveBasedir());
  if (!existsSync(agentsDir)) return [];
  return readdirSync(agentsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(agentsDir, entry.name, "SOUL.md")))
    .map((entry) => entry.name)
    .sort();
}

function cmdList(): void {
  const basedir = resolveBasedir();
  const agentsDir = resolveAgentsDir(basedir);
  const names = listAgents();
  if (!names.length) {
    console.log(`no agents under ${agentsDir}`);
    return;
  }
  for (const name of names) {
    const dir = join(agentsDir, name);
    const config = loadAgentOverrides(dir);
    const allow = config.allowedUsers?.join(",") || "*";
    const deny = config.deniedUsers?.join(",") || "-";
    console.log(`${name}\tmodel=${config.model ?? "(env)"}\tallow=${allow}\tdeny=${deny}\t${dir}`);
  }
}

function cmdNew(positionals: string[], flags: Map<string, string | true>): void {
  const name = positionals[0];
  if (!name) throw new Error("usage: bun run cli.ts new <agent> [--model M] [--api-url URL] [--api-key KEY]");
  if (!isValidUserId(name)) throw new Error(`invalid agent name ${JSON.stringify(name)}`);
  const dir = agentPath(name);
  if (existsSync(join(dir, "SOUL.md"))) throw new Error(`agent already exists: ${name}`);

  mkdirSync(dir, { recursive: true });
  const soul =
    typeof flags.get("soul") === "string"
      ? String(flags.get("soul"))
      : `You are ${name}, an assistant running in the pi agent harness.\n\nBe direct and factual. Use tools when they help.\n`;
  writeFileSync(join(dir, "SOUL.md"), soul, "utf8");
  writeFileSync(join(dir, "config.example.yaml"), CONFIG_EXAMPLE, "utf8");
  writeFileSync(join(dir, "mcp.example.json"), MCP_EXAMPLE, "utf8");

  const overrides: AgentOverrides = {};
  if (typeof flags.get("model") === "string") overrides.model = String(flags.get("model"));
  if (typeof flags.get("api-url") === "string") overrides.apiUrl = String(flags.get("api-url")).replace(/\/+$/, "");
  if (typeof flags.get("api-key") === "string") overrides.apiKey = String(flags.get("api-key"));
  const allow = splitUsers(flags.get("allow"));
  const deny = splitUsers(flags.get("deny"));
  if (allow.length) overrides.allowedUsers = allow.map(validateUser);
  if (deny.length) overrides.deniedUsers = deny.map(validateUser);
  if (Object.keys(overrides).length) writeAgentOverrides(dir, overrides);

  console.log(`created ${name} at ${dir}`);
}

function cmdShow(positionals: string[]): void {
  const name = positionals[0];
  if (!name) throw new Error("usage: bun run cli.ts show <agent>");
  const dir = requireAgent(name);
  const config = loadAgentOverrides(dir);
  const shown = { ...config, apiKey: config.apiKey ? "***" : undefined };
  console.log(Bun.YAML.stringify(shown, null, 2));
}

function cmdSet(positionals: string[]): void {
  const [name, key, value] = positionals;
  if (!name || !key || value === undefined) throw new Error("usage: bun run cli.ts set <agent> <key> <value>");
  if (!SET_KEYS.has(key)) throw new Error(`unknown key ${JSON.stringify(key)}; allowed: ${[...SET_KEYS].join(", ")}`);
  const dir = requireAgent(name);
  const config = loadAgentOverrides(dir);
  const parsed = parseValue(key, value);
  writeAgentOverrides(dir, { ...config, [key]: parsed });
  console.log(`set ${name}.${key}`);
}

function cmdUnset(positionals: string[]): void {
  const [name, key] = positionals;
  if (!name || !key) throw new Error("usage: bun run cli.ts unset <agent> <key>");
  if (!SET_KEYS.has(key)) throw new Error(`unknown key ${JSON.stringify(key)}`);
  const dir = requireAgent(name);
  const config = loadAgentOverrides(dir);
  delete config[key as keyof AgentOverrides];
  writeAgentOverrides(dir, config);
  console.log(`unset ${name}.${key}`);
}

function cmdAccess(positionals: string[], mode: "allow" | "deny"): void {
  const [name, ...users] = positionals;
  if (!name || !users.length) throw new Error(`usage: bun run cli.ts ${mode} <agent> <user...>`);
  const dir = requireAgent(name);
  const config = loadAgentOverrides(dir);
  const allowed = new Set(config.allowedUsers ?? []);
  const denied = new Set(config.deniedUsers ?? []);
  for (const user of users) {
    const valid = validateUser(user);
    if (mode === "allow") {
      allowed.add(valid);
      denied.delete(valid);
    } else {
      denied.add(valid);
      allowed.delete(valid);
    }
  }
  config.allowedUsers = [...allowed];
  config.deniedUsers = [...denied];
  writeAgentOverrides(dir, config);
  console.log(`${mode} ${name}: ${users.join(", ")}`);
}

function cmdRemove(positionals: string[], flags: Map<string, string | true>): void {
  const name = positionals[0];
  if (!name) throw new Error("usage: bun run cli.ts remove <agent> --yes");
  if (flags.get("yes") !== true) throw new Error("refusing to remove without --yes");
  const dir = requireAgent(name);
  rmSync(dir, { recursive: true, force: true });
  console.log(`removed ${name}`);
}

function cmdValidate(): void {
  let failed = false;
  for (const name of listAgents()) {
    try {
      const dir = requireAgent(name);
      loadAgentOverrides(dir);
      const mcpFile = mcpConfigFile(dir);
      if (mcpFile) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(readFileSync(mcpFile, "utf8"));
        } catch (error) {
          throw new Error(`${mcpFile}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
        }
        parseMcpConfig(parsed, mcpFile, dir);
      }
      console.log(`${name}\tok`);
    } catch (error) {
      failed = true;
      console.error(`${name}\t${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failed) process.exitCode = 1;
}

function main(): void {
  const { positionals, flags } = parseFlags(process.argv.slice(2));
  const command = positionals.shift();
  try {
    switch (command) {
      case "list":
        cmdList();
        break;
      case "new":
        cmdNew(positionals, flags);
        break;
      case "show":
        cmdShow(positionals);
        break;
      case "set":
        cmdSet(positionals);
        break;
      case "unset":
        cmdUnset(positionals);
        break;
      case "allow":
        cmdAccess(positionals, "allow");
        break;
      case "deny":
        cmdAccess(positionals, "deny");
        break;
      case "remove":
        cmdRemove(positionals, flags);
        break;
      case "validate":
        cmdValidate();
        break;
      case "path":
        console.log(JSON.stringify({ basedir: resolveBasedir(), agentsDir: resolveAgentsDir(resolveBasedir()) }));
        break;
      default:
        console.error(`usage: bun run cli.ts <list|new|show|set|unset|allow|deny|remove|validate|path>`);
        process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

main();
