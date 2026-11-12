import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HandoffStore } from "../src/handoffs.ts";
import {
  describeSkill,
  isValidSkillName,
  resolveSkillReferences,
  SkillError,
  SkillStore,
  skillsInstructions,
} from "../src/skills.ts";
import { handoffReadTool, handoffSendTool, skillImportTool, skillReadTool, skillSearchTool, skillWriteTool } from "../src/tools.ts";

const dirs: string[] = [];
const handoffs: HandoffStore[] = [];

async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "assistant-skills-"));
  dirs.push(dir);
  return dir;
}

async function store(): Promise<SkillStore> {
  return new SkillStore(join(await root(), "skill"));
}

function handoff(file: string): HandoffStore {
  const store = new HandoffStore(join(file, "handoffs.db"));
  handoffs.push(store);
  return store;
}

function output(result: { content: { type: string; text?: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
}

const alice = { userId: "alice", userHash: "hash-a", agent: "default" };
const bob = { userId: "bob", userHash: "hash-b", agent: "default" };

afterEach(async () => {
  for (const store of handoffs.splice(0)) store.close();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("SkillStore", () => {
  it("writes, indexes, reads and deletes markdown skills", async () => {
    const skills = await store();
    expect(await skills.list()).toEqual([]);
    expect(await skills.read("deploy")).toBeNull();

    const first = await skills.write("deploy", "# Deploy\n\nRun the compose file on theta.\n");
    expect(first).toEqual({ name: "deploy", created: true });
    expect((await skills.write("deploy", "# Deploy\n\nUpdated.\n")).created).toBe(false);
    await skills.write("rotate-keys", "# Rotate keys\n\nUse Infisical.\n");

    expect(await skills.list()).toEqual([
      expect.objectContaining({ name: "deploy", title: "Deploy", description: "Updated." }),
      expect.objectContaining({ name: "rotate-keys", title: "Rotate keys", description: "Use Infisical." }),
    ]);
    expect(await skills.read("deploy")).toContain("Updated.");

    expect(await skills.remove("deploy")).toBe(true);
    expect(await skills.remove("deploy")).toBe(false);
    expect((await skills.list()).map((entry) => entry.name)).toEqual(["rotate-keys"]);
  });

  it("validates names and content", async () => {
    const skills = await store();
    expect(isValidSkillName("deploy_2")).toBe(true);
    expect(isValidSkillName("../etc/passwd")).toBe(false);
    expect(isValidSkillName("Deploy")).toBe(false);
    await expect(skills.write("../escape", "# x")).rejects.toBeInstanceOf(SkillError);
    await expect(skills.write("empty", "   ")).rejects.toBeInstanceOf(SkillError);
    await expect(skills.write("big", "x".repeat(64_001))).rejects.toBeInstanceOf(SkillError);
  });

  it("searches skill contents with line numbers", async () => {
    const skills = await store();
    await skills.write("deploy", "# Deploy\n\nline two\n\nRun `docker compose up` on theta.\n");
    await skills.write("other", "# Other\n\nNothing here.\n");

    expect(await skills.search("DOCKER COMPOSE")).toEqual([
      { name: "deploy", line: 5, snippet: expect.stringContaining("docker compose up") },
    ]);
    expect(await skills.search("theta", 1)).toHaveLength(1);
    expect(await skills.search("   ")).toEqual([]);
  });

  it("builds the prompt index and resolves memory references", async () => {
    const skills = await store();
    await skills.write("deploy", "# Deploy\n\nRun the compose file on theta.\n");
    const entries = await skills.list();

    expect(describeSkill("# Title\n\nPurpose here.\n")).toEqual({ title: "Title", description: "Purpose here." });
    const instructions = skillsInstructions(entries);
    expect(instructions).toContain("`deploy`: Run the compose file on theta.");
    expect(skillsInstructions([])).toContain("(no skills yet)");

    expect(resolveSkillReferences(["see skill:deploy before shipping"], entries)).toEqual([
      "see skill:deploy (Run the compose file on theta.) before shipping",
    ]);
    expect(resolveSkillReferences(["skill:missing"], entries)).toEqual(["skill:missing"]);
  });
});

describe("skill tools", () => {
  it("reads, writes, searches and deletes through the server tools", async () => {
    const skills = await store();
    const write = skillWriteTool(skills);
    const read = skillReadTool(skills);
    const search = skillSearchTool(skills);

    expect(output(await write.execute("1", { name: "deploy", content: "# Deploy\n\nUse compose.\n" })).success).toBe(
      true,
    );
    const loaded = output(await read.execute("2", { name: "deploy" }));
    expect(loaded.content).toContain("Use compose.");
    expect(output(await read.execute("3", { name: "missing" })).success).toBe(false);
    const found = output(await search.execute("4", { query: "compose" }));
    expect((found.results as unknown[]).length).toBe(1);
  });

  it("shares a skill through a handoff and imports it for the recipient", async () => {
    const base = await root();
    const source = new SkillStore(join(base, "alice-skill"));
    const target = new SkillStore(join(base, "bob-skill"));
    await source.write("deploy", "# Deploy\n\nRun compose on theta.\n");
    const store = handoff(base);

    const send = handoffSendTool({
      store,
      scope: alice,
      skills: source,
      validAgents: [],
      validUsers: ["bob"],
      transcript: "",
    });
    const sent = output(
      await send.execute("1", { target_user: "bob", title: "Deploy skill", summary: "Reusable", skill: "deploy" }),
    );
    expect(sent.success).toBe(true);
    const id = String((sent.handoff as Record<string, unknown>).id);
    expect((sent.handoff as Record<string, unknown>).skill).toBe("deploy");

    const read = handoffReadTool(store, bob);
    const loaded = output(await read.execute("2", { id, consume: false }));
    expect((loaded.handoff as Record<string, unknown>).skillContent).toContain("Run compose on theta.");

    const importTool = skillImportTool(target, store, bob);
    const imported = output(await importTool.execute("3", { id }));
    expect(imported.success).toBe(true);
    expect(await target.read("deploy")).toContain("Run compose on theta.");
    expect(output(await importTool.execute("4", { id, name: "renamed" })).success).toBe(true);
    expect(await target.read("renamed")).toContain("Run compose on theta.");

    expect(output(await skillImportTool(target, store, alice).execute("5", { id })).success).toBe(false);
  });

  it("rejects a handoff whose skill does not exist", async () => {
    const base = await root();
    const skills = new SkillStore(join(base, "skill"));
    const store = handoff(base);
    const send = handoffSendTool({
      store,
      scope: alice,
      skills,
      validAgents: [],
      validUsers: ["bob"],
      transcript: "",
    });
    const result = output(
      await send.execute("1", { target_user: "bob", title: "x", summary: "y", skill: "missing" }),
    );
    expect(result.success).toBe(false);
  });
});
