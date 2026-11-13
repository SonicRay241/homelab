import { discoverAgents, resolveAgent, type AgentDefinition } from "./src/agents.ts";
import { modelReasoningMetadata } from "./src/model.ts";
import { createInfisicalClient } from "./src/auth/infisical.ts";
import { keyHash, requestToken, UserRegistry } from "./src/auth/users.ts";
import { isUserAllowed, loadConfig } from "./src/config.ts";
import { isRecord } from "./src/guards.ts";
import { HandoffStore, handoffFile, renderHandoffMarkdown, type HandoffStatus } from "./src/handoffs.ts";
import {
  ChatCompletionStream,
  chatCompletionShape,
  chatRequestToResponses,
  SseWriter,
  type SseSink,
} from "./src/openai.ts";
import { RequestError, runResponse } from "./src/runner.ts";
import { SessionStore, sessionFile } from "./src/sessions.ts";
import { loadAgentMcp, type McpAgentConnection } from "./src/mcp.ts";
import { createTelemetry, type RequestTelemetry } from "./src/telemetry.ts";
import { parseTraceMode, type TraceMode } from "./src/trace.ts";

const baseConfig = loadConfig();
const telemetry = createTelemetry(baseConfig.otel);
const agents = discoverAgents(baseConfig);
const agentIds = agents.map((agent) => agent.id);
const mcpConnections = new Map<string, McpAgentConnection>();
for (const agent of agents) mcpConnections.set(agent.id, await loadAgentMcp(agent.dir));
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

/** Capabilities a `/v1/models` row may declare; omp reads these to build its effort picker. */
function modelRow(agent: AgentDefinition, id: string, created: number): Record<string, unknown> {
  return {
    id,
    object: "model",
    created,
    owned_by: "pi-assistant",
    ...modelReasoningMetadata(agent.config),
  };
}

