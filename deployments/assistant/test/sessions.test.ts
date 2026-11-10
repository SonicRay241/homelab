import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Message } from "@mariozechner/pi-ai";
import { SessionStore } from "../src/sessions.ts";

const dirs: string[] = [];
const stores: SessionStore[] = [];

async function dbFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "assistant-sessions-"));
  dirs.push(dir);
  return join(dir, "sessions.db");
}

function open(file: string): SessionStore {
  const store = new SessionStore(file);
  stores.push(store);
  return store;
}

function user(text: string): Message {
  return { role: "user", content: text, timestamp: 1 };
}

function assistant(parts: AssistantMessage["content"]): Message {
  return {
    role: "assistant",
    content: parts,
    api: "openai-completions",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: parts.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
    timestamp: 2,
  };
}

function text(value: string): AssistantMessage["content"][number] {
  return { type: "text", text: value };
}

function toolCall(id: string, name: string): AssistantMessage["content"][number] {
  return { type: "toolCall", id, name, arguments: {} };
}

function toolResult(callId: string, name: string, value: string): Message {
  return {
    role: "toolResult",
    toolCallId: callId,
    toolName: name,
    content: [{ type: "text", text: value }],
    isError: false,
    timestamp: 3,
  };
}

function rowCount(file: string, table: string): number {
  const db = new Database(file);
  const row = db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  db.close();
  return row.n;
}

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("SessionStore", () => {
  it("persists transcripts across store instances and filters by user hash", async () => {
    const file = await dbFile();
    const messages = [user("the vault path is /srv/vault"), assistant([text("I will remember that.")])];
    const first = open(file);
    first.save({
      responseId: "resp_1",
      previousResponseId: null,
      userHash: "user-a",
      agentId: "default",
      createdAt: 100,
      systemPrompt: "system",
      messages,
      response: { id: "resp_1", status: "completed" },
    });
    first.save({
      responseId: "resp_2",
      previousResponseId: "resp_1",
      userHash: "user-b",
      agentId: "default",
      createdAt: 200,
      systemPrompt: "system",
      messages,
      response: { id: "resp_2", status: "completed" },
    });
    first.close();
    stores.pop();

    const second = open(file);
    const record = second.get("resp_1", "user-a");
    expect(record?.messages).toEqual(messages);
    expect(record?.response).toEqual({ id: "resp_1", status: "completed" });
    expect(record?.previousResponseId).toBeNull();
    expect(record?.conversationId).toBe("resp_1");
    expect(second.get("resp_1", "user-b")).toBeNull();
    expect(second.get("resp_2", "user-b")?.previousResponseId).toBe("resp_1");
  });

  it("stores only the new suffix of a previous_response_id chain", async () => {
    const file = await dbFile();
    const store = open(file);
    const turn1 = [user("one"), assistant([text("first")])];
    const turn2 = [...turn1, user("two"), assistant([text("second")])];
    store.save({
      responseId: "resp_1",
      previousResponseId: null,
      userHash: "user-a",
      agentId: "default",
      createdAt: 100,
      systemPrompt: "system",
      messages: turn1,
      response: { id: "resp_1" },
    });
    store.save({
      responseId: "resp_2",
      previousResponseId: "resp_1",
      userHash: "user-a",
      agentId: "default",
      createdAt: 200,
      systemPrompt: "system",
      messages: turn2,
      response: { id: "resp_2" },
    });

    expect(store.get("resp_1", "user-a")?.messages).toEqual(turn1);
    expect(store.get("resp_2", "user-a")?.messages).toEqual(turn2);
    expect(store.get("resp_2", "user-a")?.conversationId).toBe("resp_1");
    expect(rowCount(file, "chat_log")).toBe(4);
  });

  it("resumes a replayed chat transcript and ignores hidden server-tool traffic", async () => {
    const file = await dbFile();
    const store = open(file);
    const turn1 = [
      user("hi"),
      assistant([toolCall("srv_1", "server_memory")]),
      toolResult("srv_1", "server_memory", "saved"),
      assistant([text("ok")]),
    ];
    store.save({
      responseId: "resp_c1",
      previousResponseId: null,
      userHash: "user-a",
      agentId: "default",
      createdAt: 100,
      systemPrompt: "system",
      messages: turn1,
      response: { id: "resp_c1" },
      replay: true,
    });

    // Chat clients replay only what they saw: no server tool calls or results.
    const turn2 = [
      user("hi"),
      assistant([text("ok")]),
      user("again"),
      assistant([toolCall("srv_2", "server_memory")]),
      toolResult("srv_2", "server_memory", "saved"),
      assistant([text("done")]),
    ];
    store.save({
      responseId: "resp_c2",
      previousResponseId: null,
      userHash: "user-a",
      agentId: "default",
      createdAt: 100,
      systemPrompt: "system",
      messages: turn2,
      response: { id: "resp_c2" },
      replay: true,
    });

    const second = store.get("resp_c2", "user-a");
    expect(second?.conversationId).toBe("resp_c1");
    // turn1 (4 rows) + turn2's new suffix (user, server call, result, final text).
    expect(rowCount(file, "chat_log")).toBe(8);
    expect(second?.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    expect(JSON.stringify(second?.messages).match(/"hi"/g)).toHaveLength(1);
  });

  it("starts a new conversation when a replay shares no stored prefix", async () => {
    const store = open(await dbFile());
    store.save({
      responseId: "resp_a",
      userHash: "user-a",
      agentId: "default",
      createdAt: 100,
      systemPrompt: "system",
      messages: [user("first chat"), assistant([text("ok")])],
      response: { id: "resp_a" },
      replay: true,
    });
    store.save({
      responseId: "resp_b",
      userHash: "user-a",
      agentId: "default",
      createdAt: 200,
      systemPrompt: "system",
      messages: [user("different chat"), assistant([text("sure")])],
      response: { id: "resp_b" },
      replay: true,
    });
    expect(store.get("resp_b", "user-a")?.conversationId).toBe("resp_b");
  });

  it("searches only the requesting user's messages and returns sibling context", async () => {
    const store = open(await dbFile());
    const turn1 = [user("the vault path is /srv/vault"), assistant([text("noted")])];
    const turn2 = [...turn1, user("where is it?"), assistant([text("still /srv/vault")])];
    for (const [responseId, userHash] of [
      ["resp_a", "user-a"],
      ["resp_b", "user-b"],
    ] as const) {
      store.save({
        responseId,
        userHash,
        agentId: "default",
        createdAt: 1,
        systemPrompt: "system",
        messages: turn1,
        response: { id: responseId },
      });
      store.save({
        responseId: `${responseId}_2`,
        previousResponseId: responseId,
        userHash,
        agentId: "default",
        createdAt: 2,
        systemPrompt: "system",
        messages: turn2,
        response: { id: `${responseId}_2` },
      });
    }

    const results = store.search("user-a", "VAULT");
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.response_id.startsWith("resp_a"))).toBe(true);
    expect(results[0]?.conversation_id).toBe("resp_a");
    expect(results[0]?.snippet.toLowerCase()).toContain("vault");

    const match = store.search("user-a", "where is it")[0]!;
    expect(store.context("user-a", match.message_id, 2, 2).map((message) => message.text)).toEqual([
      "the vault path is /srv/vault",
      "noted",
      "where is it?",
      "still /srv/vault",
    ]);
    expect(store.context("user-b", match.message_id)).toEqual([]);
    expect(store.search("user-a", "VAULT", 5, "resp_b")).toEqual([]);
    expect(store.search("user-a", "missing")).toEqual([]);
  });

  it("migrates the legacy full-snapshot schema into turns and chat rows", async () => {
    const file = await dbFile();
    const messages = [user("the vault path is /srv/vault"), assistant([text("I will remember that.")])];
    const legacy = new Database(file, { create: true });
    legacy.run(`
      CREATE TABLE session (
        response_id TEXT PRIMARY KEY,
        previous_response_id TEXT,
        user_hash TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        system_prompt TEXT NOT NULL,
        messages TEXT NOT NULL,
        response TEXT NOT NULL,
        search_text TEXT NOT NULL
      )
    `);
    legacy
      .prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("resp_1", null, "user-a", "default", 100, "system", JSON.stringify(messages), '{"id":"resp_1"}', "vault");
    legacy.close();

    const store = open(file);
    expect(store.get("resp_1", "user-a")?.messages).toEqual(messages);
    expect(rowCount(file, "chat_log")).toBe(2);
    expect(store.search("user-a", "vault")[0]?.response_id).toBe("resp_1");
  });
});
