import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { createInfisicalClient } from "../src/auth/infisical.ts";
import { TokenRegistry, hashToken } from "../src/auth/tokens.ts";
import type { Config } from "../src/config.ts";
import { replayUsageCsv } from "../src/replay.ts";
import { uncachedInput } from "../src/usage.ts";
import { createServer } from "../src/server.ts";
import { createTelemetry } from "../src/telemetry.ts";

const secrets = new Map([
  ["alice", "tok-alice"],
  ["bob", "tok-bob"],
]);
const receivedBodies: Record<string, { model?: string; stream?: boolean }> = {};
const gates: (() => void)[] = [];
const otlp = { traces: [] as unknown[], metrics: [] as unknown[] };

const infisical = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/v1/auth/universal-auth/login") {
      const body = (await req.json()) as { clientId?: string; clientSecret?: string };
      if (body.clientId !== "cid" || body.clientSecret !== "secret") {
        return Response.json({ message: "invalid credentials" }, { status: 401 });
      }
      return Response.json({ accessToken: "inf-access", expiresIn: 3600, accessTokenMaxTTL: 3600, tokenType: "Bearer" });
    }
    if (url.pathname === "/api/v3/secrets/raw") {
      if (req.headers.get("authorization") !== "Bearer inf-access") {
        return Response.json({ message: "unauthorized" }, { status: 401 });
      }
      if (url.searchParams.get("workspaceId") !== "proj") {
        return Response.json({ message: "wrong project" }, { status: 400 });
      }
      return Response.json({
        secrets: [...secrets].map(([secretKey, secretValue]) => ({ secretKey, secretValue })),
      });
    }
    return new Response("not found", { status: 404 });
  },
});

const ollama = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = req.method === "POST" ? ((await req.json()) as { model?: string; stream?: boolean }) : null;
    if (body) receivedBodies[url.pathname] = body;

    if (url.pathname === "/api/tags") {
      return Response.json({ models: [{ name: "llama" }] });
    }

    if (url.pathname === "/api/chat") {
      const encoder = new TextEncoder();
      const gate = Promise.withResolvers<void>();
      gates.push(gate.resolve);
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode(`${JSON.stringify({ model: "llama", message: { content: "hel" }, done: false })}\n`));
          await gate.promise;
          controller.enqueue(encoder.encode(`${JSON.stringify({ model: "llama", message: { content: "lo" }, done: false })}\n`));
          controller.enqueue(encoder.encode(`${JSON.stringify({ model: "llama", done: true, prompt_eval_count: 7, eval_count: 3 })}\n`));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
    }

    if (url.pathname === "/v1/chat/completions") {
      const payload = [
        { model: "llama", choices: [{ delta: { content: "hi" } }] },
        { model: "llama", choices: [], usage: { prompt_tokens: 11, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 2 } } },
      ]
        .map(chunk => `data: ${JSON.stringify(chunk)}\n\n`)
        .join("");
      return new Response(`${payload}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    }

    return new Response("unexpected", { status: 404 });
  },
});

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

type OtlpValue = { stringValue?: string; intValue?: string | number; boolValue?: boolean };
type OtlpSpan = {
  name: string;
  startTimeUnixNano?: string;
  endTimeUnixNano?: string;
  attributes?: { key: string; value: OtlpValue }[];
};
type OtlpPayload = { resourceSpans?: { scopeSpans?: { spans?: OtlpSpan[] }[] }[] };

function exportedSpans(): OtlpSpan[] {
  return otlp.traces.flatMap(payload =>
    ((payload as OtlpPayload).resourceSpans ?? []).flatMap(resource => (resource.scopeSpans ?? []).flatMap(scope => scope.spans ?? []))
  );
}

const attr = (span: OtlpSpan, key: string) => span.attributes?.find(attribute => attribute.key === key)?.value;
const intAttr = (span: OtlpSpan, key: string) => Number(attr(span, key)?.intValue);
const strAttr = (span: OtlpSpan, key: string) => attr(span, key)?.stringValue;

const stateDir = mkdtempSync(join(tmpdir(), "ollama-gateway-"));

const config: Config = {
  port: 0,
  ollamaUrl: `http://127.0.0.1:${ollama.port}`,
  loggingDisabled: false,
  refreshMs: 60_000,
  infisical: {
    baseUrl: `http://127.0.0.1:${infisical.port}`,
    clientId: "cid",
    clientSecret: "secret",
    projectId: "proj",
    environment: "dev",
    secretPath: "/",
  },
  otel: { endpoint: `http://127.0.0.1:${collector.port}`, serviceName: "ollama-gateway-test" },
};

const telemetry = createTelemetry(config.otel);
const registry = new TokenRegistry(createInfisicalClient(config.infisical), config.refreshMs);
let server: ReturnType<typeof createServer>;
let base = "";

const auth = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

