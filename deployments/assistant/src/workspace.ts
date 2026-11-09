import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type, type Static } from "@mariozechner/pi-ai";
import type { AssistantConfig } from "./config.ts";

const MAX_READ_BYTES = 5 * 1024 * 1024;
const MAX_WRITE_CHARS = 2 * 1024 * 1024;
const MAX_READ_LINES = 2_000;
const MAX_OUTPUT_CHARS = 100_000;

export function workspaceDirectory(config: AssistantConfig, userHash: string): string {
  return join(config.agentDir, `user-${userHash}`);
}

function resolveInWorkspace(root: string, requested: string): string {
  const base = resolve(root);
  const target = resolve(base, requested || ".");
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`Path escapes the workspace: ${requested}`);
  }
  return target;
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }], details: {} };
}

const ReadParams = Type.Object({
  path: Type.String({ description: "Path relative to the workspace" }),
  offset: Type.Optional(Type.Number({ description: "1-based first line (default 1)" })),
  limit: Type.Optional(Type.Number({ description: `Maximum lines (default ${MAX_READ_LINES})` })),
});

const WriteParams = Type.Object({
  path: Type.String({ description: "Path relative to the workspace" }),
  content: Type.String({ description: "Full file content to write" }),
});

const EditParams = Type.Object({
  path: Type.String({ description: "Path relative to the workspace" }),
  old_string: Type.String({ description: "Exact text to replace; must be unique unless replace_all is true" }),
  new_string: Type.String({ description: "Replacement text" }),
  replace_all: Type.Optional(Type.Boolean({ description: "Replace every occurrence (default false)" })),
});

const BashParams = Type.Object({
  command: Type.String({ description: "Shell command; it starts in the workspace" }),
  timeout_ms: Type.Optional(Type.Number({ description: "Timeout in milliseconds (default 30000, max 120000)" })),
});

type ReadArgs = Static<typeof ReadParams>;
type WriteArgs = Static<typeof WriteParams>;
type EditArgs = Static<typeof EditParams>;
type BashArgs = Static<typeof BashParams>;

function readTool(root: string): AgentTool<typeof ReadParams> {
  return {
    name: "read",
    label: "Read File",
    description:
      "Read a UTF-8 file from the user's workspace. offset/limit are 1-based line numbers. " +
      "Paths outside the workspace are rejected.",
    parameters: ReadParams,
    execute: async (_id, params) => {
      const file = resolveInWorkspace(root, params.path);
      const info = await stat(file);
      if (info.size > MAX_READ_BYTES) throw new Error(`File is too large (${info.size} bytes; max ${MAX_READ_BYTES})`);
      const content = await readFile(file, "utf8");
      const lines = content.split("\n");
      const offset = Math.max(1, Math.floor(params.offset ?? 1));
      const limit = Math.max(1, Math.min(MAX_READ_LINES, Math.floor(params.limit ?? MAX_READ_LINES)));
      const selected = lines.slice(offset - 1, offset - 1 + limit);
      const truncated = offset - 1 + limit < lines.length;
      return text(
        `${selected.join("\n")}${truncated ? `\n\n[truncated at ${limit} lines; file has ${lines.length} lines]` : ""}`,
      );
    },
  };
}

function writeTool(root: string): AgentTool<typeof WriteParams> {
  return {
    name: "write",
    label: "Write File",
    description: "Write a UTF-8 file in the user's workspace, creating parent directories.",
    parameters: WriteParams,
    execute: async (_id, params) => {
      if (params.content.length > MAX_WRITE_CHARS) {
        throw new Error(`Content is too large (${params.content.length} chars; max ${MAX_WRITE_CHARS})`);
      }
      const file = resolveInWorkspace(root, params.path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, params.content, "utf8");
      return text(JSON.stringify({ path: params.path, bytes: Buffer.byteLength(params.content) }));
    },
  };
}

function editTool(root: string): AgentTool<typeof EditParams> {
  return {
    name: "edit",
    label: "Edit File",
    description:
      "Replace exact text in a workspace file. old_string must occur once unless replace_all is true.",
    parameters: EditParams,
    execute: async (_id, params) => {
      const file = resolveInWorkspace(root, params.path);
      const content = await readFile(file, "utf8");
      if (!params.old_string) throw new Error("old_string must not be empty");
      const occurrences = content.split(params.old_string).length - 1;
      if (occurrences === 0) throw new Error("old_string was not found");
      if (occurrences > 1 && !params.replace_all) {
        throw new Error(`old_string occurs ${occurrences} times; provide more context or set replace_all`);
      }
      const next = params.replace_all
        ? content.split(params.old_string).join(params.new_string)
        : content.replace(params.old_string, params.new_string);
      await writeFile(file, next, "utf8");
      return text(JSON.stringify({ path: params.path, replacements: occurrences }));
    },
  };
}

function bashTool(root: string): AgentTool<typeof BashParams> {
  return {
    name: "bash",
    label: "Bash",
    description:
      "Run a bash command in the user's workspace. The command starts in the workspace and inherits a " +
      "minimal environment (no server secrets). This is a working directory, not a filesystem sandbox.",
    parameters: BashParams,
    execute: async (_id, params) => {
      await mkdir(root, { recursive: true });
      const timeout = Math.max(1_000, Math.min(120_000, Math.floor(params.timeout_ms ?? 30_000)));
      const proc = Bun.spawn(["bash", "--noprofile", "--norc", "-c", params.command], {
        cwd: root,
        env: {
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          HOME: root,
          LANG: process.env.LANG ?? "C.UTF-8",
          TERM: "dumb",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const timer = setTimeout(() => proc.kill(), timeout);
      try {
        const [stdoutRaw, stderrRaw, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        const stdout = stdoutRaw.slice(0, MAX_OUTPUT_CHARS);
        const stderr = stderrRaw.slice(0, MAX_OUTPUT_CHARS);
        return text(
          JSON.stringify({
            exit_code: exitCode,
            stdout,
            stderr,
            truncated: stdoutRaw.length > MAX_OUTPUT_CHARS || stderrRaw.length > MAX_OUTPUT_CHARS,
          }),
        );
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function createWorkspaceTools(root: string): AgentTool[] {
  return [readTool(root), writeTool(root), editTool(root), bashTool(root)];
}

export const WORKSPACE_INSTRUCTIONS = `# Workspace
\`server_read\`, \`server_write\`, \`server_edit\`, and \`server_bash\` operate inside this user's private workspace for the current agent. File paths are relative to it, and \`server_bash\` starts there. File tools reject paths outside the workspace; bash is a working directory, not a filesystem sandbox.`;
