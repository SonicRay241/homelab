import { discoverAgents, resolveAgent, type AgentDefinition } from "./src/agents.ts";
import { createInfisicalClient } from "./src/auth/infisical.ts";
import { keyHash, requestToken, UserRegistry } from "./src/auth/users.ts";
import { isUserAllowed, loadConfig } from "./src/config.ts";
import { isRecord } from "./src/guards.ts";
import { HandoffStore, handoffFile, renderHandoffMarkdown, type HandoffStatus } from "./src/handoffs.ts";
import { SseWriter } from "./src/openai.ts";
import { RequestError, runResponse } from "./src/runner.ts";
import { SessionStore, sessionFile } from "./src/sessions.ts";
import { parseTraceMode, type TraceMode } from "./src/trace.ts";

const baseConfig = loadConfig();
const agents = discoverAgents(baseConfig);
const agentIds = agents.map((agent) => agent.id);
const sessionStores = new Map(agents.map((agent) => [agent.id, new SessionStore(sessionFile(agent.config))]));
const handoffStore = new HandoffStore(handoffFile(baseConfig));
const registry = new UserRegistry(createInfisicalClient(baseConfig.infisical), baseConfig.refreshMs, baseConfig.staticKeys);

await registry.start();

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, x-api-key, api-key, openai-beta, x-pi-trace",
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: CORS });
}

function apiError(message: string, status: number, code: string, param: string | null = null): Response {
  const type = status === 401 ? "authentication_error" : status >= 500 ? "server_error" : "invalid_request_error";
  return json({ error: { message, type, param, code } }, status);
}

function modelList(allowed: AgentDefinition[]): Response {
  const created = Math.floor(Date.now() / 1_000);
  return json({
    object: "list",
    data: allowed.map((agent) => ({ id: agent.id, object: "model", created, owned_by: "pi-assistant" })),
  });
}

const HANDOFF_STATUSES = ["pending", "read", "consumed", "all"] as const;

function isHandoffStatus(value: string): value is HandoffStatus | "all" {
  return (HANDOFF_STATUSES as readonly string[]).includes(value);
}

function agentFromQuery(url: URL): AgentDefinition | undefined {
  const target = url.searchParams.get("target") ?? "";
  return agents.find((agent) => agent.id === target);
}

function requireAgentFromQuery(url: URL, userId: string): AgentDefinition | Response {
  const agent = agentFromQuery(url);
  if (!agent) {
    return apiError(`target query parameter must be one of: ${agentIds.join(", ")}`, 400, "invalid_agent");
  }
  if (!isUserAllowed(agent.config, userId)) {
    return apiError(`User ${userId} is not allowed to use agent ${agent.id}`, 403, "user_not_allowed");
  }
  return agent;
}