beforeAll(async () => {
  await registry.refresh();
  server = createServer({ config, registry, telemetry });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  // Flush before stopping the fake collector; the SDK exports once more on shutdown.
  await telemetry.shutdown();
  server?.stop(true);
  infisical.stop(true);
  ollama.stop(true);
  collector.stop(true);
  rmSync(stateDir, { recursive: true, force: true });
});

test("rejects missing and invalid bearer tokens", async () => {
  expect((await fetch(`${base}/api/tags`)).status).toBe(401);
  expect((await fetch(`${base}/api/tags`, auth("tok-nope"))).status).toBe(401);
  expect((await fetch(`${base}/api/tags`, auth("tok-bob"))).status).toBe(200);
});

test("streams upstream chunks before the upstream finishes", async () => {
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    ...auth("tok-alice"),
    body: JSON.stringify({ model: "llama", messages: [] }),
  });
  expect(res.status).toBe(200);

  const reader = res.body!.getReader();
  // Integration check: a buffering proxy would deadlock here because the upstream waits on the gate
  // that is only opened after the first chunk arrives. The timer only turns that deadlock into a failure.
  const first = await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no streamed chunk within 2s")), 2000)),
  ]);
  expect(new TextDecoder().decode(first.value)).toContain("hel");

  gates.pop()!();
  let text = "";
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  expect(text).toContain('"done":true');
  expect(text).toContain("lo");
});

test("injects usage flags into proxied requests", () => {
  expect(receivedBodies["/api/chat"]).toMatchObject({ model: "llama", stream: true });
});

test("emits the parsed usage on the request span", async () => {
  await telemetry.forceFlush();

  const span = exportedSpans().find(candidate => candidate.name === "POST /api/chat");
  expect(span).toBeDefined();
  expect(strAttr(span!, "gen_ai.request.model")).toBe("llama");
  expect(intAttr(span!, "gen_ai.usage.input_tokens")).toBe(7);
  expect(intAttr(span!, "gen_ai.usage.output_tokens")).toBe(3);
  expect(strAttr(span!, "proxy.key_hash")).toBe(hashToken("tok-alice"));
  expect(strAttr(span!, "proxy.username")).toBe("alice");
});

test("parses OpenAI-compatible usage including cached tokens", async () => {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    ...auth("tok-bob"),
    body: JSON.stringify({ model: "llama", stream: true, messages: [] }),
  });
  expect(await res.text()).toContain("[DONE]");

  await telemetry.forceFlush();
  const span = exportedSpans().find(candidate => candidate.name === "POST /v1/chat/completions");
  expect(span).toBeDefined();
  // 11 prompt tokens including 2 cached -> 9 uncached.
  expect(intAttr(span!, "gen_ai.usage.input_tokens")).toBe(9);
  expect(intAttr(span!, "gen_ai.usage.output_tokens")).toBe(5);
  expect(intAttr(span!, "gen_ai.usage.cached_input_tokens")).toBe(2);
  expect(uncachedInput(4, 9)).toBe(0);
});

test("reloads the token list from Infisical without a restart", async () => {
  secrets.delete("alice");
  secrets.set("carol", "tok-carol");
  await registry.refresh();

  expect((await fetch(`${base}/api/tags`, auth("tok-alice"))).status).toBe(401);
  expect((await fetch(`${base}/api/tags`, auth("tok-carol"))).status).toBe(200);
});

test("fails closed while no tokens are loaded", async () => {
  const empty = new TokenRegistry({ listSecrets: async () => [] }, 60_000);
  await empty.refresh().catch(() => {});
  const unready = createServer({ config, registry: empty, telemetry });
  try {
    expect((await fetch(`http://127.0.0.1:${unready.port}/api/tags`)).status).toBe(503);
  } finally {
    unready.stop(true);
  }
});

