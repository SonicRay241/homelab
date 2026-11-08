import type { AgentTool } from "@mariozechner/pi-agent-core";
import { StringEnum, Type, type Static, type TSchema } from "@mariozechner/pi-ai";
import { MemoryError, type MemoryStore, type MemoryTarget } from "./memory.ts";
import type { SessionStore } from "./sessions.ts";

/** Client tool names are rejected if they use this prefix, so collisions cannot happen. */
export const SERVER_TOOL_PREFIX = "server_";

export function isServerToolName(name: string): boolean {
  return name.startsWith(SERVER_TOOL_PREFIX);
}

/** Server tools are advertised to the model as `server_<name>`; client tools keep their names. */
export function namespaceServerTool<TParameters extends TSchema, TDetails>(
  tool: AgentTool<TParameters, TDetails>,
): AgentTool<TParameters, TDetails> {
  return { ...tool, name: `${SERVER_TOOL_PREFIX}${tool.name}` };
}

export const SERVER_TOOL_INSTRUCTIONS = `# Server tools
Tool names starting with \`${SERVER_TOOL_PREFIX}\` are executed by this server. Client-provided tools keep their original names and are executed by the caller; the \`${SERVER_TOOL_PREFIX}\` prefix is reserved for server tools. \`server_session_search\` searches this user's persisted conversation history.`;

const OperationSchema = Type.Object({
  action: StringEnum(["add", "patch", "remove"] as const, {
    description: "add a new entry, patch a span inside one entry, or remove one entry",
  }),
  content: Type.Optional(Type.String({ description: "Entry text for add, or replacement text for patch" })),
  old_text: Type.Optional(
    Type.String({ description: "Short unique substring of the entry to patch/remove (or the whole entry)" }),
  ),
});

const MemoryParams = Type.Object({
  target: StringEnum(["memory", "user"] as const, {
    description: "memory = agent notes; user = user profile",
  }),
  action: StringEnum(["add", "patch", "remove", "batch"] as const, {
    description: "Single action, or batch to apply several operations to the same target atomically",
  }),
  content: Type.Optional(Type.String({ description: "Entry text for add, or replacement text for patch" })),
  old_text: Type.Optional(
    Type.String({ description: "Short unique substring of the entry to patch/remove (or the whole entry)" }),
  ),
  operations: Type.Optional(Type.Array(OperationSchema, { description: "Operations for action=batch" })),
});

type MemoryParams = Static<typeof MemoryParams>;

function result(value: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} };
}

export function memoryTool(store: MemoryStore): AgentTool<typeof MemoryParams> {
  return {
    name: "memory",
    label: "Memory",
    description:
      "Persist durable facts across conversations. target=memory is your own notes; target=user is the user profile. " +
      "Actions: add, patch (old_text + content), remove (old_text), or batch. Limits: memory 2200 chars, user 1375 chars. " +
      "Memory injected into the system prompt is a frozen snapshot; tool results always show the live state.",
    parameters: MemoryParams,
    execute: async (_toolCallId, params) => {
      const target = params.target as MemoryTarget;
      try {
        switch (params.action) {
          case "add":
            return result(await store.add(target, params.content ?? ""));
          case "patch":
            return result(await store.patch(target, params.old_text ?? "", params.content ?? ""));
          case "remove":
            return result(await store.remove(target, params.old_text ?? ""));
          case "batch":
            return result(await store.batch(target, params.operations ?? []));
        }
      } catch (error) {
        if (error instanceof MemoryError) {
          return result({ success: false, error: error.message, ...error.result });
        }
        throw error;
      }
    },
  };
}

const SessionSearchParams = Type.Object({
  query: Type.String({ description: "Case-insensitive text to find in past conversations" }),
  response_id: Type.Optional(Type.String({ description: "Restrict the search to one response id" })),
  limit: Type.Optional(Type.Number({ description: "Maximum results (default 5, max 20)" })),
});

type SessionSearchParams = Static<typeof SessionSearchParams>;

export function sessionSearchTool(store: SessionStore, userHash: string): AgentTool<typeof SessionSearchParams> {
  return {
    name: "session_search",
    label: "Session Search",
    description:
      "Search this user's persisted past conversations. Returns response_id, timestamp, and a short snippet. " +
      "Use it when the user refers to something discussed earlier that is no longer in context.",
    parameters: SessionSearchParams,
    execute: async (_toolCallId, params) => {
      const results = store.search(userHash, params.query, params.limit ?? 5, params.response_id);
      return result({ success: true, query: params.query, results });
    },
  };
}
