export type TraceMode = "no" | "text" | "openwebui";

/** Trace output is a preview, not a transcript: keep it short and redact nothing. */
export const TRACE_OUTPUT_LIMIT = 500;

export function parseTraceMode(value: string | null | undefined): TraceMode {
  const mode = (value ?? "").trim().toLowerCase();
  return mode === "text" || mode === "openwebui" ? mode : "no";
}

function truncate(value: string, limit = TRACE_OUTPUT_LIMIT): string {
  // Array.from avoids splitting a surrogate pair at the limit.
  const chars = Array.from(value);
  return chars.length > limit ? `${chars.slice(0, limit).join("")}…` : value;
}

function argsText(args: unknown): string {
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args) ?? String(args);
  } catch {
    return String(args);
  }
}

/** Extracts the text portions of an AgentToolResult (or falls back to JSON). */
export function toolResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && Array.isArray((result as { content?: unknown }).content)) {
    const text = (result as { content: unknown[] }).content
      .flatMap((part) => {
        if (!part || typeof part !== "object") return [];
        const record = part as Record<string, unknown>;
        return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
      })
      .join("\n");
    if (text) return text;
  }
  try {
    return JSON.stringify(result) ?? String(result);
  } catch {
    return String(result);
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fenceFor(text: string): string {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

export function formatTrace(options: {
  mode: TraceMode;
  toolCallId: string;
  toolName: string;
  args: unknown;
  result: unknown;
  isError: boolean;
}): string {
  if (options.mode === "no") return "";

  const call = `${options.toolName}(${truncate(argsText(options.args))})`;
  const output = truncate(toolResultText(options.result));
  const status = options.isError ? "error" : "output";

  if (options.mode === "text") {
    const body = `${call}\n${status}: ${output}`;
    const fence = fenceFor(body);
    return `${fence}text\n${body}\n${fence}`;
  }

  const body = options.isError ? `Error: ${output}` : output || "(no output)";
  return (
    `<details type="tool_calls" done="true"` +
    ` id="${escapeHtml(options.toolCallId)}"` +
    ` name="${escapeHtml(options.toolName)}"` +
    ` arguments="${escapeHtml(truncate(argsText(options.args)))}">\n` +
    `${escapeHtml(body)}\n</details>`
  );
}
