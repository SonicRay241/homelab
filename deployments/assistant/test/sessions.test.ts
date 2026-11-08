import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@mariozechner/pi-ai";
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

const messages: Message[] = [
  { role: "user", content: "the vault path is /srv/vault", timestamp: 1 },
  {
    role: "assistant",
    content: [{ type: "text", text: "I will remember that." }],
    api: "openai-completions",
    provider: "test",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: 2,
  },
];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("SessionStore", () => {
  it("persists transcripts across store instances and filters by user hash", async () => {
    const file = await dbFile();
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
      searchText: "the vault path is /srv/vault",
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
      searchText: "the vault path is /srv/vault",
    });
    first.close();
    stores.pop();

    const second = open(file);
    const record = second.get("resp_1", "user-a");
    expect(record?.messages).toEqual(messages);
    expect(record?.response).toEqual({ id: "resp_1", status: "completed" });
    expect(record?.previousResponseId).toBeNull();
    expect(second.get("resp_1", "user-b")).toBeNull();
    expect(second.get("resp_2", "user-b")?.previousResponseId).toBe("resp_1");
  });

  it("searches only the requesting user's sessions", async () => {
    const store = open(await dbFile());
    for (const [responseId, userHash] of [
      ["resp_a", "user-a"],
      ["resp_b", "user-b"],
    ] as const) {
      store.save({
        responseId,
        previousResponseId: null,
        userHash,
        agentId: "default",
        createdAt: 1,
        systemPrompt: "system",
        messages,
        response: { id: responseId },
        searchText: "the vault path is /srv/vault",
      });
    }

    const results = store.search("user-a", "VAULT");
    expect(results).toHaveLength(1);
    expect(results[0]?.response_id).toBe("resp_a");
    expect(results[0]?.snippet.toLowerCase()).toContain("vault");
    expect(store.search("user-a", "VAULT", 5, "resp_b")).toEqual([]);
    expect(store.search("user-a", "missing")).toEqual([]);
  });
});
