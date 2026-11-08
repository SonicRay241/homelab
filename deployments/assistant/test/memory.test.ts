import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENTRY_DELIMITER, MemoryError, MemoryStore } from "../src/memory.ts";

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

  it("blocks invisible unicode and the entry delimiter", async () => {
    const memory = await store();
    await expect(memory.add("memory", "bad \u200btext")).rejects.toBeInstanceOf(MemoryError);
    await expect(memory.add("memory", `a${ENTRY_DELIMITER}b`)).rejects.toBeInstanceOf(MemoryError);
  });
});
