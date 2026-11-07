export type ParsedUsage = {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number | null;
};

const count = (value: unknown): number => (typeof value === "number" ? value : 0);
const cachedCount = (value: unknown): number | null => (typeof value === "number" ? value : null);

/** JSON objects from either a plain JSON body or an SSE/data-line stream. */
function jsonObjects(text: string): unknown[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      // fall through to line-by-line parsing
    }
  }

  const objects: unknown[] = [];
  for (const rawLine of trimmed.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("event:") || line.startsWith(":")) continue;
    const payload = line.startsWith("data:") ? line.slice(5).trim() : line;
    if (!payload || payload === "[DONE]") continue;
    try {
      objects.push(JSON.parse(payload));
    } catch {
      // partial line of a multi-line SSE event
    }
  }
  return objects;
}

function lastObject<T>(objects: unknown[], predicate: (value: Record<string, any>) => T | null): T | null {
  for (let i = objects.length - 1; i >= 0; i--) {
    const value = objects[i];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const match = predicate(value as Record<string, any>);
      if (match !== null) return match;
    }
  }
  return null;
}

function ollamaCounters(body: Record<string, any>): ParsedUsage {
  return {
    model: typeof body.model === "string" ? body.model : "unknown",
    input_tokens: count(body.prompt_eval_count),
    output_tokens: count(body.eval_count),
    cached_input_tokens: cachedCount(body.prompt_eval_cached_count),
  };
}

/**
 * Extract token usage from an Ollama/OpenAI response body (plain JSON or SSE).
 * Returns null when the body does not carry a final usage report.
 */
export function parseUsage(endpoint: string, text: string): ParsedUsage | null {
  const objects = jsonObjects(text);
  if (objects.length === 0) return null;

  switch (endpoint) {
    case "/api/generate":
    case "/api/chat": {
      // Only the final chunk (done=true) carries prompt/eval counts.
      const final = lastObject(objects, body => (body.done === true ? ollamaCounters(body) : null));
      return final;
    }

    case "/api/embed": {
      const body = objects[0];
      if (!body || typeof body !== "object" || Array.isArray(body)) return null;
      const embed = body as Record<string, any>;
      return {
        model: typeof embed.model === "string" ? embed.model : "unknown",
        input_tokens: count(embed.prompt_eval_count),
        output_tokens: 0,
        cached_input_tokens: null,
      };
    }

    case "/v1/systemone": {
      const body = objects[0];
      if (!body || typeof body !== "object" || Array.isArray(body)) return null;
      const systemone = body as Record<string, any>;
      const usage = systemone.usage && typeof systemone.usage === "object" ? systemone.usage : {};
      return {
        model: typeof systemone.model === "string" ? systemone.model : "unknown",
        input_tokens: count(usage.input_tokens),
        output_tokens: count(usage.output_tokens),
        cached_input_tokens: null,
      };
    }

    case "/v1/chat/completions": {
      // OpenAI-compatible streams put usage in a trailing chunk when include_usage is set.
      return lastObject(objects, body => {
        if (!body.usage || typeof body.usage !== "object") return null;
        const usage = body.usage as Record<string, any>;
        const details = usage.prompt_tokens_details;
        return {
          model: typeof body.model === "string" ? body.model : "unknown",
          input_tokens: count(usage.prompt_tokens),
          output_tokens: count(usage.completion_tokens),
          cached_input_tokens:
            details && typeof details === "object" ? cachedCount((details as Record<string, unknown>).cached_tokens) : null,
        };
      });
    }

    default:
      return null;
  }
}
