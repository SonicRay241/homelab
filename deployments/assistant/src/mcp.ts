import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type, type ImageContent, type TextContent } from "@mariozechner/pi-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isRecord } from "./guards.ts";
import { MCP_TOOL_PREFIX } from "./tools.ts";

export const MCP_CONFIG_FILES = ["mcp.json", ".mcp.json"] as const;

const SERVER_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const DEFAULT_TIMEOUT = 30_000;
/** Effectively disabled; the SDK has no "no timeout" sentinel. */
const NO_TIMEOUT = 2_147_483_647;
const MAX_TOOL_NAME = 64;

export type McpTransportType = "stdio" | "http" | "sse";

export interface McpServerConfig {
  name: string;
  type: McpTransportType;
  enabled: boolean;
  timeout: number;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

export interface McpConfig {
  servers: McpServerConfig[];
  disabled: Set<string>;
  enabled: Set<string>;
}

export interface McpAgentConnection {
  tools: AgentTool[];
  servers: string[];
  close: () => Promise<void>;
}

function emptyConnection(): McpAgentConnection {
  return { tools: [], servers: [], close: async () => {} };
}

export function mcpConfigFile(agentDir: string): string | undefined {
  for (const name of MCP_CONFIG_FILES) {
    const file = join(agentDir, name);
    if (existsSync(file)) return file;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Expands ${VAR} from the assistant process environment, matching OMP's MCP config. */
function expandEnv(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => process.env[name] ?? "");
}

function stringValue(value: unknown, key: string, file: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${file}: ${key} must be a non-empty string`);
  return expandEnv(value);
}

function stringArray(value: unknown, key: string, file: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${file}: ${key} must be an array of strings`);
  }
  return value.map((entry) => expandEnv(entry));
}

function stringMap(value: unknown, key: string, file: string): Record<string, string> {
  if (!isRecord(value)) throw new Error(`${file}: ${key} must be an object of strings`);
  const map: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry !== "string") throw new Error(`${file}: ${key}.${name} must be a string`);
    map[name] = expandEnv(entry);
  }
  return map;
}

