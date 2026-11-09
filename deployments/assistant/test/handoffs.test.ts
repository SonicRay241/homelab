import { afterEach, describe, expect, it } from "bun:test";
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

describe("HandoffStore", () => {
  it("creates, filters, reads, consumes and survives reopening", async () => {
    const file = await db();
    const first = open(file);
    const coding = first.create({
      userHash: "user-a",
      sourceAgent: "default",
      targetAgent: "coding",
      title: "Idea",
      summary: "Build the thing",
      context: "Use SQLite",
      transcript: "user: research this",
      sourceResponseId: "resp_1",
    });
    first.create({
      userHash: "user-a",
      sourceAgent: "default",
      targetAgent: "other",
      title: "Elsewhere",
      summary: "Not for coding",
    });
    first.create({
      userHash: "user-b",
      sourceAgent: "default",
      targetAgent: "coding",
      title: "Another user",
      summary: "Private",
    });

    expect(first.list("user-a", "coding")).toHaveLength(1);
    expect(first.list("user-a", "coding").at(0)?.id).toBe(coding.id);
    expect(first.countPending("user-a", "coding")).toBe(1);
    expect(first.get(coding.id, "user-a", "other")).toBeNull();
    expect(first.get(coding.id, "user-b", "coding")).toBeNull();

    expect(first.markRead(coding.id, "user-a", "coding")).toBe(true);
    expect(first.list("user-a", "coding", "read")).toHaveLength(1);
    expect(first.consume(coding.id, "user-a", "coding")).toBe(true);
    expect(first.list("user-a", "coding", "pending")).toHaveLength(0);
    expect(first.get(coding.id, "user-a", "coding")?.status).toBe("consumed");

    first.close();
    stores.pop();
    const second = open(file);
    expect(second.get(coding.id, "user-a", "coding")?.summary).toBe("Build the thing");
    expect(second.get(coding.id, "user-a", "coding")?.context).toBe("Use SQLite");
  });

  it("renders markdown with the payload", async () => {
    const store = open(await db());
    const record = store.create({
      userHash: "user-a",
      sourceAgent: "default",
      targetAgent: "coding",
      title: "Idea",
      summary: "Build the thing",
      context: "Use SQLite",
    });
    const markdown = renderHandoffMarkdown(record);
    expect(markdown).toContain("# Handoff: Idea");
    expect(markdown).toContain("## Summary");
    expect(markdown).toContain("Build the thing");
    expect(markdown).toContain("Use SQLite");
  });
});

describe("handoff tools", () => {
  it("sends, lists and reads a handoff for the target agent", async () => {
    const store = open(await db());
    const send = handoffSendTool({
      store,
      userHash: "user-a",
      sourceAgent: "default",
      validTargets: ["coding"],
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

    const inbox = handoffInboxTool(store, "user-a", "coding");
    const listed = output(await inbox.execute("2", {}));
    expect((listed.handoffs as unknown[]).length).toBe(1);

    const read = handoffReadTool(store, "user-a", "coding");
    const loaded = output(await read.execute("3", { id }));
    expect(loaded.success).toBe(true);
    expect((loaded.handoff as Record<string, unknown>).transcript).toBe("user: research this");
    expect(store.countPending("user-a", "coding")).toBe(0);
  });

  it("rejects self and unknown targets", async () => {
    const store = open(await db());
    const send = handoffSendTool({
      store,
      userHash: "user-a",
      sourceAgent: "default",
      validTargets: ["coding"],
      transcript: "",
    });
    expect(output(await send.execute("1", { target_agent: "default", title: "x", summary: "y" })).success).toBe(false);
    expect(output(await send.execute("2", { target_agent: "unknown", title: "x", summary: "y" })).success).toBe(false);
  });
});