function writeCsv(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const ns = (timestamp: string) => String(BigInt(Date.parse(timestamp)) * 1_000_000n);

test("replays the headerless dump.csv schema with usernames", async () => {
  const path = join(stateDir, "dump", "dump.csv");
  writeCsv(
    path,
    [
      "2025-07-04 05:06:07.000+00,Coding-Agent,cache-model,100,40,hash-1,25",
      "2025-07-05 06:07:08.000+00,Memed,cache-model,20,4,hash-2,",
    ].join("\n") + "\n"
  );

  const result = await replayUsageCsv(path, telemetry);
  expect(result).toMatchObject({ replayed: 2, skipped: 0, total: 2, lastRow: 2 });

  const replaySpans = exportedSpans().filter(span => span.name === "usage.replay");
  const coding = replaySpans.find(span => strAttr(span, "usage.id") === "hash-1")!;
  expect(strAttr(coding, "proxy.username")).toBe("Coding-Agent");
  expect(intAttr(coding, "gen_ai.usage.input_tokens")).toBe(75); // 100 total - 25 cached
  expect(intAttr(coding, "gen_ai.usage.cached_input_tokens")).toBe(25);
  expect(intAttr(coding, "gen_ai.usage.output_tokens")).toBe(40);
  expect(intAttr(coding, "usage.row_id")).toBe(1);
  expect(strAttr(coding, "usage.date")).toBe("2025-07-04");
  expect(coding.startTimeUnixNano).toBe(ns("2025-07-04 05:06:07.000+00"));
  expect(attr(coding, "proxy.key_hash")).toBeUndefined();

  const memed = replaySpans.find(span => strAttr(span, "usage.id") === "hash-2")!;
  expect(strAttr(memed, "proxy.username")).toBe("Memed");
  expect(intAttr(memed, "gen_ai.usage.input_tokens")).toBe(20);
  expect(attr(memed, "gen_ai.usage.cached_input_tokens")).toBeUndefined();
  expect(intAttr(memed, "usage.row_id")).toBe(2);

  const cursor = JSON.parse(readFileSync(`${path}.replayed.json`, "utf-8")) as {
    lastRow: number;
    size: number;
    mode: string;
  };
  expect(cursor).toMatchObject({ lastRow: 2, mode: "original" });
  expect(cursor.size).toBe(Bun.file(path).size);

  // Token counters exist for these rows and carry the username.
  const metrics = JSON.stringify(otlp.metrics);
  expect(metrics).toContain("proxy.replayed");
  expect(metrics).toContain("Coding-Agent");
});

test("maps CSV headers, quoted fields and reordered columns", async () => {
  const path = join(stateDir, "headered", "dump.csv");
  writeCsv(
    path,
    [
      "model,username,cached_input_tokens,output_tokens,input_tokens,id,timestamp",
      '"cache-model","Code, Inc","5","7","12","hash-q","2025-08-01 00:00:00.000+00"',
    ].join("\n") + "\n"
  );

  const result = await replayUsageCsv(path, telemetry);
  expect(result?.replayed).toBe(1);

  const span = exportedSpans().find(candidate => strAttr(candidate, "usage.id") === "hash-q")!;
  expect(strAttr(span, "proxy.username")).toBe("Code, Inc");
  expect(intAttr(span, "gen_ai.usage.input_tokens")).toBe(7);
  expect(intAttr(span, "gen_ai.usage.cached_input_tokens")).toBe(5);
  expect(intAttr(span, "gen_ai.usage.output_tokens")).toBe(7);
  expect(strAttr(span, "usage.date")).toBe("2025-08-01");
});

test("resumes, forces and rewinds the CSV cursor", async () => {
  const path = join(stateDir, "cursor", "dump.csv");
  writeCsv(path, "2025-09-01 00:00:00.000+00,Coding-Agent,cache-model,10,2,hash-c,4\n");

  expect((await replayUsageCsv(path, telemetry))?.replayed).toBe(1);
  expect((await replayUsageCsv(path, telemetry))?.replayed).toBe(0);

  const count = () => exportedSpans().filter(span => span.name === "usage.replay").length;
  const before = count();

  expect((await replayUsageCsv(path, telemetry, { ignoreCursor: true }))?.replayed).toBe(1);
  expect((await replayUsageCsv(path, telemetry, { ignoreCursor: true, ingestionTimestamps: true }))?.replayed).toBe(1);
  const ingesting = exportedSpans()
    .filter(span => strAttr(span, "usage.id") === "hash-c")
    .sort((a, b) => Number(BigInt(b.startTimeUnixNano!)) - Number(BigInt(a.startTimeUnixNano!)))[0]!;
  expect(Math.abs(Date.now() - Number(BigInt(ingesting.startTimeUnixNano!) / 1_000_000n))).toBeLessThan(60_000);

  // Switching back to original mode rewinds and re-emits once.
  expect((await replayUsageCsv(path, telemetry))?.replayed).toBe(1);
  expect(count()).toBe(before + 3);
  const cursor = JSON.parse(readFileSync(`${path}.replayed.json`, "utf-8")) as { mode: string };
  expect(cursor.mode).toBe("original");
});

test("returns null when the CSV is missing", async () => {
  expect(await replayUsageCsv(join(stateDir, "missing.csv"), telemetry)).toBeNull();
});

test("leaves the CSV untouched and writes no cursor when OTEL is disabled", async () => {
  const path = join(stateDir, "no-otel", "dump.csv");
  writeCsv(path, "2025-10-01 00:00:00.000+00,Coding-Agent,cache-model,1,1,hash-n,0\n");

  expect(await replayUsageCsv(path, createTelemetry(null))).toBeNull();
  expect(existsSync(path)).toBe(true);
  expect(existsSync(`${path}.replayed.json`)).toBe(false);
});

test("exports OTLP spans and metrics", async () => {
  await telemetry.forceFlush();

  const traces = JSON.stringify(otlp.traces);
  expect(traces).toContain("POST /api/chat");
  expect(traces).toContain("gen_ai.usage.input_tokens");
  expect(traces).toContain('"http.response.status_code"');

  const metrics = JSON.stringify(otlp.metrics);
  expect(metrics).toContain("proxy.tokens");
  expect(metrics).toContain("proxy.request.duration");
});