function modelList(allowed: AgentDefinition[]): Response {
  const created = Math.floor(Date.now() / 1_000);
  return json({ object: "list", data: allowed.map((agent) => modelRow(agent, agent.id, created)) });
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

function routeFor(path: string): string {
  if (path === "/health" || path === "/") return path;
  if (path === "/models" || path === "/v1/models") return "/v1/models";
  if (path === "/responses" || path === "/v1/responses") return "/v1/responses";
  if (path === "/chat/completions" || path === "/v1/chat/completions") return "/v1/chat/completions";
  if (path === "/handoffs" || path === "/v1/handoffs") return "/v1/handoffs";
  if (path.startsWith("/models/") || path.startsWith("/v1/models/")) return "/v1/models/:id";
  if (path.startsWith("/responses/") || path.startsWith("/v1/responses/")) return "/v1/responses/:id";
  if (path.startsWith("/handoffs/") || path.startsWith("/v1/handoffs/")) {
    return /\/consume$/.test(path) ? "/v1/handoffs/:id/consume" : "/v1/handoffs/:id";
  }
  return "other";
}

function streamRun(
  requestTelemetry: RequestTelemetry,
  sinkFor: (controller: ReadableStreamDefaultController<Uint8Array>) => SseSink,
  run: (sink: SseSink) => Promise<unknown>,
): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const sink = sinkFor(controller);
      try {
        await run(sink);
      } catch (error) {
        requestTelemetry.fail(error);
        if (error instanceof RequestError) {
          sink.send("error", { code: error.code, message: error.message, param: null });
        } else {
          console.error("response failed", error);
          sink.send("error", {
            code: "server_error",
            message: error instanceof Error ? error.message : String(error),
            param: null,
          });
        }
      } finally {
        sink.close();
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

function streamResponse(
  agent: AgentDefinition,
  sessionStore: SessionStore,
  allowedAgentIds: string[],
  requestedModel: string,
  userId: string,
  userHash: string,
  knownUsers: string[],
  mcpTools: McpAgentConnection["tools"],
  requestTelemetry: RequestTelemetry,
  trace: TraceMode,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Response {
  return streamRun(
    requestTelemetry,
    (controller) => new SseWriter(controller),
    (sse) =>
      runResponse({
        config: agent.config,
        model: agent.model,
        requestedModel,
        userId,
        userHash,
        sessionStore,
        handoffStore,
        agentIds: allowedAgentIds,
        knownUsers,
        mcpTools,
        telemetry: requestTelemetry,
        body,
        trace,
        sse,
        signal,
      }),
  );
}

function streamChatCompletion(
  agent: AgentDefinition,
  sessionStore: SessionStore,
  allowedAgentIds: string[],
  requestedModel: string,
  userId: string,
  userHash: string,
  knownUsers: string[],
  mcpTools: McpAgentConnection["tools"],
  requestTelemetry: RequestTelemetry,
  trace: TraceMode,
  body: Record<string, unknown>,
  includeUsage: boolean,
  signal: AbortSignal,
): Response {
  return streamRun(
    requestTelemetry,
    (controller) => new ChatCompletionStream(controller, includeUsage),
    (sse) =>
      runResponse({
        config: agent.config,
        model: agent.model,
        requestedModel,
        userId,
        userHash,
        sessionStore,
        handoffStore,
        agentIds: allowedAgentIds,
        knownUsers,
        mcpTools,
        telemetry: requestTelemetry,
        body,
        trace,
        sse,
        replay: true,
        signal,
      }),
  );
}

const server = Bun.serve({
  port: baseConfig.port,
  hostname: baseConfig.hostname,
  maxRequestBodySize: 32 * 1024 * 1024,
  idleTimeout: 255,
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const requestTelemetry = telemetry.request(request.method, routeFor(path), path);
    try {
      return requestTelemetry.wrap(await handleRequest(request, url, requestTelemetry));
    } catch (error) {
      requestTelemetry.fail(error);
      console.error("request failed", error);
      return requestTelemetry.wrap(apiError("Internal Server Error", 500, "server_error"));
    }
  },
});

async function handleRequest(request: Request, url: URL, requestTelemetry: RequestTelemetry): Promise<Response> {
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (path === "/health") {
    return json({ ok: true, authReady: registry.ready, users: registry.size, agents: agents.map((agent) => agent.id) });
  }
  if (path === "/") return json({ name: "pi-assistant", endpoints: ["/v1/responses", "/v1/chat/completions", "/v1/models", "/v1/handoffs"] });

  if (!registry.ready) return apiError("Service Unavailable: authentication backend not ready", 503, "service_unavailable");
  const token = requestToken(request);
  const userId = registry.resolve(token);
  if (!userId) return apiError("Missing or invalid API key", 401, "invalid_api_key");
  const userHash = keyHash(token);
  requestTelemetry.span.setAttributes({ "assistant.key_hash": userHash, "assistant.username": userId });
  const allowedAgents = agents.filter((agent) => isUserAllowed(agent.config, userId));
  const allowedAgentIds = allowedAgents.map((agent) => agent.id);

  if (request.method === "GET" && (path === "/v1/models" || path === "/models")) return modelList(allowedAgents);
  if (request.method === "GET" && path.startsWith("/v1/models/")) {
    const id = decodeURIComponent(path.slice("/v1/models/".length));
    const agent = allowedAgents.find((entry) => entry.id === id);
    if (agent) {
      return json(modelRow(agent, id, Math.floor(Date.now() / 1_000)));
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
    const scope = { userId, userHash, agent: target.id };
    return json({ object: "list", data: handoffStore.list(scope, statusParam, limit) });
  }

  const consumeHandoff = path.match(/^\/(?:v1\/)?handoffs\/([^/]+)\/consume$/)?.[1];
  if (request.method === "POST" && consumeHandoff) {
    const target = requireAgentFromQuery(url, userId);
    if (target instanceof Response) return target;
    const id = decodeURIComponent(consumeHandoff);
    if (!handoffStore.consume(id, { userId, userHash, agent: target.id })) {
      return apiError("Handoff not found", 404, "not_found");
    }
    return json({ success: true, id, status: "consumed" });
  }

  const handoffId = path.match(/^\/(?:v1\/)?handoffs\/([^/]+)$/)?.[1];
  if (request.method === "GET" && handoffId) {
    const target = requireAgentFromQuery(url, userId);
    if (target instanceof Response) return target;
    const record = handoffStore.get(decodeURIComponent(handoffId), { userId, userHash, agent: target.id });
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

  const chat = path === "/v1/chat/completions" || path === "/chat/completions";
  if (request.method === "POST" && (path === "/v1/responses" || path === "/responses" || chat)) {
    let parsed: unknown;
    try {
      parsed = await request.json();
    } catch {
      return apiError("Request body must be valid JSON", 400, "invalid_json");
    }
    if (!isRecord(parsed)) return apiError("Request body must be a JSON object", 400, "invalid_request");
    if (chat && parsed.n !== undefined && parsed.n !== null && parsed.n !== 1) {
      return apiError("n must be 1; this server returns a single choice", 400, "unsupported_parameter");
    }

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
    requestTelemetry.span.setAttributes({
      "assistant.agent": agent.id,
      "assistant.requested_model": requestedModel,
      "gen_ai.request.model": agent.config.modelId,
    });
    const sessionStore = sessionStores.get(agent.id);
    if (!sessionStore) return apiError(`No session store for agent ${agent.id}`, 500, "server_error");
    const trace = parseTraceMode(request.headers.get("x-pi-trace"));
    const body = chat ? chatRequestToResponses(parsed) : parsed;
    const mcpTools = mcpConnections.get(agent.id)?.tools ?? [];

    if (body.stream === true) {
      if (chat) {
        const streamOptions = isRecord(parsed.stream_options) ? parsed.stream_options : {};
        return streamChatCompletion(
          agent,
          sessionStore,
          allowedAgentIds,
          requestedModel,
          userId,
          userHash,
          registry.userIds().filter((id) => isUserAllowed(agent.config, id)),
          mcpTools,
          requestTelemetry,
          trace,
          body,
          streamOptions.include_usage === true,
          request.signal,
        );
      }
      return streamResponse(
        agent,
        sessionStore,
        allowedAgentIds,
        requestedModel,
        userId,
        userHash,
        registry.userIds().filter((id) => isUserAllowed(agent.config, id)),
        mcpTools,
        requestTelemetry,
        trace,
        body,
        request.signal,
      );
    }
    try {
      const response = await runResponse({
        config: agent.config,
        model: agent.model,
        requestedModel,
        userId,
        userHash,
        sessionStore,
        handoffStore,
        agentIds: allowedAgentIds,
        knownUsers: registry.userIds().filter((id) => isUserAllowed(agent.config, id)),
        mcpTools,
        telemetry: requestTelemetry,
        body,
        trace,
        replay: chat,
        signal: request.signal,
      });
      if (!chat) return json(response);
      if (response.status === "failed") {
        const error = isRecord(response.error) ? response.error : {};
        return apiError(
          typeof error.message === "string" ? error.message : "The model request failed.",
          502,
          typeof error.code === "string" ? error.code : "server_error",
        );
      }
      return json(chatCompletionShape(response, requestedModel));
    } catch (error) {
      if (error instanceof RequestError) return apiError(error.message, error.status, error.code);
      requestTelemetry.fail(error);
      console.error("response failed", error);
      return apiError(error instanceof Error ? error.message : String(error), 500, "server_error");
    }
  }

  return apiError("Not found", 404, "not_found");
}

console.log(
  `pi-assistant listening on http://${server.hostname}:${server.port} agents=${agents.map((agent) => agent.id).join(",")} ` +
    `mcpTools=${[...mcpConnections.values()].reduce((sum, mcp) => sum + mcp.tools.length, 0)} ` +
    `auth=${registry.ready ? "ready" : "pending"} users=${registry.size} refresh=${baseConfig.refreshMs}ms`,
);
console.log(
  `pi-assistant otel: ${baseConfig.otel ? `${baseConfig.otel.endpoint} (${baseConfig.otel.serviceName})` : "disabled"}`,
);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`pi-assistant ${signal} received, shutting down`);
  registry.stop();
  for (const store of sessionStores.values()) store.close();
  handoffStore.close();
  server.stop();
  await Promise.allSettled([...mcpConnections.values()].map((mcp) => mcp.close()));
  await telemetry.shutdown();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
