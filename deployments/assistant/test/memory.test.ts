import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MEMORY_LIMITS, ENTRY_DELIMITER, MemoryError, MemoryStore, memoryInstructions } from "../src/memory.ts";

const dirs: string[] = [];

async function store(): Promise<MemoryStore> {
  const dir = await mkdtemp(join(tmpdir(), "assistant-memory-"));
  dirs.push(dir);
  return new MemoryStore(dir);
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("MemoryStore", () => {
  it("adds, patches and removes entries in separate files", async () => {
    const memory = await store();
    await memory.add("memory", "Runs Debian on the homelab server");
    await memory.add("user", "Prefers concise answers");

    expect(await memory.load("memory")).toEqual(["Runs Debian on the homelab server"]);
    expect(await memory.load("user")).toEqual(["Prefers concise answers"]);

    await memory.patch("memory", "Debian", "Ubuntu 24.04");
    expect(await memory.load("memory")).toEqual(["Runs Ubuntu 24.04 on the homelab server"]);

    await memory.remove("user", "concise");
    expect(await memory.load("user")).toEqual([]);
  });

  it("rejects duplicate adds without changing the file", async () => {
    const memory = await store();
    await memory.add("memory", "one fact");
    const result = await memory.add("memory", "one fact");
    expect(result.message).toContain("Duplicate");
    expect(await memory.load("memory")).toEqual(["one fact"]);
  });

  it("requires a unique patch match", async () => {
    const memory = await store();
    await memory.add("memory", "alpha dark mode");
    await memory.add("memory", "beta dark mode");

    await expect(memory.patch("memory", "dark mode", "light mode")).rejects.toBeInstanceOf(MemoryError);
    await memory.patch("memory", "alpha dark mode", "alpha light mode");
    expect(await memory.load("memory")).toEqual(["alpha light mode", "beta dark mode"]);
  });

  it("applies a batch against the resulting state and enforces the limit once", async () => {
    const memory = await store();
    await memory.add("user", "x".repeat(600));
    await memory.add("user", "y".repeat(600));

    const result = await memory.batch("user", [
      { action: "remove", old_text: "x".repeat(600) },
      { action: "add", content: "z".repeat(700) },
    ]);
    expect(result.success).toBe(true);
    expect(await memory.load("user")).toEqual(["y".repeat(600), "z".repeat(700)]);

    await expect(memory.add("user", "w".repeat(200))).rejects.toBeInstanceOf(MemoryError);
  });

  it("renders a hermes-style snapshot with usage", async () => {
    const memory = await store();
    await memory.add("memory", "a");
    await memory.add("memory", "b");
    const rendered = memory.render("memory", await memory.load("memory"));
    expect(rendered).toContain("MEMORY (your personal notes)");
    expect(rendered).toContain("chars]");
    expect(rendered).toContain(`a${ENTRY_DELIMITER}b`);
  });

  it("enforces per-agent limits for each markdown file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "assistant-memory-"));
    dirs.push(dir);
    const memory = new MemoryStore(dir, { memory: 60, user: 20 });

    expect(memory.limits).toEqual({ memory: 60, user: 20 });
    expect(DEFAULT_MEMORY_LIMITS).toEqual({ memory: 2_200, user: 1_375 });

    await memory.add("memory", "m".repeat(55));
    expect(memory.usage(await memory.load("memory"), "memory").limit).toBe(60);
    await expect(memory.add("memory", "extra")).rejects.toBeInstanceOf(MemoryError);
    await expect(memory.add("user", "u".repeat(30))).rejects.toBeInstanceOf(MemoryError);
    await memory.add("user", "short profile");

    expect(memory.render("memory", await memory.load("memory"))).toContain("/60 chars");
    expect(memory.render("user", await memory.load("user"))).toContain("/20 chars");
  });

  it("renders the configured limits into the system prompt block", () => {
    expect(memoryInstructions(DEFAULT_MEMORY_LIMITS)).toContain("Limit 2200 chars");
    expect(memoryInstructions(DEFAULT_MEMORY_LIMITS)).toContain("Limit 1375 chars");
    const instructions = memoryInstructions({ memory: 500, user: 90 });
    expect(instructions).toContain("Limit 500 chars");
    expect(instructions).toContain("Limit 90 chars");
  });

  it("blocks invisible unicode and the entry delimiter", async () => {
    const memory = await store();
    await expect(memory.add("memory", "bad \u200btext")).rejects.toBeInstanceOf(MemoryError);
    await expect(memory.add("memory", `a${ENTRY_DELIMITER}b`)).rejects.toBeInstanceOf(MemoryError);
  });
});
