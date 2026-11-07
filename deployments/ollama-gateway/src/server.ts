import { hashToken, type TokenRegistry } from "./auth/tokens.ts";
import type { Config } from "./config.ts";
import type { RequestTelemetry, Telemetry } from "./telemetry.ts";
import { parseUsage } from "./usage.ts";

const ROUTES: Record<string, true> = {
  "/api/generate": true,
  "/api/chat": true,
  "/api/embed": true,
  "/api/embeddings": true,
  "/api/tags": true,
  "/api/show": true,
  "/api/pull": true,
  "/v1/chat/completions": true,
  "/v1/completions": true,
  "/v1/embeddings": true,
  "/v1/systemone": true,
};

const USAGE_ROUTES: Record<string, true> = {
  "/api/generate": true,
  "/api/chat": true,
  "/api/embed": true,
  "/v1/systemone": true,
  "/v1/chat/completions": true,
};

// Usage flags are only meaningful on these endpoints.
const INJECT_ROUTES: Record<string, true> = {
  "/api/generate": true,
  "/api/chat": true,
  "/v1/chat/completions": true,
};

const HOP_BY_HOP: Record<string, true> = {
  authorization: true,
  connection: true,
  "keep-alive": true,
  "proxy-authenticate": true,
  "proxy-authorization": true,
  te: true,
  trailer: true,
  "transfer-encoding": true,
  upgrade: true,
  host: true,
  "accept-encoding": true,
};

export type Deps = {
  config: Config;
  registry: TokenRegistry;
  telemetry: Telemetry;
};

function bearerToken(header: string | null): string {
  return header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

/**
 * Forward an upstream response to the client while capturing the body for usage parsing.
 * The client sees bytes as they arrive; parsing happens only when the stream closes.
 */
function streamAndLog(
  upstream: Response,
  endpoint: string,
  keyHash: string,
  request: RequestTelemetry
): Response {
  const chunks: Uint8Array[] = [];
  let captured = 0;
  let truncated = false;
  let finalized = false;
  // ponytail: 8 MiB capture cap; token counters live at the tail, above this we skip the record.
  const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

  const finalize = (aborted: boolean) => {
    if (finalized) return;
    finalized = true;

    let usage = null;
    if (!aborted && !truncated) {
      const body = new Uint8Array(captured);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.length;
      }
      usage = parseUsage(endpoint, new TextDecoder().decode(body));
    }

    if (usage) {
      request.recordUsage(usage);
      console.log(
        `[usage] ${endpoint} key=${keyHash} model=${usage.model} in=${usage.input_tokens} out=${usage.output_tokens}`
      );
    }

    request.finish(upstream.status, {
      "proxy.stream_aborted": aborted,
      "proxy.body_truncated": truncated,
      ...(usage ? { "gen_ai.request.model": usage.model } : {}),
    });
  };

  const reader = upstream.body!.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finalize(false);
          controller.close();
          return;
        }
        controller.enqueue(value);
        if (truncated) return;
        if (captured + value.length > MAX_CAPTURE_BYTES) {
          truncated = true;
          chunks.length = 0;
          return;
        }
        chunks.push(value);
        captured += value.length;
      } catch (err) {
        finalize(true);
        controller.error(err);
      }
    },
    cancel(reason) {
      finalize(true);
      return reader.cancel(reason);
    },
  });

  return new Response(stream, { status: upstream.status, headers: upstream.headers });
}

export function createServer(deps: Deps) {
  const { config, registry, telemetry } = deps;

  return Bun.serve({
    port: config.port,
    idleTimeout: 255,

    async fetch(req) {
      const url = new URL(req.url);
      const route = ROUTES[url.pathname] ? url.pathname : "other";
      const request = telemetry.request(req.method, route, url.pathname);
      const traceId = request.span.spanContext().traceId;
      console.log(
        `${new Date().toISOString()} ${req.method} ${url.pathname} trace=${traceId} from=${req.headers.get("x-forwarded-for") ?? "?"}`
      );

      const deny = (status: number, message: string) => {
        request.finish(status);
        return new Response(message, { status });
      };

      if (!registry.ready) return deny(503, "Service Unavailable: authentication backend not ready");

      const token = bearerToken(req.headers.get("authorization"));
      if (!registry.hasToken(token)) return deny(401, "Unauthorized");

      const keyHash = hashToken(token);
      request.span.setAttributes({ "proxy.key_hash": keyHash });

      const headers: Record<string, string> = {};
      req.headers.forEach((value, key) => {
        if (!HOP_BY_HOP[key.toLowerCase()]) headers[key] = value;
      });

      let body: RequestInit["body"] = req.body;

      // Middleware: make Ollama report token usage so it can be logged.
      if (!config.loggingDisabled && req.method !== "GET" && req.method !== "HEAD" && INJECT_ROUTES[url.pathname]) {
        const raw = await req.text();
        try {
          const payload = JSON.parse(raw);

          if (url.pathname === "/v1/chat/completions") {
            // OpenAI-compatible: usage ships in the final streaming chunk.
            payload.stream_options = payload.stream_options ?? {};
            if (payload.stream !== false) payload.stream_options.include_usage = true;
          } else if (payload.stream === undefined) {
            // Native Ollama: the done chunk carries the counts.
            payload.stream = true;
          }

          body = JSON.stringify(payload);
          headers["content-type"] = "application/json";
          headers["content-length"] = String(Buffer.byteLength(body, "utf-8"));
        } catch {
          // Not JSON: forward the raw body untouched.
          body = raw;
        }
      }

      let upstream: Response;
      try {
        upstream = await fetch(
          new Request(`${config.ollamaUrl}${url.pathname}${url.search}`, {
            method: req.method,
            headers,
            body,
            duplex: "half",
          } as RequestInit)
        );
      } catch (err) {
        request.fail(err);
        request.finish(502);
        return new Response("Bad Gateway", { status: 502 });
      }

      if (config.loggingDisabled || !upstream.body || !USAGE_ROUTES[url.pathname]) {
        request.finish(upstream.status);
        return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
      }

      return streamAndLog(upstream, url.pathname, keyHash, request);
    },
  });
}
