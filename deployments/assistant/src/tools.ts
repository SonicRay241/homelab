import type { AgentTool } from "@mariozechner/pi-agent-core";
import { StringEnum, Type, type Static, type TSchema } from "@mariozechner/pi-ai";
import { MemoryError, type MemoryStore, type MemoryTarget } from "./memory.ts";
import type { HandoffScope, HandoffStore } from "./handoffs.ts";
import type { SessionStore } from "./sessions.ts";

/** Client tool names are rejected if they use either reserved prefix, so collisions cannot happen. */
export const SERVER_TOOL_PREFIX = "server_";
export const MCP_TOOL_PREFIX = "mcp__";

export function isServerToolName(name: string): boolean {
  return name.startsWith(SERVER_TOOL_PREFIX) || name.startsWith(MCP_TOOL_PREFIX);
}

/** Server tools are advertised to the model as `server_<name>`; client tools keep their names. */
export function namespaceServerTool<TParameters extends TSchema, TDetails>(
  tool: AgentTool<TParameters, TDetails>,
): AgentTool<TParameters, TDetails> {
  return { ...tool, name: `${SERVER_TOOL_PREFIX}${tool.name}` };
}

export const SERVER_TOOL_INSTRUCTIONS = `# Server tools
Tool names starting with \`${SERVER_TOOL_PREFIX}\` or \`${MCP_TOOL_PREFIX}\` are executed by this server. Client-provided tools keep their original names and are executed by the caller; both prefixes are reserved. \`server_session_search\` searches this user's persisted conversation history. \`${MCP_TOOL_PREFIX}<server>_<tool>\` tools come from this agent's configured MCP servers.`;

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
      "Search this user's persisted past conversations. Returns the best match with its surrounding " +
      "messages (`context`), plus other matches with response_id, timestamp, and a short snippet. " +
      "Use it when the user refers to something discussed earlier that is no longer in context.",
    parameters: SessionSearchParams,
    execute: async (_toolCallId, params) => {
      const results = store.search(userHash, params.query, params.limit ?? 5, params.response_id);
      const top = results[0];
      const context = top ? store.context(userHash, top.message_id) : [];
      return result({ success: true, query: params.query, results, context });
    },
  };
}

const HandoffSendParams = Type.Object({
  target_agent: Type.Optional(
    Type.String({ description: "Agent id that should receive this handoff (same user)" }),
  ),
  target_user: Type.Optional(
    Type.String({ description: "User id that should receive this handoff (same agent)" }),
  ),
  title: Type.String({ description: "Short title for the handoff" }),
  summary: Type.String({ description: "What the recipient needs to know, decide, or do" }),
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
  scope: HandoffScope;
  validAgents: string[];
  validUsers: string[];
  sourceResponseId?: string | null;
  transcript: string;
}): AgentTool<typeof HandoffSendParams> {
  const { scope } = options;
  return {
    name: "handoff_send",
    label: "Handoff Send",
    description:
      `Hand context to another agent (same user) or another user (same agent). ` +
      `Agent targets: ${options.validAgents.join(", ") || "none"}. ` +
      "Use server_handoff_inbox/server_handoff_read to receive. Handoffs are scoped to this user's id.",
    parameters: HandoffSendParams,
    execute: async (_toolCallId, params) => {
      const targetAgent = params.target_agent?.trim() ?? "";
      const targetUser = params.target_user?.trim() ?? "";
      const title = params.title.trim();
      const summary = params.summary.trim();
      if (!title || !summary) return result({ success: false, error: "title and summary are required" });
      if (Boolean(targetAgent) === Boolean(targetUser)) {
        return result({ success: false, error: "set exactly one of target_agent or target_user" });
      }

      const kind = targetAgent ? "agent" : "user";
      if (targetAgent) {
        if (targetAgent === scope.agent) return result({ success: false, error: "cannot hand off to the same agent" });
        if (!options.validAgents.includes(targetAgent)) {
          return result({
            success: false,
            error: `unknown target agent; available: ${options.validAgents.join(", ")}`,
          });
        }
      } else {
        if (targetUser === scope.userId) return result({ success: false, error: "cannot hand off to yourself" });
        if (!options.validUsers.includes(targetUser)) {
          return result({ success: false, error: "unknown target user" });
        }
      }

      const record = options.store.create({
        kind,
        sourceUserId: scope.userId,
        sourceUserHash: scope.userHash,
        targetUserId: targetAgent ? scope.userId : targetUser,
        targetUserHash: targetAgent ? scope.userHash : null,
        sourceAgent: scope.agent,
        targetAgent: targetAgent || scope.agent,
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
          kind: record.kind,
          target_user: record.targetUserId,
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
  scope: HandoffScope,
): AgentTool<typeof HandoffInboxParams> {
  return {
    name: "handoff_inbox",
    label: "Handoff Inbox",
    description:
      "List handoffs addressed to the current user and agent, from other agents or other users. " +
      "Use server_handoff_read to load one; reading consumes it by default.",
    parameters: HandoffInboxParams,
    execute: async (_toolCallId, params) => {
      const status = params.status ?? "pending";
      const handoffs = store.list(scope, status, params.limit ?? 20);
      return result({ success: true, status, handoffs });
    },
  };
}

export function handoffReadTool(
  store: HandoffStore,
  scope: HandoffScope,
): AgentTool<typeof HandoffReadParams> {
  return {
    name: "handoff_read",
    label: "Handoff Read",
    description:
      "Read one handoff addressed to the current user and agent, including summary, context, and " +
      "optional source transcript. Marks it read and, by default, consumed.",
    parameters: HandoffReadParams,
    execute: async (_toolCallId, params) => {
      const record = store.get(params.id, scope);
      if (!record) return result({ success: false, error: `handoff not found: ${params.id}` });
      store.markRead(record.id, scope);
      if (params.consume !== false) store.consume(record.id, scope);
      return result({ success: true, handoff: record });
    },
  };
}

export function handoffInstructions(agentId: string, targets: string[], pending: number): string {
  const targetText = targets.length ? targets.join(", ") : "none";
  return `# Handoffs
You are agent \`${agentId}\`. Pending handoffs: ${pending}. Other agents: ${targetText}.
Use \`server_handoff_send\` to pass research or context to another agent (same user) by setting \`target_agent\`, or to another user of this agent by setting \`target_user\`. The recipient reads it with \`server_handoff_inbox\` and \`server_handoff_read\`. Handoffs belong to the recipient's user id and agent.`;
}
