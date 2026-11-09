import type { AgentTool } from "@mariozechner/pi-agent-core";
import { StringEnum, Type, type Static, type TSchema } from "@mariozechner/pi-ai";
import { MemoryError, type MemoryStore, type MemoryTarget } from "./memory.ts";
import type { HandoffStore } from "./handoffs.ts";
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

const HandoffSendParams = Type.Object({
  target_agent: Type.String({ description: "Agent id that should receive this handoff" }),
  title: Type.String({ description: "Short title for the handoff" }),
  summary: Type.String({ description: "What the receiving agent needs to know, decide, or do" }),
  context: Type.Optional(Type.String({ description: "Findings, decisions, file paths, constraints, links" })),
  include_transcript: Type.Optional(
    Type.Boolean({ description: "Include recent source conversation as reference (default true)" }),
  ),
});

const HandoffInboxParams = Type.Object({
  status: Type.Optional(
    StringEnum(["pending", "read", "consumed", "all"] as const, { description: "Filter by status (default pending)" }),
  ),
  limit: Type.Optional(Type.Number({ description: "Maximum results (default 20, max 100)" })),
});

const HandoffReadParams = Type.Object({
  id: Type.String({ description: "Handoff id from the inbox" }),
  consume: Type.Optional(Type.Boolean({ description: "Mark consumed after reading (default true)" })),
});

type HandoffSendParams = Static<typeof HandoffSendParams>;
type HandoffInboxParams = Static<typeof HandoffInboxParams>;
type HandoffReadParams = Static<typeof HandoffReadParams>;

export function handoffSendTool(options: {
  store: HandoffStore;
  userHash: string;
  sourceAgent: string;
  validTargets: string[];
  sourceResponseId?: string | null;
  transcript: string;
}): AgentTool<typeof HandoffSendParams> {
  return {
    name: "handoff_send",
    label: "Handoff Send",
    description:
      `Hand context to another agent. Available targets: ${options.validTargets.join(", ") || "none"}. ` +
      "The recipient sees it through server_handoff_inbox/server_handoff_read. Handoffs are scoped to this user's API key.",
    parameters: HandoffSendParams,
    execute: async (_toolCallId, params) => {
      const target = params.target_agent.trim();
      const title = params.title.trim();
      const summary = params.summary.trim();
      if (!title || !summary) return result({ success: false, error: "title and summary are required" });
      if (target === options.sourceAgent) return result({ success: false, error: "cannot hand off to the same agent" });
      if (!options.validTargets.includes(target)) {
        return result({ success: false, error: `unknown target agent; available: ${options.validTargets.join(", ")}` });
      }
      const record = options.store.create({
        userHash: options.userHash,
        sourceAgent: options.sourceAgent,
        targetAgent: target,
        title,
        summary,
        context: params.context,
        transcript: params.include_transcript === false ? "" : options.transcript,
        sourceResponseId: options.sourceResponseId,
      });
      return result({
        success: true,
        handoff: {
          id: record.id,
          target_agent: record.targetAgent,
          title: record.title,
          status: record.status,
          created_at: record.createdAt,
        },
      });
    },
  };
}

export function handoffInboxTool(
  store: HandoffStore,
  userHash: string,
  targetAgent: string,
): AgentTool<typeof HandoffInboxParams> {
  return {
    name: "handoff_inbox",
    label: "Handoff Inbox",
    description:
      "List handoffs sent to this agent for the current user. Use server_handoff_read to load one; " +
      "reading consumes it by default.",
    parameters: HandoffInboxParams,
    execute: async (_toolCallId, params) => {
      const status = params.status ?? "pending";
      const handoffs = store.list(userHash, targetAgent, status, params.limit ?? 20);
      return result({ success: true, status, handoffs });
    },
  };
}

export function handoffReadTool(
  store: HandoffStore,
  userHash: string,
  targetAgent: string,
): AgentTool<typeof HandoffReadParams> {
  return {
    name: "handoff_read",
    label: "Handoff Read",
    description:
      "Read one handoff addressed to this agent, including summary, context, and optional source transcript. " +
      "Marks it read and, by default, consumed.",
    parameters: HandoffReadParams,
    execute: async (_toolCallId, params) => {
      const record = store.get(params.id, userHash, targetAgent);
      if (!record) return result({ success: false, error: `handoff not found: ${params.id}` });
      store.markRead(record.id, userHash, targetAgent);
      if (params.consume !== false) store.consume(record.id, userHash, targetAgent);
      return result({ success: true, handoff: record });
    },
  };
}

export function handoffInstructions(agentId: string, targets: string[], pending: number): string {
  const targetText = targets.length ? targets.join(", ") : "none";
  return `# Handoffs
You are agent \`${agentId}\`. Pending handoffs: ${pending}. Other agents: ${targetText}.
Use \`server_handoff_send\` to pass research or context to another agent; the recipient reads it with \`server_handoff_inbox\` and \`server_handoff_read\`. Handoffs are scoped to this user's API key and target agent.`;
}
