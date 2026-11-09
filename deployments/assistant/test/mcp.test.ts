import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpToolName, loadAgentMcp, mcpConfigFile, parseMcpConfig } from "../src/mcp.ts";

const dirs: string[] = [];
const fixture = join(import.meta.dir, "fixtures", "mcp-echo.mjs");

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "assistant-mcp-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("MCP config", () => {
  it("finds mcp.json before .mcp.json", () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".mcp.json"), "{}");
    expect(mcpConfigFile(dir)).toBe(join(dir, ".mcp.json"));
    writeFileSync(join(dir, "mcp.json"), "{}");
    expect(mcpConfigFile(dir)).toBe(join(dir, "mcp.json"));
  });

  it("parses stdio and HTTP configs", () => {
    const dir = tempDir();
    const config = parseMcpConfig(
      {
        mcpServers: {
          local: {
            type: "stdio",
            command: "npx",
            args: ["-y", "example"],
            env: { TOKEN: "x" },
            cwd: "project",
          },
          remote: {
            type: "http",
            url: "https://example.test/mcp",
            headers: { Authorization: "Bearer x" },
            timeout: 5000,
          },
        },
        disabledServers: ["remote"],
      },
      join(dir, "mcp.json"),
      dir,
    );

    expect(config.servers.map((server) => server.name)).toEqual(["local", "remote"]);
    expect(config.servers[0]?.cwd).toBe(join(dir, "project"));
    expect(config.servers[1]?.headers).toEqual({ Authorization: "Bearer x" });
    expect(config.servers[1]?.timeout).toBe(5000);
    expect(config.disabled.has("remote")).toBe(true);
  });

  it("rejects invalid configs", () => {
    const dir = tempDir();
    expect(() => parseMcpConfig({ mcpServers: { bad: { type: "stdio" } } }, "mcp.json", dir)).toThrow(
      "command",
    );
    expect(() => parseMcpConfig({ mcpServers: { "bad name": { command: "x" } } }, "mcp.json", dir)).toThrow(
      "invalid MCP server name",
    );
  });

  it("mints stable, short, collision-prone names", () => {
    expect(createMcpToolName("example-local", "echo")).toBe("mcp__example_local_echo");
    expect(createMcpToolName("puppeteer", "puppeteer_screenshot")).toBe("mcp__puppeteer_screenshot");
    expect(createMcpToolName("server", "UPPER case!").length).toBeLessThanOrEqual(64);
    expect(createMcpToolName("a".repeat(100), "b".repeat(100)).length).toBeLessThanOrEqual(64);
  });
});

describe("MCP stdio bridge", () => {
  it("honors disabledServers and enabledServers", async () => {
    const dir = tempDir();
    const server = {
      type: "stdio",
      command: process.execPath,
      args: [fixture],
    };
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { fixture: server }, disabledServers: ["fixture"] }));
    const disabled = await loadAgentMcp(dir);
    expect(disabled.tools).toHaveLength(0);
    expect(disabled.servers).toHaveLength(0);
    await disabled.close();

    writeFileSync(
      join(dir, "mcp.json"),
      JSON.stringify({
        mcpServers: { fixture: { ...server, enabled: false } },
        enabledServers: ["fixture"],
      }),
    );
    const enabled = await loadAgentMcp(dir);
    try {
      expect(enabled.servers).toEqual(["fixture"]);
      expect(enabled.tools).toHaveLength(1);
    } finally {
      await enabled.close();
    }
  }, 20_000);

  it("connects, lists tools, and calls one", async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          fixture: {
            type: "stdio",
            command: process.execPath,
            args: [fixture],
          },
        },
      }),
    );

    const mcp = await loadAgentMcp(dir);
    try {
      expect(mcp.servers).toEqual(["fixture"]);
      expect(mcp.tools.map((tool) => tool.name)).toEqual(["mcp__fixture_echo"]);

      const tool = mcp.tools[0];
      expect(tool).toBeDefined();
      const result = await tool!.execute("call_1", { text: "hi" });
      expect(result.content).toEqual([{ type: "text", text: "echo:hi" }]);
      expect(result.details).toEqual({
        mcp: { server: "fixture", tool: "echo", structuredContent: undefined },
      });
    } finally {
      await mcp.close();
    }
  }, 20_000);
});
