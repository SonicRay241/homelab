import {
  SpanKind,
  SpanStatusCode,
  metrics,
  trace,
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

export type RequestTelemetry = {
  span: Span;
  /** Ends the span and records the request metric exactly once. */
  finish(status: number, attributes?: Record<string, string | number | boolean>): void;
  /** Marks the span as failed before it ends. */
  fail(err: unknown): void;
  recordUsage(usage: { model: string; input_tokens: number; output_tokens: number; cached_input_tokens: number | null }): void;
};

export type ReplayRecord = {
  timestamp: string;
  date: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number | null;
  endpoint: string;
  key_hash: string;
};

export type Telemetry = {
  /** False when no OTLP endpoint is configured; replay migration is skipped in that case. */
  enabled: boolean;
  request(method: string, route: string, path: string, attributes?: Record<string, string | number>): RequestTelemetry;
  /** Emits an already-timestamped span for a historical usage row. */
  replay(record: ReplayRecord): void;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
};

function setupOtel(cfg: OtelConfig) {
  const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: cfg.serviceName });

  const tracerProvider = new NodeTracerProvider({
    resource,
    spanProcessors: [
      new BatchSpanProcessor(new OTLPTraceExporter({ url: `${cfg.endpoint}/v1/traces` })),
    ],
  });
  tracerProvider.register();

  const meterProvider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${cfg.endpoint}/v1/metrics` }),
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
  const tracer: Tracer = trace.getTracer("ollama-gateway");
  const meter = metrics.getMeter("ollama-gateway");
  const requests: Counter = meter.createCounter("proxy.requests", { description: "Requests handled by the gateway" });
  const duration: Histogram = meter.createHistogram("proxy.request.duration", {
    description: "End-to-end request duration",
    unit: "ms",
  });
  const tokens: Counter = meter.createCounter("proxy.tokens", { description: "Tokens attributed to upstream responses" });

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
      const attributesFor = (status: number) => ({ "http.route": route, "http.response.status_code": status });

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

        recordUsage(usage) {
          const base = { model: usage.model };
          if (usage.input_tokens > 0) tokens.add(usage.input_tokens, { ...base, "gen_ai.token.type": "input" });
          if (usage.output_tokens > 0) tokens.add(usage.output_tokens, { ...base, "gen_ai.token.type": "output" });
          if (usage.cached_input_tokens) tokens.add(usage.cached_input_tokens, { ...base, "gen_ai.token.type": "cached" });
          span.setAttributes({
            "gen_ai.request.model": usage.model,
            "gen_ai.usage.input_tokens": usage.input_tokens,
            "gen_ai.usage.output_tokens": usage.output_tokens,
            ...(usage.cached_input_tokens === null ? {} : { "gen_ai.usage.cached_input_tokens": usage.cached_input_tokens }),
          });
        },
      };

      return request;
    },

    replay(record) {
      const attributes = {
        "proxy.replay": true,
        "http.route": record.endpoint,
        "proxy.key_hash": record.key_hash,
        "gen_ai.request.model": record.model,
        "gen_ai.usage.input_tokens": record.input_tokens,
        "gen_ai.usage.output_tokens": record.output_tokens,
        ...(record.cached_input_tokens === null ? {} : { "gen_ai.usage.cached_input_tokens": record.cached_input_tokens }),
        "usage.date": record.date,
      };

      const timestamp = new Date(record.timestamp);
      if (Number.isNaN(timestamp.getTime())) {
        tracer.startSpan(`usage.replay ${record.endpoint}`, { kind: SpanKind.INTERNAL, attributes }).end();
        return;
      }
      tracer
        .startSpan(`usage.replay ${record.endpoint}`, { kind: SpanKind.INTERNAL, attributes, startTime: timestamp })
        .end(timestamp);
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