function stringSet(value: unknown, key: string, file: string): Set<string> {
  if (value === undefined) return new Set();
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${file}: ${key} must be an array of strings`);
  }
  return new Set(value);
}

function serverConfig(name: string, raw: unknown, file: string, agentDir: string): McpServerConfig {
  if (!isRecord(raw)) throw new Error(`${file}: mcpServers.${name} must be an object`);

  const type = raw.type ?? (typeof raw.command === "string" ? "stdio" : typeof raw.url === "string" ? "http" : "stdio");
  if (type !== "stdio" && type !== "http" && type !== "sse") {
    throw new Error(`${file}: mcpServers.${name}.type must be stdio, http, or sse`);
  }

  const enabled = raw.enabled === undefined ? true : raw.enabled;
  if (typeof enabled !== "boolean") throw new Error(`${file}: mcpServers.${name}.enabled must be a boolean`);

  const timeout = raw.timeout === undefined ? DEFAULT_TIMEOUT : raw.timeout;
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 0) {
    throw new Error(`${file}: mcpServers.${name}.timeout must be a non-negative number`);
  }

  if (type === "stdio") {
    const command = stringValue(raw.command, `mcpServers.${name}.command`, file);
    const args = raw.args === undefined ? [] : stringArray(raw.args, `mcpServers.${name}.args`, file);
    const env = raw.env === undefined ? undefined : stringMap(raw.env, `mcpServers.${name}.env`, file);
    let cwd: string | undefined;
    if (raw.cwd !== undefined) {
      const expanded = stringValue(raw.cwd, `mcpServers.${name}.cwd`, file);
      cwd = isAbsolute(expanded) ? expanded : resolve(agentDir, expanded);
    }
    return { name, type, enabled, timeout, command, args, env, cwd };
  }

  const url = stringValue(raw.url, `mcpServers.${name}.url`, file);
  const headers =
    raw.headers === undefined ? undefined : stringMap(raw.headers, `mcpServers.${name}.headers`, file);
  return { name, type, enabled, timeout, url, headers };
}

/** Parses the standard mcp.json shape (with the OMP discovery-only root lists). */
export function parseMcpConfig(value: unknown, file: string, agentDir: string): McpConfig {
  if (!isRecord(value)) throw new Error(`${file}: expected a JSON object`);
  const servers: McpServerConfig[] = [];
  if (value.mcpServers !== undefined) {
    if (!isRecord(value.mcpServers)) throw new Error(`${file}: mcpServers must be an object`);
    for (const [name, raw] of Object.entries(value.mcpServers)) {
      if (!SERVER_NAME.test(name)) {
        throw new Error(`${file}: invalid MCP server name ${JSON.stringify(name)} (use [A-Za-z0-9_.-], max 100)`);
      }
      servers.push(serverConfig(name, raw, file, agentDir));
    }
  }
  return {
    servers,
    disabled: stringSet(value.disabledServers, "disabledServers", file),
    enabled: stringSet(value.enabledServers, "enabledServers", file),
  };
}

function isEnabled(config: McpConfig, server: McpServerConfig): boolean {
  if (config.disabled.has(server.name)) return false;
  return server.enabled || config.enabled.has(server.name);
}

function requestTimeout(server: McpServerConfig): number {
  return server.timeout > 0 ? server.timeout : NO_TIMEOUT;
}

function transportFor(server: McpServerConfig): Transport {
  if (server.type === "stdio") {
    return new StdioClientTransport({
      command: server.command ?? "",
      args: server.args,
      env: server.env,
      cwd: server.cwd,
      stderr: "inherit",
    });
  }

  if (!server.url) throw new Error(`MCP server ${server.name} has no URL`);
  const url = new URL(server.url);
  const headers = server.headers;
  if (server.type === "http") {
    return new StreamableHTTPClientTransport(url, headers ? { requestInit: { headers } } : undefined);
  }

  return new SSEClientTransport(url, {
    requestInit: headers ? { headers } : undefined,
    eventSourceInit: headers
      ? {
          fetch: async (input, init) => {
            const merged = new Headers(init.headers);
            for (const [key, value] of Object.entries(headers)) {
              if (!merged.has(key)) merged.set(key, value);
            }
            return fetch(input, { ...init, headers: merged });
          },
        }
      : undefined,
  });
}

async function connect(server: McpServerConfig): Promise<Client> {
  const transport = transportFor(server);
  const client = new Client({ name: "pi-assistant", version: "1.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport, { timeout: requestTimeout(server) });
    return client;
  } catch (error) {
    await transport.close().catch(() => {});
    throw error;
  }
}

async function listTools(client: Client, timeout: number): Promise<McpTool[]> {
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: timeout > 0 ? timeout : NO_TIMEOUT });
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

function sanitizePart(value: string, fallback: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return sanitized || fallback;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function capToolName(name: string): string {
  if (name.length <= MAX_TOOL_NAME) return name;
  const suffix = `_${hash(name)}`;
  return `${name.slice(0, MAX_TOOL_NAME - suffix.length)}${suffix}`;
}

/** OMP-compatible public name: mcp__<server>_<tool>, max 64 chars. */
export function createMcpToolName(serverName: string, toolName: string): string {
  const server = sanitizePart(serverName, "server");
  let tool = sanitizePart(toolName, "tool");
  if (tool.startsWith(`${server}_`)) tool = tool.slice(server.length + 1);
  return capToolName(`${MCP_TOOL_PREFIX}${server}_${tool}`);
}

function mcpToolName(serverName: string, toolName: string, used: Set<string>): string {
  const base = createMcpToolName(serverName, toolName);
  let name = base;
  for (let attempt = 0; used.has(name); attempt++) {
    name = capToolName(`${base}_${hash(`${serverName}\0${toolName}\0${attempt}`)}`);
  }
  used.add(name);
  return name;
}

function textContent(text: string): TextContent {
  return { type: "text", text };
}

function asText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

interface MappedResult {
  content: (TextContent | ImageContent)[];
  text: string;
  structured: unknown;
  isError: boolean;
}

function mapResult(result: unknown): MappedResult {
  const record = isRecord(result) ? result : {};

  if ("toolResult" in record) {
    const text = asText(record.toolResult);
    return { content: [textContent(text)], text, structured: undefined, isError: false };
  }

  const content: (TextContent | ImageContent)[] = [];
  let pending = "";
  let text = "";
  const append = (value: string) => {
    pending += pending ? `\n${value}` : value;
    text += text ? `\n${value}` : value;
  };
  const flush = () => {
    if (pending) {
      content.push(textContent(pending));
      pending = "";
    }
  };

  for (const item of Array.isArray(record.content) ? record.content : []) {
    if (!isRecord(item)) continue;
    switch (item.type) {
      case "text":
        if (typeof item.text === "string") append(item.text);
        break;
      case "image":
        if (typeof item.data === "string" && typeof item.mimeType === "string") {
          flush();
          content.push({ type: "image", data: item.data, mimeType: item.mimeType });
        }
        break;
      case "resource": {
        const resource = isRecord(item.resource) ? item.resource : {};
        const uri = typeof resource.uri === "string" ? resource.uri : "unknown";
        if (typeof resource.text === "string") append(`[Resource: ${uri}]\n${resource.text}`);
        else append(`[Resource: ${uri}${typeof resource.blob === "string" ? " (blob)" : ""}]`);
        break;
      }
      case "resource_link": {
        const uri = typeof item.uri === "string" ? item.uri : "unknown";
        const name = typeof item.name === "string" ? item.name : "resource";
        append(`[Resource link: ${name} (${uri})]`);
        break;
      }
      case "audio":
        append(`[Audio${typeof item.mimeType === "string" ? `: ${item.mimeType}` : ""}]`);
        break;
      default:
        break;
    }
  }
  flush();

  if (content.length === 0 && record.structuredContent !== undefined) {
    const structured = asText(record.structuredContent);
    content.push(textContent(structured));
    text = structured;
  }
  if (content.length === 0) content.push(textContent(""));

  return {
    content,
    text,
    structured: record.structuredContent,
    isError: record.isError === true,
  };
}

function createTool(
  client: Client,
  server: McpServerConfig,
  tool: McpTool,
  name: string,
): AgentTool {
  const schema = isRecord(tool.inputSchema) && tool.inputSchema.type === "object"
    ? tool.inputSchema
    : { type: "object", properties: {}, additionalProperties: false };
  const description = tool.description?.trim() || `MCP tool ${tool.name} from ${server.name}`;
  const label = tool.annotations?.title?.trim() || tool.name;

  return {
    name,
    label: `${server.name}: ${label}`,
    description,
    parameters: Type.Unsafe(schema),
    execute: async (_toolCallId, params, signal) => {
      const args = isRecord(params) ? params : {};
      try {
        const result = await client.callTool(
          { name: tool.name, arguments: args },
          undefined,
          { signal, timeout: requestTimeout(server) },
        );
        const mapped = mapResult(result);
        if (mapped.isError) {
          throw new Error(mapped.text || `MCP tool ${server.name}/${tool.name} returned an error`);
        }
        return {
          content: mapped.content,
          details: {
            mcp: { server: server.name, tool: tool.name, structuredContent: mapped.structured },
          },
        };
      } catch (error) {
        throw new Error(`MCP tool ${server.name}/${tool.name} failed: ${errorMessage(error)}`);
      }
    },
  };
}

/**
 * Loads `<agentDir>/mcp.json` (or `.mcp.json`) and connects enabled servers.
 * Connection failures are logged and skipped; the agent still starts.
 */
export async function loadAgentMcp(agentDir: string): Promise<McpAgentConnection> {
  const file = mcpConfigFile(agentDir);
  if (!file) return emptyConnection();

  let config: McpConfig;
  try {
    config = parseMcpConfig(JSON.parse(readFileSync(file, "utf8")), file, agentDir);
  } catch (error) {
    console.error(`[mcp] ${file}: ${errorMessage(error)}`);
    return emptyConnection();
  }

  const clients: Client[] = [];
  const tools: AgentTool[] = [];
  const servers: string[] = [];
  const used = new Set<string>();
  const agent = agentDir.split(/[\\/]/).pop() || agentDir;

  for (const server of config.servers) {
    if (!isEnabled(config, server)) continue;
    let client: Client | undefined;
    try {
      client = await connect(server);
      const listed = await listTools(client, server.timeout);
      if (!listed.length) {
        console.log(`[mcp] agent=${agent} server=${server.name} tools=0 (closed)`);
        await client.close().catch(() => {});
        continue;
      }
      for (const tool of listed) {
        tools.push(createTool(client, server, tool, mcpToolName(server.name, tool.name, used)));
      }
      clients.push(client);
      servers.push(server.name);
      console.log(`[mcp] agent=${agent} server=${server.name} tools=${listed.length}`);
    } catch (error) {
      await client?.close().catch(() => {});
      console.error(`[mcp] agent=${agent} server=${server.name}: ${errorMessage(error)}`);
    }
  }

  return {
    tools,
    servers,
    close: async () => {
      await Promise.allSettled(clients.map((client) => client.close()));
    },
  };
}
