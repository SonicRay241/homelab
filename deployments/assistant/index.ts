import { createInfisicalClient } from "./src/auth/infisical.ts";
import { requestToken, UserRegistry } from "./src/auth/users.ts";
import { loadConfig } from "./src/config.ts";
import { isRecord } from "./src/guards.ts";
import { buildModel } from "./src/model.ts";
import { SseWriter } from "./src/openai.ts";
import { getStoredResponse, RequestError, runResponse } from "./src/runner.ts";

const config = loadConfig();
const model = buildModel(config);
const registry = new UserRegistry(createInfisicalClient(config.infisical), config.refreshMs, config.staticKeys);

await registry.start();

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, x-api-key, api-key, openai-beta",
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: CORS });
}

function apiError(message: string, status: number, code: string, param: string | null = null): Response {
  const type = status === 401 ? "authentication_error" : status >= 500 ? "server_error" : "invalid_request_error";
  return json({ error: { message, type, param, code } }, status);
}

function modelList(): Response {
  const created = Math.floor(Date.now() / 1_000);
  return json({
    object: "list",
    data: config.modelIds.map((id) => ({ id, object: "model", created, owned_by: "pi-assistant" })),
  });
}

function streamResponse(userId: string, body: Record<string, unknown>, signal: AbortSignal): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const writer = new SseWriter(controller);
      try {
        await runResponse({ config, model, userId, body, sse: writer, signal });
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
  port: config.port,
  hostname: config.hostname,
  maxRequestBodySize: 32 * 1024 * 1024,
  idleTimeout: 255,
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (path === "/health") {
      return json({ ok: true, authReady: registry.ready, users: registry.size });
    }
    if (path === "/") return json({ name: "pi-assistant", endpoints: ["/v1/responses", "/v1/models"] });

    if (!registry.ready) return apiError("Service Unavailable: authentication backend not ready", 503, "service_unavailable");
    const token = requestToken(request);
    const userId = registry.resolve(token);
    if (!userId) return apiError("Missing or invalid API key", 401, "invalid_api_key");

    if (request.method === "GET" && (path === "/v1/models" || path === "/models")) return modelList();
    if (request.method === "GET" && path.startsWith("/v1/models/")) {
      const id = decodeURIComponent(path.slice("/v1/models/".length));
      if (config.modelIds.includes(id)) {
        return json({ id, object: "model", created: Math.floor(Date.now() / 1_000), owned_by: "pi-assistant" });
      }
      return apiError(`Unknown model ${id}`, 404, "model_not_found");
    }

    const responseId = path.match(/^\/(?:v1\/)?responses\/([^/]+)$/)?.[1];
    if (request.method === "GET" && responseId) {
      const stored = getStoredResponse(decodeURIComponent(responseId), userId);
      if (!stored) return apiError("Response not found", 404, "not_found");
      return json(stored);
    }

    if (request.method === "POST" && (path === "/v1/responses" || path === "/responses")) {
      let parsed: unknown;
      try {
        parsed = await request.json();
      } catch {
        return apiError("Request body must be valid JSON", 400, "invalid_json");
      }
      if (!isRecord(parsed)) return apiError("Request body must be a JSON object", 400, "invalid_request");
      if (parsed.stream === true) return streamResponse(userId, parsed, request.signal);
      try {
        return json(await runResponse({ config, model, userId, body: parsed, signal: request.signal }));
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
  `pi-assistant listening on http://${server.hostname}:${server.port} model=${config.modelId} ` +
    `auth=${registry.ready ? "ready" : "pending"} users=${registry.size} refresh=${config.refreshMs}ms`,
);

let stopping = false;
function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  console.log(`pi-assistant ${signal} received, shutting down`);
  registry.stop();
  server.stop();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
