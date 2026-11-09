import {
  SpanKind,
  SpanStatusCode,
  metrics,
  trace,
  type Attributes,
  type Counter,
  type Histogram,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import type { OtelConfig } from "./config.ts";

export type TokenUsage = {
  model: string;
  /** Uncached input tokens; cached input is reported separately. */
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number | null;
};

const CONTENT_LIMIT = 8_192;

export type RequestTelemetry = {
  span: Span;
  /** Ends the span and records the request metric exactly once. */
  finish(status: number, attributes?: Attributes): void;
  /** Marks the span as failed before it ends. */
  fail(error: unknown): void;
  /** Records token counters and usage attributes on the span. */
  recordUsage(usage: TokenUsage, attributes?: Attributes): void;
  /** Captures the request input/instructions when OTEL_CAPTURE_CONTENT is enabled. */
  recordInput(input: unknown, instructions?: unknown): void;
  /** Captures the response text when OTEL_CAPTURE_CONTENT is enabled. */
  recordOutput(output: string): void;
  /** Wraps a response so the span ends when its body is consumed or cancelled. */
  wrap(response: Response): Response;
};

export type Telemetry = {
  /** False when no OTLP endpoint is configured; call sites stay identical. */
  enabled: boolean;
  request(
    method: string,
    route: string,
    path: string,
    attributes?: Record<string, string | number | boolean>,
  ): RequestTelemetry;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
};

function setupOtel(cfg: OtelConfig) {
  const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: cfg.serviceName });

  const tracerProvider = new NodeTracerProvider({
    resource,
    spanProcessors: [
      new BatchSpanProcessor(new OTLPTraceExporter({ url: `${cfg.endpoint}/v1/traces`, timeoutMillis: 5000 })),
    ],
  });
  tracerProvider.register();

  const meterProvider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${cfg.endpoint}/v1/metrics`, timeoutMillis: 5000 }),
        exportIntervalMillis: 15_000,
      }),
    ],
  });
  metrics.setGlobalMeterProvider(meterProvider);

  return { tracerProvider, meterProvider };
}

export function createTelemetry(cfg: OtelConfig | null): Telemetry {
  const sdk = cfg ? setupOtel(cfg) : null;

  // Without an SDK these resolve to no-ops, so call sites stay identical.
  const tracer: Tracer = trace.getTracer("pi-assistant");
  const meter = metrics.getMeter("pi-assistant");
  const requests: Counter = meter.createCounter("assistant.requests", {
    description: "Requests handled by the assistant",
  });
  const duration: Histogram = meter.createHistogram("assistant.request.duration", {
    description: "End-to-end request duration",
    unit: "ms",
  });
  const tokens: Counter = meter.createCounter("assistant.tokens", {
    description: "Tokens attributed to backend responses",
  });

  const addTokenCounts = (usage: TokenUsage, extra: Attributes) => {
    const base = { "gen_ai.request.model": usage.model, ...extra };
    if (usage.input_tokens > 0) tokens.add(usage.input_tokens, { ...base, "gen_ai.token.type": "input" });
    if (usage.output_tokens > 0) tokens.add(usage.output_tokens, { ...base, "gen_ai.token.type": "output" });
    if (usage.cached_input_tokens) tokens.add(usage.cached_input_tokens, { ...base, "gen_ai.token.type": "cached" });
  };

  const usageAttributes = (usage: TokenUsage): Attributes => ({
    "gen_ai.request.model": usage.model,
    "gen_ai.usage.input_tokens": usage.input_tokens,
    "gen_ai.usage.output_tokens": usage.output_tokens,
    ...(usage.cached_input_tokens === null ? {} : { "gen_ai.usage.cached_input_tokens": usage.cached_input_tokens }),
  });

  const captureContent = cfg?.captureContent === true;
  const contentText = (value: unknown): string => {
    const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
    return text.length > CONTENT_LIMIT ? `${text.slice(0, CONTENT_LIMIT)}…` : text;
  };

  return {
    enabled: sdk !== null,

    request(method, route, path, attributes = {}) {
      const started = performance.now();
      const span = tracer.startSpan(`${method} ${route}`, {
        kind: SpanKind.SERVER,
        attributes: {
          "http.request.method": method,
          "http.route": route,
          "url.path": path,
          ...attributes,
        },
      });

      let finished = false;
      const attributesFor = (status: number): Attributes => ({
        "http.route": route,
        "http.response.status_code": status,
      });

      const request: RequestTelemetry = {
        span,

        finish(status, extra = {}) {
          if (finished) return;
          finished = true;
          span.setAttributes({ "http.response.status_code": status, ...extra });
          if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
          requests.add(1, attributesFor(status));
          duration.record(performance.now() - started, attributesFor(status));
          span.end();
        },

        fail(err) {
          span.recordException(err instanceof Error ? err : String(err));
          span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
        },

        recordUsage(usage, extra = {}) {
          addTokenCounts(usage, extra);
          span.setAttributes({ ...usageAttributes(usage), ...extra });
        },

        recordInput(input, instructions) {
          if (!captureContent) return;
          span.setAttributes({
            "assistant.request.input": contentText(input),
            ...(instructions === undefined || instructions === null || instructions === ""
              ? {}
              : { "assistant.request.instructions": contentText(instructions) }),
          });
        },

        recordOutput(output) {
          if (!captureContent || !output) return;
          span.setAttribute("assistant.response.output", contentText(output));
        },

        wrap(response) {
          if (!response.body) {
            request.finish(response.status);
            return response;
          }

          const reader = response.body.getReader();
          let done = false;
          const complete = (attributes?: Attributes) => {
            if (done) return;
            done = true;
            request.finish(response.status, attributes);
          };

          const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const result = await reader.read();
                if (result.done) {
                  complete();
                  controller.close();
                  return;
                }
                controller.enqueue(result.value);
              } catch (error) {
                request.fail(error);
                complete();
                controller.error(error);
              }
            },
            cancel(reason) {
              complete({ "assistant.stream_cancelled": true });
              return reader.cancel(reason);
            },
          });

          return new Response(stream, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        },
      };

      return request;
    },

    async forceFlush() {
      await sdk?.tracerProvider.forceFlush();
      await sdk?.meterProvider.forceFlush();
    },

    async shutdown() {
      await sdk?.tracerProvider.shutdown();
      await sdk?.meterProvider.shutdown();
    },
  };
}
