import { afterAll, describe, expect, it } from "bun:test";
import { loadOtelConfig } from "../src/config.ts";
import { createTelemetry } from "../src/telemetry.ts";

const otlp = { traces: [] as unknown[], metrics: [] as unknown[] };

const collector = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = await req.json();
    if (url.pathname === "/v1/traces") otlp.traces.push(body);
    if (url.pathname === "/v1/metrics") otlp.metrics.push(body);
    return Response.json({ partialSuccess: {} });
  },
});

const telemetry = createTelemetry({
  endpoint: `http://127.0.0.1:${collector.port}`,
  serviceName: "pi-assistant-test",
  captureContent: true,
});

type OtlpValue = { stringValue?: string; intValue?: string | number; boolValue?: boolean };
type OtlpSpan = {
  name: string;
  attributes?: { key: string; value: OtlpValue }[];
};
type OtlpPayload = { resourceSpans?: { scopeSpans?: { spans?: OtlpSpan[] }[] }[] };

function exportedSpans(): OtlpSpan[] {
  return otlp.traces.flatMap((payload) =>
    ((payload as OtlpPayload).resourceSpans ?? []).flatMap((resource) =>
      (resource.scopeSpans ?? []).flatMap((scope) => scope.spans ?? []),
    ),
  );
}

const attr = (span: OtlpSpan, key: string) => span.attributes?.find((entry) => entry.key === key)?.value;
const intAttr = (span: OtlpSpan, key: string) => Number(attr(span, key)?.intValue);
const strAttr = (span: OtlpSpan, key: string) => attr(span, key)?.stringValue;

afterAll(async () => {
  await telemetry.shutdown();
  collector.stop(true);
});

describe("OTEL config", () => {
  it("is disabled without an endpoint or with OTEL_SDK_DISABLED", () => {
    expect(loadOtelConfig({})).toBeNull();
    expect(loadOtelConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/", OTEL_SDK_DISABLED: "1" })).toBeNull();
    expect(loadOtelConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/" })).toEqual({
      endpoint: "http://collector:4318",
      serviceName: "pi-assistant",
      captureContent: false,
    });
    expect(
      loadOtelConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318", OTEL_SERVICE_NAME: "custom" }),
    ).toEqual({ endpoint: "http://collector:4318", serviceName: "custom", captureContent: false });
    expect(
      loadOtelConfig({
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
        OTEL_CAPTURE_CONTENT: "1",
      }),
    ).toEqual({ endpoint: "http://collector:4318", serviceName: "pi-assistant", captureContent: true });
  });

  it("keeps a no-op telemetry object usable", async () => {
    const disabled = createTelemetry(null);
    const request = disabled.request("GET", "/health", "/health");
    request.recordUsage({ model: "model", input_tokens: 1, output_tokens: 1, cached_input_tokens: null });
    expect(await request.wrap(new Response("ok")).text()).toBe("ok");
    await disabled.shutdown();
  });
});

describe("OTEL export", () => {
  it("exports request spans, usage attributes and metrics", async () => {
    expect(telemetry.enabled).toBe(true);

    const request = telemetry.request("POST", "/v1/responses", "/v1/responses", { "assistant.agent": "default" });
    request.span.setAttributes({ "assistant.username": "alice", "assistant.key_hash": "abc123" });
    request.recordUsage(
      { model: "beam:cloud", input_tokens: 7, output_tokens: 3, cached_input_tokens: 2 },
      { "assistant.agent": "default", "assistant.response_id": "resp_test" },
    );
    request.recordInput("hello", "be nice");
    request.recordOutput("world");

    const response = request.wrap(new Response("hello", { status: 201, headers: { "content-type": "text/plain" } }));
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("hello");

    await telemetry.forceFlush();

    const span = exportedSpans().find((candidate) => candidate.name === "POST /v1/responses");
    expect(span).toBeDefined();
    expect(intAttr(span!, "http.response.status_code")).toBe(201);
    expect(strAttr(span!, "assistant.username")).toBe("alice");
    expect(strAttr(span!, "assistant.key_hash")).toBe("abc123");
    expect(strAttr(span!, "assistant.agent")).toBe("default");
    expect(strAttr(span!, "assistant.response_id")).toBe("resp_test");
    expect(strAttr(span!, "gen_ai.request.model")).toBe("beam:cloud");
    expect(intAttr(span!, "gen_ai.usage.input_tokens")).toBe(7);
    expect(intAttr(span!, "gen_ai.usage.output_tokens")).toBe(3);
    expect(intAttr(span!, "gen_ai.usage.cached_input_tokens")).toBe(2);
    expect(strAttr(span!, "assistant.request.input")).toBe("hello");
    expect(strAttr(span!, "assistant.request.instructions")).toBe("be nice");
    expect(strAttr(span!, "assistant.response.output")).toBe("world");

    const metrics = JSON.stringify(otlp.metrics);
    expect(metrics).toContain("assistant.requests");
    expect(metrics).toContain("assistant.request.duration");
    expect(metrics).toContain("assistant.tokens");
    expect(metrics).toContain("gen_ai.token.type");
    expect(metrics).toContain("beam:cloud");
  });
});
