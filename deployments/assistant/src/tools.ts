import type { AgentTool } from "@mariozechner/pi-agent-core";
import { StringEnum, Type, type Static } from "@mariozechner/pi-ai";
import { MemoryError, type MemoryStore, type MemoryTarget } from "./memory.ts";

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
