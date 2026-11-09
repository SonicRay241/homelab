import { describe, expect, it } from "bun:test";
import { MemoryStore } from "../src/memory.ts";
import {
  isServerToolName,
  memoryTool,
  namespaceServerTool,
  SERVER_TOOL_INSTRUCTIONS,
  SERVER_TOOL_PREFIX,
} from "../src/tools.ts";

describe("server tool namespacing", () => {
  it("prefixes server tools without mutating the original", () => {
    const original = memoryTool(new MemoryStore("/tmp/assistant-tool-test"));
    const namespaced = namespaceServerTool(original);

    expect(SERVER_TOOL_PREFIX).toBe("server_");
    expect(original.name).toBe("memory");
    expect(namespaced.name).toBe("server_memory");
    expect(namespaced.execute).toBe(original.execute);
    expect(namespaced.parameters).toBe(original.parameters);
  });

  it("reserves the prefix for server tools while leaving client names alone", () => {
    expect(isServerToolName("server_memory")).toBe(true);
    expect(isServerToolName("server_bash")).toBe(true);
    expect(isServerToolName("mcp__example_echo")).toBe(true);
    expect(isServerToolName("memory")).toBe(false);
    expect(isServerToolName("bash")).toBe(false);
    expect(isServerToolName("my_server_tool")).toBe(false);
  });

  it("explains the convention in the system prompt block", () => {
    expect(SERVER_TOOL_INSTRUCTIONS).toContain("`server_`");
    expect(SERVER_TOOL_INSTRUCTIONS).toContain("`mcp__`");
    expect(SERVER_TOOL_INSTRUCTIONS).toContain("Client-provided tools");
  });
});
