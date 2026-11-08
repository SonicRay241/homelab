import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const ENTRY_DELIMITER = "\n§\n";
export const MEMORY_LIMITS = { memory: 2_200, user: 1_375 } as const;
export type MemoryTarget = keyof typeof MEMORY_LIMITS;
export type MemoryAction = "add" | "patch" | "remove";

const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/;
const MAX_CONTENT = 20_000;

export interface MemoryOperation {
  action: MemoryAction;
  content?: string;
  old_text?: string;
}

export interface MemoryUsage {
  chars: number;
  limit: number;
  percent: number;
  text: string;
}

export class MemoryError extends Error {
  readonly result: Record<string, unknown>;

  constructor(message: string, result: Record<string, unknown> = {}) {
    super(message);
    this.name = "MemoryError";
    this.result = result;
  }
}

/** Serializes writers per memory directory. Cheap: one process, one file pair per user. */
const locks = new Map<string, Promise<unknown>>();

function withLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(dir) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  locks.set(
    dir,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

function validateContent(content: string): string {
  const value = content.trim();
  if (!value) throw new MemoryError("Content is required and must not be empty.");
  if (value.length > MAX_CONTENT) throw new MemoryError(`Entry is too long (max ${MAX_CONTENT} chars).`);
  if (value.includes(ENTRY_DELIMITER)) {
    throw new MemoryError("Content must not contain the entry delimiter (a line with only §).");
  }
  if (INVISIBLE.test(value)) {
    throw new MemoryError("Content contains invisible or bidirectional Unicode characters.");
  }
  return value;
}

/**
 * Curated, bounded memory in the style of Hermes Agent: MEMORY.md (agent notes)
 * and USER.md (user profile), entries separated by a line containing only §.
 * Writes are atomic and serialized; limits are checked against the resulting
 * entries, never against individual operations, so a batch can free space and
 * add in one call.
 */
export class MemoryStore {
  constructor(readonly dir: string) {}

  file(target: MemoryTarget): string {
    return join(this.dir, target === "memory" ? "MEMORY.md" : "USER.md");
  }

  async load(target: MemoryTarget): Promise<string[]> {
    try {
      const raw = await readFile(this.file(target), "utf8");
      return raw
        .split(ENTRY_DELIMITER)
        .map((entry) => entry.trim())
        .filter(Boolean);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async snapshot(): Promise<Record<MemoryTarget, string[]>> {
    return { memory: await this.load("memory"), user: await this.load("user") };
  }

  usage(entries: string[], target: MemoryTarget): MemoryUsage {
    const limit = MEMORY_LIMITS[target];
    const chars = entries.join(ENTRY_DELIMITER).length;
    const percent = Math.round((chars / limit) * 100);
    return { chars, limit, percent, text: `${chars}/${limit} chars (${percent}%)` };
  }

  render(target: MemoryTarget, entries: string[]): string {
    const usage = this.usage(entries, target);
    const title = target === "memory" ? "MEMORY (your personal notes)" : "USER PROFILE";
    const rule = "═".repeat(46);
    return [
      rule,
      `${title} [${usage.percent}% — ${usage.chars.toLocaleString("en-US")}/${usage.limit.toLocaleString("en-US")} chars]`,
      rule,
      entries.length ? entries.join(ENTRY_DELIMITER) : "(empty)",
    ].join("\n");
  }

  private async save(target: MemoryTarget, entries: string[]): Promise<void> {
    const file = this.file(target);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    await writeFile(temp, entries.length ? entries.join(ENTRY_DELIMITER) : "", { encoding: "utf8", mode: 0o600 });
    await rename(temp, file);
  }

  private checkLimit(entries: string[], target: MemoryTarget, addition = 0): void {
    const limit = MEMORY_LIMITS[target];
    const chars = entries.join(ENTRY_DELIMITER).length;
    if (chars + addition <= limit) return;
    const over = chars + addition - limit;
    throw new MemoryError(
      `Memory at ${chars}/${limit} chars; this change would exceed the limit by ${over} chars. ` +
        `Retry with ONE batch that removes or shortens stale entries to free at least ${over} chars and applies this change.`,
      {
        usage: this.usage(entries, target).text,
        current_entries: entries,
        over_by: over,
      },
    );
  }

  private failure(target: MemoryTarget, entries: string[], message: string): MemoryError {
    return new MemoryError(message, {
      usage: this.usage(entries, target).text,
      current_entries: entries,
    });
  }

  private applyOperation(entries: string[], target: MemoryTarget, operation: MemoryOperation): string[] {
    const action = operation.action;
    const oldText = operation.old_text?.trim();
    const content = operation.content;

    if (action === "add") {
      const value = validateContent(content ?? "");
      if (entries.includes(value)) return entries;
      return [...entries, value];
    }

    if (!oldText) {
      throw this.failure(target, entries, `'${action}' needs old_text, a short unique substring of an entry.`);
    }

    if (action === "remove") {
      const exact = entries.indexOf(oldText);
      if (exact >= 0) return entries.filter((_, index) => index !== exact);
      const matches = entries.flatMap((entry, index) => (entry.includes(oldText) ? [index] : []));
      if (matches.length === 0) throw this.failure(target, entries, `No entry contains ${JSON.stringify(oldText)}.`);
      if (matches.length > 1) {
        throw this.failure(target, entries, `old_text matches ${matches.length} entries; use a more specific substring.`);
      }
      return entries.filter((_, index) => index !== matches[0]);
    }

    if (action === "patch") {
      const value = validateContent(content ?? "");
      const exact = entries.indexOf(oldText);
      if (exact >= 0) return entries.map((entry, index) => (index === exact ? value : entry));
      const matches = entries.flatMap((entry, index) => (entry.includes(oldText) ? [index] : []));
      if (matches.length === 0) throw this.failure(target, entries, `No entry contains ${JSON.stringify(oldText)}.`);
      if (matches.length > 1) {
        throw this.failure(target, entries, `old_text matches ${matches.length} entries; use a more specific substring.`);
      }
      const index = matches[0];
      if (index === undefined) throw this.failure(target, entries, `No entry contains ${JSON.stringify(oldText)}.`);
      const entry = entries[index] ?? "";
      const occurrences = entry.split(oldText).length - 1;
      if (occurrences > 1) {
        throw this.failure(target, entries, `old_text occurs ${occurrences} times in the matched entry; include more context.`);
      }
      return entries.map((current, i) => (i === index ? current.replace(oldText, value) : current));
    }

    throw this.failure(target, entries, `Unknown action ${JSON.stringify(action)}.`);
  }

  async add(target: MemoryTarget, content: string): Promise<Record<string, unknown>> {
    return this.mutate(target, (entries) => {
      const value = validateContent(content);
      if (entries.includes(value)) return { entries, message: "Duplicate entry; no change." };
      return { entries: [...entries, value], message: "Added." };
    });
  }

  async patch(target: MemoryTarget, oldText: string, content: string): Promise<Record<string, unknown>> {
    return this.mutate(target, (entries) => {
      const next = this.applyOperation(entries, target, { action: "patch", old_text: oldText, content });
      return { entries: next, message: "Patched." };
    });
  }

  async remove(target: MemoryTarget, oldText: string): Promise<Record<string, unknown>> {
    return this.mutate(target, (entries) => {
      const next = this.applyOperation(entries, target, { action: "remove", old_text: oldText });
      return { entries: next, message: "Removed." };
    });
  }

  async batch(target: MemoryTarget, operations: MemoryOperation[]): Promise<Record<string, unknown>> {
    if (!Array.isArray(operations) || operations.length === 0) {
      throw new MemoryError("A batch needs at least one operation.");
    }
    return this.mutate(target, (entries) => {
      let next = entries;
      for (const [index, operation] of operations.entries()) {
        try {
          next = this.applyOperation(next, target, operation);
        } catch (error) {
          if (error instanceof MemoryError) {
            throw new MemoryError(`Operation ${index + 1} failed: ${error.message}`, {
              ...error.result,
              current_entries: entries,
            });
          }
          throw error;
        }
      }
      return { entries: next, message: `Applied ${operations.length} operation(s).` };
    });
  }

  private async mutate(
    target: MemoryTarget,
    apply: (entries: string[]) => { entries: string[]; message: string },
  ): Promise<Record<string, unknown>> {
    return withLock(this.dir, async () => {
      const entries = await this.load(target);
      const result = apply(entries);
      this.checkLimit(result.entries, target);
      await this.save(target, result.entries);
      return {
        success: true,
        target,
        message: result.message,
        usage: this.usage(result.entries, target).text,
        entries: result.entries,
      };
    });
  }
}

export const MEMORY_INSTRUCTIONS = `# Memory
You have a \`server_memory\` tool backed by two small, persistent stores that are injected into your system prompt at the start of each conversation:
- target "memory": your own notes (environment facts, conventions, lessons, completed work). Limit 2200 chars.
- target "user": the user's profile (name, role, timezone, preferences, communication style). Limit 1375 chars.

Save durable facts proactively. Do not save trivia, one-off task state, or large dumps. Memory persists only when you call the tool — never claim you remembered something unless the tool call succeeded. Use action "add" for new entries, "patch" with old_text plus content for a unique span, "remove" with old_text, or one "batch" of operations (same target) to consolidate. When the store is near capacity the tool returns the current entries and the number of chars to free; consolidate in a single batch and retry.`;
