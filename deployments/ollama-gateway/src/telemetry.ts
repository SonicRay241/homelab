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

export type TokenUsage = {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number | null;
};

export type RequestTelemetry = {
  span: Span;
  /** Ends the span and records the request metric exactly once. */
  finish(status: number, attributes?: Record<string, string | number | boolean>): void;
  /** Marks the span as failed before it ends. */
  fail(err: unknown): void;
  recordUsage(usage: TokenUsage, username?: string): void;
};

export type ReplayRecord = TokenUsage & {
  id: number;
  timestamp: string;
  date: string;
  endpoint?: string;
  key_hash?: string;
  username?: string;
  externalId?: string;
};

/** Accepts ISO 8601 and the SQLite/CSV form `2025-01-02 03:04:05.123+00`. */
function parseTimestamp(value: string): Date | null {
  const direct = new Date(value);
  if (!Number.isNaN(direct.getTime())) return direct;

  const normalized = value
    .trim()
    .replace(/^(\d{4}-\d{2}-\d{2}) /, "$1T")
    .replace(/\.(\d{3})\d+/, ".$1")
    .replace(/([+-]\d{2})$/, "$1:00");
  const fallback = new Date(normalized);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

export type ReplayOptions = {
  /**
   * Stamp spans at export time instead of the row's original time. Use only when a backend rejects
   * spans outside its ingestion window; the original time is always kept in `usage.timestamp`.
   */
  ingestionTimestamps?: boolean;
};

export type Telemetry = {
  /** False when no OTLP endpoint is configured; replay/backfill is skipped in that case. */
  enabled: boolean;
  request(method: string, route: string, path: string, attributes?: Record<string, string | number>): RequestTelemetry;
  /** Emits one span and token counters for a historical usage row. */
  replay(record: ReplayRecord, options?: ReplayOptions): void;
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
  const tracer: Tracer = trace.getTracer("ollama-gateway");
  const meter = metrics.getMeter("ollama-gateway");
  const requests: Counter = meter.createCounter("proxy.requests", { description: "Requests handled by the gateway" });
  const duration: Histogram = meter.createHistogram("proxy.request.duration", {
    description: "End-to-end request duration",
    unit: "ms",
  });
  const tokens: Counter = meter.createCounter("proxy.tokens", { description: "Tokens attributed to upstream responses" });

  const addTokenCounts = (usage: TokenUsage, extra: Record<string, string | number | boolean>) => {
    const base = { model: usage.model, ...extra };
    if (usage.input_tokens > 0) tokens.add(usage.input_tokens, { ...base, "gen_ai.token.type": "input" });
    if (usage.output_tokens > 0) tokens.add(usage.output_tokens, { ...base, "gen_ai.token.type": "output" });
    if (usage.cached_input_tokens) tokens.add(usage.cached_input_tokens, { ...base, "gen_ai.token.type": "cached" });
  };

  const usageAttributes = (usage: TokenUsage) => ({
    "gen_ai.request.model": usage.model,
    "gen_ai.usage.input_tokens": usage.input_tokens,
    "gen_ai.usage.output_tokens": usage.output_tokens,
    ...(usage.cached_input_tokens === null ? {} : { "gen_ai.usage.cached_input_tokens": usage.cached_input_tokens }),
  });

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

        recordUsage(usage, username) {
          addTokenCounts(usage, username ? { "proxy.username": username } : {});
          span.setAttributes(usageAttributes(usage));
        },
      };

      return request;
    },

    replay(record, options = {}) {
      const original = options.ingestionTimestamps === true ? null : parseTimestamp(record.timestamp);
      const attributes = {
        "proxy.replay": true,
        ...(record.endpoint ? { "http.route": record.endpoint } : {}),
        ...(record.key_hash ? { "proxy.key_hash": record.key_hash } : {}),
        ...(record.username ? { "proxy.username": record.username } : {}),
        ...(record.externalId ? { "usage.id": record.externalId } : {}),
        "usage.row_id": record.id,
        "usage.timestamp": record.timestamp,
        "usage.date": record.date,
        ...usageAttributes(record),
      };

      // The SDK serializes startTime/endTime as startTimeUnixNano/endTimeUnixNano
      // (start_time_unix_nano/end_time_unix_nano on the wire), so replaying keeps the original
      // event time and the history lands in the right buckets. Metrics cannot be backdated: token
      // counters are attributed to export time and tagged `proxy.replayed`.
      const name = record.endpoint ? `usage.replay ${record.endpoint}` : "usage.replay";
      if (original) {
        tracer.startSpan(name, { kind: SpanKind.INTERNAL, attributes, startTime: original }).end(original);
      } else {
        tracer.startSpan(name, { kind: SpanKind.INTERNAL, attributes }).end();
      }

      addTokenCounts(record, {
        "proxy.replayed": true,
        ...(record.username ? { "proxy.username": record.username } : {}),
      });
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
