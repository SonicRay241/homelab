import { describe, expect, it } from "bun:test";
import { join, resolve } from "node:path";
import { PROJECT_ROOT, resolveAgentDir, resolveAgentsDir, resolveBasedir } from "../src/basedir.ts";

describe("BASEDIR resolution", () => {
  it("resolves absolute and project-relative basedirs", () => {
    expect(resolveBasedir("/tmp/assistant-basedir")).toBe("/tmp/assistant-basedir");
    expect(resolveBasedir("state")).toBe(resolve(PROJECT_ROOT, "state"));
  });

  it("defaults the agent directory to BASEDIR/agent", () => {
    const basedir = "/tmp/assistant-basedir";
    expect(resolveAgentsDir(basedir, "agent")).toBe(join(basedir, "agent"));
    expect(resolveAgentsDir(basedir, "/tmp/other-agents")).toBe("/tmp/other-agents");
    expect(resolveAgentDir(basedir, join(basedir, "agent"), "default", undefined)).toBe(
      join(basedir, "agent", "default"),
    );
    expect(resolveAgentDir(basedir, join(basedir, "agent"), "default", "custom/agent")).toBe(
      join(basedir, "custom/agent"),
    );
  });
});
