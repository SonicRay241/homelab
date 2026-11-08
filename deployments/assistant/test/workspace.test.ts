import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createWorkspaceTools } from "../src/workspace.ts";

const dirs: string[] = [];

async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "assistant-workspace-"));
  dirs.push(dir);
  return dir;
}

function tool(tools: AgentTool[], name: string): AgentTool {
  const found = tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n");
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("workspace tools", () => {
  it("writes, reads and edits files inside the workspace", async () => {
    const workspace = await root();
    const tools = createWorkspaceTools(workspace);

    await tool(tools, "write").execute("1", { path: "notes/a.txt", content: "hello world" });
    expect(text(await tool(tools, "read").execute("2", { path: "notes/a.txt" }))).toBe("hello world");

    await tool(tools, "edit").execute("3", { path: "notes/a.txt", old_string: "world", new_string: "there" });
    expect(text(await tool(tools, "read").execute("4", { path: "notes/a.txt" }))).toBe("hello there");

    await tool(tools, "write").execute("5", { path: "notes/a.txt", content: "x x x" });
    await expect(
      tool(tools, "edit").execute("6", { path: "notes/a.txt", old_string: "x", new_string: "y" }),
    ).rejects.toThrow("occurs 3 times");
  });

  it("rejects paths outside the workspace", async () => {
    const workspace = await root();
    const tools = createWorkspaceTools(workspace);
    await expect(tool(tools, "read").execute("1", { path: "../escape" })).rejects.toThrow("escapes");
    await expect(tool(tools, "write").execute("2", { path: "/etc/passwd", content: "x" })).rejects.toThrow("escapes");
  });

  it("runs bash in the workspace with a minimal environment", async () => {
    const workspace = await realpath(await root());
    const tools = createWorkspaceTools(workspace);
    process.env.ASSISTANT_TEST_SECRET = "do-not-leak";
    try {
      const output = JSON.parse(
        text(
          await tool(tools, "bash").execute("1", {
            command: `pwd; printf '%s' "\${ASSISTANT_TEST_SECRET:-missing}"`,
          }),
        ),
      ) as { exit_code: number; stdout: string };
      expect(output.exit_code).toBe(0);
      expect(output.stdout.split("\n")[0]).toBe(workspace);
      expect(output.stdout).toContain("missing");
      expect(output.stdout).not.toContain("do-not-leak");
    } finally {
      delete process.env.ASSISTANT_TEST_SECRET;
    }
  });
});
