import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HandoffStore, renderHandoffMarkdown } from "../src/handoffs.ts";
import { handoffInboxTool, handoffReadTool, handoffSendTool } from "../src/tools.ts";

const dirs: string[] = [];
const stores: HandoffStore[] = [];

async function db(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "assistant-handoffs-"));
  dirs.push(dir);
  return join(dir, "handoffs.db");
}

function open(file: string): HandoffStore {
  const store = new HandoffStore(file);
  stores.push(store);
  return store;
}

function output(result: { content: { type: string; text?: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
}

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const alice = { userId: "alice", userHash: "hash-a", agent: "default" };
const bob = { userId: "bob", userHash: "hash-b", agent: "default" };
const aliceCoding = { ...alice, agent: "coding" };

describe("HandoffStore", () => {
  it("creates, filters, reads, consumes and survives reopening", async () => {
    const file = await db();
    const first = open(file);
    const coding = first.create({
      kind: "agent",
      sourceUserId: "alice",
      sourceUserHash: "hash-a",
      targetUserId: "alice",
      targetUserHash: "hash-a",
      sourceAgent: "default",
      targetAgent: "coding",
      title: "Idea",
      summary: "Build the thing",
      context: "Use SQLite",
      transcript: "user: research this",
      sourceResponseId: "resp_1",
    });
    first.create({
      kind: "agent",
      sourceUserId: "alice",
      sourceUserHash: "hash-a",
      targetUserId: "alice",
      targetUserHash: "hash-a",
      sourceAgent: "default",
      targetAgent: "other",
      title: "Elsewhere",
      summary: "Not for coding",
    });
    first.create({
      kind: "agent",
      sourceUserId: "bob",
      sourceUserHash: "hash-b",
      targetUserId: "bob",
      targetUserHash: "hash-b",
      sourceAgent: "default",
      targetAgent: "coding",
      title: "Another user",
      summary: "Private",
    });

    expect(first.list(aliceCoding)).toHaveLength(1);
    expect(first.list(aliceCoding).at(0)?.id).toBe(coding.id);
    expect(first.countPending(aliceCoding)).toBe(1);
    expect(first.get(coding.id, { ...aliceCoding, agent: "other" })).toBeNull();
    expect(first.get(coding.id, { ...bob, agent: "coding" })).toBeNull();

    expect(first.markRead(coding.id, aliceCoding)).toBe(true);
    expect(first.list(aliceCoding, "read")).toHaveLength(1);
    expect(first.consume(coding.id, aliceCoding)).toBe(true);
    expect(first.list(aliceCoding, "pending")).toHaveLength(0);
    expect(first.get(coding.id, aliceCoding)?.status).toBe("consumed");

    first.close();
    stores.pop();
    const second = open(file);
    expect(second.get(coding.id, aliceCoding)?.summary).toBe("Build the thing");
    expect(second.get(coding.id, aliceCoding)?.context).toBe("Use SQLite");
  });

  it("delivers user-to-user handoffs to the target user on the same agent", async () => {
    const store = open(await db());
    const record = store.create({
      kind: "user",
      sourceUserId: "alice",
      sourceUserHash: "hash-a",
      targetUserId: "bob",
      targetUserHash: null,
      sourceAgent: "default",
      targetAgent: "default",
      title: "Research notes",
      summary: "Read this before starting",
    });

    expect(store.list(bob).map((entry) => entry.id)).toEqual([record.id]);
    expect(store.list(bob).at(0)?.source_user).toBe("alice");
    expect(store.list(alice)).toHaveLength(0);
    expect(store.list({ ...bob, agent: "coding" })).toHaveLength(0);
    expect(store.get(record.id, bob)?.summary).toBe("Read this before starting");
    expect(store.get(record.id, alice)).toBeNull();

    // Any of the recipient's keys reaches the same inbox: scope is the user id.
    const bobOtherKey = { userId: "bob", userHash: "hash-b2", agent: "default" };
    expect(store.countPending(bobOtherKey)).toBe(1);
    expect(store.get(record.id, bobOtherKey)?.id).toBe(record.id);
    expect(store.consume(record.id, bobOtherKey)).toBe(true);
    expect(store.countPending(bob)).toBe(0);
  });

  it("migrates the pre-user-id schema", async () => {
    const file = await db();
    const legacy = new Database(file, { create: true });
    legacy.run(`
      CREATE TABLE handoff (
        id TEXT PRIMARY KEY,
        user_hash TEXT NOT NULL,
        source_agent TEXT NOT NULL,
        target_agent TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        context TEXT NOT NULL,
        transcript TEXT NOT NULL,
        source_response_id TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        read_at INTEGER,
        consumed_at INTEGER
      )
    `);
    legacy.run(
      `INSERT INTO handoff (id, user_hash, source_agent, target_agent, title, summary, context, transcript, status, created_at)
       VALUES ('ho_old', 'hash-a', 'default', 'coding', 'Old', 'Legacy row', '', '', 'pending', 1)`,
    );
    legacy.close();

    const store = open(file);
    expect(store.list(aliceCoding).map((entry) => entry.id)).toEqual(["ho_old"]);
    expect(store.get("ho_old", aliceCoding)?.kind).toBe("agent");
    // Legacy rows have no user id, so the key hash still scopes them.
    expect(store.get("ho_old", { ...aliceCoding, userHash: "hash-other" })).toBeNull();
  });

  it("renders markdown with the payload", async () => {
    const store = open(await db());
    const record = store.create({
      kind: "user",
      sourceUserId: "alice",
      sourceUserHash: "hash-a",
      targetUserId: "bob",
      targetUserHash: null,
      sourceAgent: "default",
      targetAgent: "default",
      title: "Idea",
      summary: "Build the thing",
      context: "Use SQLite",
    });
    const markdown = renderHandoffMarkdown(record);
    expect(markdown).toContain("# Handoff: Idea");
    expect(markdown).toContain("- kind: user");
    expect(markdown).toContain("## Summary");
    expect(markdown).toContain("Build the thing");
    expect(markdown).toContain("Use SQLite");
  });
});

describe("handoff tools", () => {
  it("sends, lists and reads an agent handoff for the same user", async () => {
    const store = open(await db());
    const send = handoffSendTool({
      store,
      scope: alice,
      validAgents: ["coding"],
      validUsers: ["bob"],
      sourceResponseId: "resp_1",
      transcript: "user: research this",
    });

    const sent = output(
      await send.execute("1", {
        target_agent: "coding",
        title: "Idea",
        summary: "Build the thing",
        context: "Use SQLite",
      }),
    );
    expect(sent.success).toBe(true);
    const id = String((sent.handoff as Record<string, unknown>).id);

    const inbox = handoffInboxTool(store, aliceCoding);
    const listed = output(await inbox.execute("2", {}));
    expect((listed.handoffs as unknown[]).length).toBe(1);

    const read = handoffReadTool(store, aliceCoding);
    const loaded = output(await read.execute("3", { id }));
    expect(loaded.success).toBe(true);
    expect((loaded.handoff as Record<string, unknown>).transcript).toBe("user: research this");
    expect(store.countPending(aliceCoding)).toBe(0);
  });

  it("sends a user handoff that the target user reads on the same agent", async () => {
    const store = open(await db());
    const send = handoffSendTool({
      store,
      scope: alice,
      validAgents: ["coding"],
      validUsers: ["bob"],
      transcript: "",
    });

    const sent = output(
      await send.execute("1", { target_user: "bob", title: "Notes", summary: "For Bob" }),
    );
    expect(sent.success).toBe(true);
    const handoff = sent.handoff as Record<string, unknown>;
    expect(handoff.kind).toBe("user");
    expect(handoff.target_agent).toBe("default");
    expect(store.list(alice)).toHaveLength(0);

    const inbox = handoffInboxTool(store, bob);
    const listed = output(await inbox.execute("2", {}));
    expect((listed.handoffs as unknown[]).length).toBe(1);
    expect((listed.handoffs as Record<string, unknown>[])[0]?.source_user).toBe("alice");

    const read = handoffReadTool(store, bob);
    const loaded = output(await read.execute("3", { id: String(handoff.id) }));
    expect(loaded.success).toBe(true);
    expect(store.countPending(bob)).toBe(0);
  });

  it("rejects self, unknown and ambiguous targets", async () => {
    const store = open(await db());
    const send = handoffSendTool({
      store,
      scope: alice,
      validAgents: ["coding"],
      validUsers: ["bob"],
      transcript: "",
    });
    const sendable = async (params: { title: string; summary: string } & Record<string, unknown>) =>
      output(await send.execute("1", params));

    expect((await sendable({ target_agent: "default", title: "x", summary: "y" })).success).toBe(false);
    expect((await sendable({ target_agent: "unknown", title: "x", summary: "y" })).success).toBe(false);
    expect((await sendable({ target_user: "alice", title: "x", summary: "y" })).success).toBe(false);
    expect((await sendable({ target_user: "eve", title: "x", summary: "y" })).success).toBe(false);
    expect((await sendable({ title: "x", summary: "y" })).success).toBe(false);
    expect(
      (await sendable({ target_agent: "coding", target_user: "bob", title: "x", summary: "y" })).success,
    ).toBe(false);
  });
});
