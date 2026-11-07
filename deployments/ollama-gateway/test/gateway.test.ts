import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { createInfisicalClient } from "../src/auth/infisical.ts";
import { TokenRegistry, hashToken } from "../src/auth/tokens.ts";
import type { Config } from "../src/config.ts";
import { replayLegacyUsage } from "../src/migrate.ts";
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
type OtlpSpan = { name: string; startTimeUnixNano?: string; attributes?: { key: string; value: OtlpValue }[] };
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
  legacyDbPath: join(stateDir, "usage.db"),
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
  expect(intAttr(span!, "gen_ai.usage.input_tokens")).toBe(11);
  expect(intAttr(span!, "gen_ai.usage.output_tokens")).toBe(5);
  expect(intAttr(span!, "gen_ai.usage.cached_input_tokens")).toBe(2);
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

const LEGACY_SCHEMA = `
  CREATE TABLE usage_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    date TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    endpoint TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    cached_input_tokens INTEGER
  );
`;

function writeLegacyDb(path: string, rows: { timestamp: string; endpoint: string; cached: number | null }[]) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec(LEGACY_SCHEMA);
  const insert = db.prepare(
    "INSERT INTO usage_logs (timestamp, date, model, input_tokens, output_tokens, total_tokens, endpoint, key_hash, cached_input_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  for (const row of rows) {
    insert.run(row.timestamp, row.timestamp.slice(0, 10), "legacy-model", 20, 4, 24, row.endpoint, "legacykey", row.cached);
  }
  db.close();
}

test("replays a legacy usage DB to OTLP without deleting it", async () => {
  const legacyPath = join(stateDir, "legacy", "proxy-costs.db");
  const rows = [
    { timestamp: "2025-01-02T03:04:05.000Z", endpoint: "/api/chat", cached: null },
    { timestamp: "2025-01-03T04:05:06.000Z", endpoint: "/api/generate", cached: 3 },
  ];
  writeLegacyDb(legacyPath, rows);

  const result = await replayLegacyUsage(legacyPath, telemetry);
  expect(result?.replayed).toBe(2);

  // Source and progress cursor stay in place; nothing is renamed.
  expect(existsSync(legacyPath)).toBe(true);
  expect(existsSync(`${legacyPath}.migrated`)).toBe(false);
  expect(JSON.parse(readFileSync(`${legacyPath}.replayed.json`, "utf-8")).lastId).toBe(2);

  const replays = () => exportedSpans().filter(span => span.name.startsWith("usage.replay "));
  expect(replays().length).toBe(2);

  const chat = replays().find(span => span.name === "usage.replay /api/chat")!;
  expect(attr(chat, "proxy.replay")?.boolValue).toBe(true);
  expect(strAttr(chat, "gen_ai.request.model")).toBe("legacy-model");
  expect(intAttr(chat, "gen_ai.usage.input_tokens")).toBe(20);
  expect(intAttr(chat, "gen_ai.usage.output_tokens")).toBe(4);
  expect(intAttr(chat, "usage.row_id")).toBe(1);
  expect(strAttr(chat, "usage.timestamp")).toBe(rows[0]!.timestamp);
  expect(attr(chat, "gen_ai.usage.cached_input_tokens")).toBeUndefined();
  expect(strAttr(chat, "proxy.key_hash")).toBe("legacykey");

  // Spans are stamped at replay time so backends inside their ingestion window accept them.
  const replayMs = Number(BigInt(chat.startTimeUnixNano!) / 1_000_000n);
  expect(Math.abs(Date.now() - replayMs)).toBeLessThan(60_000);

  const generate = replays().find(span => span.name === "usage.replay /api/generate")!;
  expect(intAttr(generate, "gen_ai.usage.cached_input_tokens")).toBe(3);

  // Counters land at replay time and are tagged so dashboards can separate them from live traffic.
  const metrics = JSON.stringify(otlp.metrics);
  expect(metrics).toContain("proxy.replayed");
  expect(metrics).toContain("legacy-model");

  // A second run resumes from the cursor and emits nothing new.
  const resumed = await replayLegacyUsage(legacyPath, telemetry);
  expect(resumed?.replayed).toBe(0);
  expect(replays().length).toBe(2);

  // Forced backfill re-sends everything; optional original timestamps for backends that accept them.
  const forced = await replayLegacyUsage(legacyPath, telemetry, { ignoreCursor: true, preserveTimestamps: true });
  expect(forced?.replayed).toBe(2);
  expect(replays().length).toBe(4);
  const pinned = replays()
    .filter(span => strAttr(span, "usage.timestamp") === rows[0]!.timestamp)
    .at(-1)!;
  expect(pinned.startTimeUnixNano).toBe(String(BigInt(Date.parse(rows[0]!.timestamp)) * 1_000_000n));
});

test("finds a .migrated file left by the old migrator", async () => {
  const base = join(stateDir, "old-migrator", "proxy-costs.db");
  writeLegacyDb(base, [{ timestamp: "2025-02-01T00:00:00.000Z", endpoint: "/api/chat", cached: null }]);
  renameSync(base, `${base}.migrated`);

  const result = await replayLegacyUsage(base, telemetry);

  expect(result?.source).toBe(`${base}.migrated`);
  expect(result?.replayed).toBe(1);
  expect(existsSync(`${base}.migrated`)).toBe(true);

  // Discovery must ignore the cursor JSON it just wrote next to the source.
  const again = await replayLegacyUsage(base, telemetry);
  expect(again?.source).toBe(`${base}.migrated`);
  expect(again?.replayed).toBe(0);
});

test("leaves the legacy DB untouched when OTEL is disabled", async () => {
  const legacyPath = join(stateDir, "no-otel", "proxy-costs.db");
  writeLegacyDb(legacyPath, [{ timestamp: "2026-02-01T00:00:00.000Z", endpoint: "/api/chat", cached: null }]);

  await replayLegacyUsage(legacyPath, createTelemetry(null));

  expect(existsSync(legacyPath)).toBe(true);
  expect(existsSync(`${legacyPath}.migrated`)).toBe(false);
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