function streamResponse(
  agent: AgentDefinition,
  sessionStore: SessionStore,
  allowedAgentIds: string[],
  requestedModel: string,
  userId: string,
  userHash: string,
  trace: TraceMode,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const writer = new SseWriter(controller);
      try {
        await runResponse({
          config: agent.config,
          model: agent.model,
          requestedModel,
          userId,
          userHash,
          sessionStore,
          handoffStore,
          agentIds: allowedAgentIds,
          body,
          trace,
          sse: writer,
          signal,
        });
      } catch (error) {
        if (error instanceof RequestError) {
          writer.send("error", { code: error.code, message: error.message, param: null });
        } else {
          console.error("response failed", error);
          writer.send("error", {
            code: "server_error",
            message: error instanceof Error ? error.message : String(error),
            param: null,
          });
        }
      } finally {
        writer.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      ...CORS,
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

const server = Bun.serve({
  port: baseConfig.port,
  hostname: baseConfig.hostname,
  maxRequestBodySize: 32 * 1024 * 1024,
  idleTimeout: 255,
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (path === "/health") {
      return json({ ok: true, authReady: registry.ready, users: registry.size, agents: agents.map((agent) => agent.id) });
    }
    if (path === "/") return json({ name: "pi-assistant", endpoints: ["/v1/responses", "/v1/models", "/v1/handoffs"] });

    if (!registry.ready) return apiError("Service Unavailable: authentication backend not ready", 503, "service_unavailable");
    const token = requestToken(request);
    const userId = registry.resolve(token);
    if (!userId) return apiError("Missing or invalid API key", 401, "invalid_api_key");
    const userHash = keyHash(token);
    const allowedAgents = agents.filter((agent) => isUserAllowed(agent.config, userId));
    const allowedAgentIds = allowedAgents.map((agent) => agent.id);

    if (request.method === "GET" && (path === "/v1/models" || path === "/models")) return modelList(allowedAgents);
    if (request.method === "GET" && path.startsWith("/v1/models/")) {
      const id = decodeURIComponent(path.slice("/v1/models/".length));
      const agent = allowedAgents.find((entry) => entry.id === id);
      if (agent) {
        return json({ id, object: "model", created: Math.floor(Date.now() / 1_000), owned_by: "pi-assistant" });
      }
      if (agents.some((entry) => entry.id === id)) {
        return apiError(`User ${userId} is not allowed to use agent ${id}`, 403, "user_not_allowed");
      }
      return apiError(`Unknown model ${id}`, 404, "model_not_found");
    }

    if (request.method === "GET" && (path === "/v1/handoffs" || path === "/handoffs")) {
      const target = requireAgentFromQuery(url, userId);
      if (target instanceof Response) return target;
      const statusParam = url.searchParams.get("status") ?? "pending";
      if (!isHandoffStatus(statusParam)) {
        return apiError(`status must be one of: ${HANDOFF_STATUSES.join(", ")}`, 400, "invalid_status");
      }
      const rawLimit = Number(url.searchParams.get("limit") ?? 20);
      const limit = Number.isFinite(rawLimit) ? rawLimit : 20;
      return json({ object: "list", data: handoffStore.list(userHash, target.id, statusParam, limit) });
    }

    const consumeHandoff = path.match(/^\/(?:v1\/)?handoffs\/([^/]+)\/consume$/)?.[1];
    if (request.method === "POST" && consumeHandoff) {
      const target = requireAgentFromQuery(url, userId);
      if (target instanceof Response) return target;
      const id = decodeURIComponent(consumeHandoff);
      if (!handoffStore.consume(id, userHash, target.id)) {
        return apiError("Handoff not found", 404, "not_found");
      }
      return json({ success: true, id, status: "consumed" });
    }

    const handoffId = path.match(/^\/(?:v1\/)?handoffs\/([^/]+)$/)?.[1];
    if (request.method === "GET" && handoffId) {
      const target = requireAgentFromQuery(url, userId);
      if (target instanceof Response) return target;
      const record = handoffStore.get(decodeURIComponent(handoffId), userHash, target.id);
      if (!record) return apiError("Handoff not found", 404, "not_found");
      if (url.searchParams.get("format") === "markdown") {
        return new Response(renderHandoffMarkdown(record), {
          headers: { ...CORS, "content-type": "text/markdown; charset=utf-8" },
        });
      }
      return json(record);
    }

    const responseId = path.match(/^\/(?:v1\/)?responses\/([^/]+)$/)?.[1];
    if (request.method === "GET" && responseId) {
      const id = decodeURIComponent(responseId);
      for (const agent of allowedAgents) {
        const store = sessionStores.get(agent.id);
        const record = store?.get(id, userHash);
        if (record) return json(record.response);
      }
      return apiError("Response not found", 404, "not_found");
    }

    if (request.method === "POST" && (path === "/v1/responses" || path === "/responses")) {
      let parsed: unknown;
      try {
        parsed = await request.json();
      } catch {
        return apiError("Request body must be valid JSON", 400, "invalid_json");
      }
      if (!isRecord(parsed)) return apiError("Request body must be a JSON object", 400, "invalid_request");

      const agent = resolveAgent(agents, baseConfig.agentId, parsed.model);
      if (!agent) {
        return apiError(
          `Unknown model ${JSON.stringify(parsed.model)}. Available agents: ${allowedAgentIds.join(", ")}`,
          404,
          "model_not_found",
        );
      }
      if (!isUserAllowed(agent.config, userId)) {
        return apiError(`User ${userId} is not allowed to use agent ${agent.id}`, 403, "user_not_allowed");
      }
      const requestedModel =
        typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : agent.id;
      const sessionStore = sessionStores.get(agent.id);
      if (!sessionStore) return apiError(`No session store for agent ${agent.id}`, 500, "server_error");
      const trace = parseTraceMode(request.headers.get("x-pi-trace"));

      if (parsed.stream === true) {
        return streamResponse(
          agent,
          sessionStore,
          allowedAgentIds,
          requestedModel,
          userId,
          userHash,
          trace,
          parsed,
          request.signal,
        );
      }
      try {
        return json(
          await runResponse({
            config: agent.config,
            model: agent.model,
            requestedModel,
            userId,
            userHash,
            sessionStore,
            handoffStore,
            agentIds: allowedAgentIds,
            body: parsed,
            trace,
            signal: request.signal,
          }),
        );
      } catch (error) {
        if (error instanceof RequestError) return apiError(error.message, error.status, error.code);
        console.error("response failed", error);
        return apiError(error instanceof Error ? error.message : String(error), 500, "server_error");
      }
    }

    return apiError("Not found", 404, "not_found");
  },
});

console.log(
  `pi-assistant listening on http://${server.hostname}:${server.port} agents=${agents.map((agent) => agent.id).join(",")} ` +
    `auth=${registry.ready ? "ready" : "pending"} users=${registry.size} refresh=${baseConfig.refreshMs}ms`,
);

let stopping = false;
function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  console.log(`pi-assistant ${signal} received, shutting down`);
  registry.stop();
  for (const store of sessionStores.values()) store.close();
  handoffStore.close();
  server.stop();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
