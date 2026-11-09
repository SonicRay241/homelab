import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentOverrides } from "../src/agent-config.ts";

const dirs: string[] = [];

async function basedir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "assistant-cli-"));
  dirs.push(dir);
  return dir;
}

async function cli(args: string[], base: string): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", "run", "cli.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, BASEDIR: base },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("agent CLI", () => {
  it("creates, configures, lists and removes an agent", async () => {
    const base = await basedir();
    const agentDir = join(base, "agent", "research");

    expect((await cli(["list"], base)).out).toContain("no agents");

    const created = await cli(["new", "research", "--model", "research:cloud", "--allow", "alice"], base);
    expect(created.code).toBe(0);
    expect(created.out).toContain("created research");
    expect(await readFile(join(agentDir, "mcp.example.json"), "utf8")).toContain("mcpServers");

    expect((await cli(["set", "research", "maxInputTokens", "1234"], base)).code).toBe(0);
    expect((await cli(["set", "research", "compactionThreshold", "0.5"], base)).code).toBe(0);
    expect((await cli(["set", "research", "apiKey", "super-secret"], base)).code).toBe(0);
    expect((await cli(["set", "research", "reasoningEffort", "high"], base)).code).toBe(0);
    expect((await cli(["set", "research", "vision", "true"], base)).code).toBe(0);
    expect((await cli(["set", "research", "vision", "yes"], base)).code).toBe(1);
    expect((await cli(["set", "research", "allowedReasoningEfforts", "low,high,none"], base)).code).toBe(0);
    expect((await cli(["allow", "research", "bob"], base)).code).toBe(0);
    expect((await cli(["deny", "research", "mallory"], base)).code).toBe(0);

    const config = loadAgentOverrides(agentDir);
    expect(config).toMatchObject({
      model: "research:cloud",
      maxInputTokens: 1234,
      compactionThreshold: 0.5,
      allowedUsers: ["alice", "bob"],
      deniedUsers: ["mallory"],
      reasoningEffort: "high",
      vision: true,
      allowedReasoningEfforts: ["low", "high", "off"],
    });
    expect(config.apiKey).toBe("super-secret");

    const shown = await cli(["show", "research"], base);
    expect(shown.out).toContain("model: research:cloud");
    expect(shown.out).toContain("reasoningEffort: high");
    expect(shown.out).toContain("vision: true");
    expect(shown.out).not.toContain("super-secret");
    expect(shown.out).toContain("***");

    const listed = await cli(["list"], base);
    expect(listed.out).toContain("research");
    expect((await cli(["validate"], base)).code).toBe(0);

    await writeFile(join(agentDir, "mcp.json"), "{");
    const badMcp = await cli(["validate"], base);
    expect(badMcp.code).toBe(1);
    expect(badMcp.err).toContain("invalid JSON");

    expect((await cli(["remove", "research"], base)).code).toBe(1);
    expect((await cli(["remove", "research", "--yes"], base)).code).toBe(0);
  });

  it("prints the resolved BASEDIR paths", async () => {
    const base = await basedir();
    const result = await cli(["path"], base);
    expect(result.code).toBe(0);
    expect(result.out).toContain(base);
    expect(result.out).toContain(join(base, "agent"));
  });
});
