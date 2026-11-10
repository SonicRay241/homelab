import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ImageContent, Message, TextContent } from "@mariozechner/pi-ai";
import type { AssistantConfig } from "./config.ts";

const MAX_SEARCH_TEXT = 500_000;
const CONTEXT_TEXT_LIMIT = 1_000;
const REPLAY_CANDIDATES = 20;

export interface SessionRecord {
  responseId: string;
  /** Conversation this turn belongs to; inherited through the response chain or a replayed transcript. */
  conversationId: string;
  previousResponseId?: string | null;
  userHash: string;
  agentId: string;
  createdAt: number;
  systemPrompt: string;
  /** Full effective transcript up to and including this turn. */
  messages: Message[];
  response: Record<string, unknown>;
}

export interface SessionSave extends Omit<SessionRecord, "conversationId"> {
  /**
   * Chat clients replay the whole transcript on every request. When true, an existing
   * stored transcript that is a prefix of this one is reused and only the new suffix is
   * written, instead of copying the conversation again.
   */
  replay?: boolean;
}

export interface SessionSearchResult {
  response_id: string;
  conversation_id: string;
  created_at: number;
  /** chat_log row id; pass to `context` to fetch the surrounding messages. */
  message_id: number;
  snippet: string;
}

export interface SessionContextMessage {
  response_id: string;
  created_at: number;
  role: string;
  text: string;
}

export function sessionFile(config: AssistantConfig): string {
  return join(config.agentDir, "sessions.db");
}

function contentText(content: string | (TextContent | ImageContent)[]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? part.text : "[image]"))
    .join("\n");
}

/** Searchable projection of a transcript: text, tool names, and tool arguments. */
export function messagesToSearchText(messages: Message[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      parts.push(contentText(message.content));
      continue;
    }
    if (message.role === "toolResult") {
      parts.push(`${message.toolName}: ${contentText(message.content)}`);
      continue;
    }
    for (const part of message.content) {
      if (part.type === "text") parts.push(part.text);
      else if (part.type === "toolCall") parts.push(`${part.name}(${JSON.stringify(part.arguments)})`);
    }
  }
  return parts.filter(Boolean).join("\n").slice(0, MAX_SEARCH_TEXT);
}

function snippet(text: string, query: string): string {
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return text.slice(0, 240);
  const start = Math.max(0, index - 100);
  const end = Math.min(text.length, index + query.length + 140);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function truncate(value: string, limit = CONTEXT_TEXT_LIMIT): string {
  // Array.from avoids splitting a surrogate pair at the limit.
  const chars = Array.from(value);
  return chars.length > limit ? `${chars.slice(0, limit).join("")}…` : value;
}

function fingerprint(message: Message, visibleOnly: boolean): string | undefined {
  if (message.role === "user") return JSON.stringify(["user", message.content]);
  if (message.role === "toolResult") {
    if (visibleOnly && message.toolName.startsWith("server_")) return undefined;
    return JSON.stringify([
      "toolResult",
      message.toolCallId,
      message.toolName,
      message.content,
      message.isError,
    ]);
  }
  const parts = message.content.flatMap((part) => {
    if (part.type === "thinking") return [];
    if (visibleOnly && part.type === "toolCall" && part.name.startsWith("server_")) return [];
    if (part.type === "text") return [JSON.stringify(["text", part.text])];
    return [JSON.stringify(["toolCall", part.id, part.name, part.arguments])];
  });
  if (visibleOnly && !parts.length) return undefined;
  return JSON.stringify(["assistant", parts]);
}

function projections(messages: Message[], visibleOnly: boolean): string[] {
  const keys: string[] = [];
  for (const message of messages) {
    const key = fingerprint(message, visibleOnly);
    if (key !== undefined) keys.push(key);
  }
  return keys;
}

function isPrefix(prefix: string[], all: string[]): boolean {
  return prefix.length > 0 && prefix.length <= all.length && prefix.every((key, index) => key === all[index]);
}

/** Index just past the nth visible message; `record.messages` may interleave server-tool traffic. */
function indexAfterVisible(messages: Message[], count: number): number {
  let seen = 0;
  for (let index = 0; index < messages.length; index++) {
    if (fingerprint(messages[index]!, true) === undefined) continue;
    seen++;
    if (seen === count) return index + 1;
  }
  return messages.length;
}

/**
 * Append-only conversation storage.
 *
 * `session` holds one row per API turn (`response_id`) with its response payload and
 * the conversation it belongs to. `chat_log` holds the messages that turn added,
 * keyed by `session_id` (foreign key) with the turn timestamp. A turn stores only its
 * delta: Responses turns extend their parent chain, and replayed chat transcripts
 * reuse a stored prefix instead of copying the whole conversation.
 *
 * Search matches individual chat_log rows; `context` then fetches the matched row's
 * siblings with `ORDER BY created_at, id` window filters.
 */
export class SessionStore {
  private readonly db: Database;

  constructor(readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.db.run("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  private migrate(): void {
    const columns = this.db.query("PRAGMA table_info(session)").all() as { name: string }[];
    const legacy = columns.length > 0 && !columns.some((column) => column.name === "conversation_id");
    if (legacy) this.db.run("ALTER TABLE session RENAME TO session_legacy");
    this.createTables();
    if (legacy) this.migrateLegacy();
  }

  private createTables(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS session (
        response_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        previous_response_id TEXT,
        user_hash TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        system_prompt TEXT NOT NULL,
        response TEXT NOT NULL,
        checkpoint INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS chat_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES session(response_id),
        conversation_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        role TEXT NOT NULL,
        message TEXT NOT NULL,
        search_text TEXT NOT NULL
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_session_user_agent_created ON session(user_hash, agent_id, created_at DESC)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_session_conversation ON session(conversation_id, created_at)");
    this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_log_session_seq ON chat_log(session_id, seq)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_chat_log_conversation ON chat_log(conversation_id, created_at, id)");
  }

  /** One-time import of the old full-snapshot schema (`messages`/`search_text` blobs). */
  private migrateLegacy(): void {
    const rows = this.db.query("SELECT * FROM session_legacy ORDER BY created_at").all() as Record<
      string,
      unknown
    >[];
    const byId = new Map(rows.map((row) => [String(row.response_id), row]));
    const conversationOf = (responseId: string): string => {
      let current = responseId;
      const seen = new Set<string>();
      while (!seen.has(current)) {
        seen.add(current);
        const previous = byId.get(current)?.previous_response_id;
        if (previous === null || previous === undefined) break;
        current = String(previous);
      }
      return current;
    };

    this.db.transaction(() => {
      for (const row of rows) {
        const responseId = String(row.response_id);
        this.insertTurn(
          {
            responseId,
            conversationId: conversationOf(responseId),
            previousResponseId: row.previous_response_id === null ? null : String(row.previous_response_id),
            userHash: String(row.user_hash),
            agentId: String(row.agent_id),
            createdAt: Number(row.created_at),
            systemPrompt: String(row.system_prompt),
            response: JSON.parse(String(row.response)) as Record<string, unknown>,
            checkpoint: 1,
          },
          JSON.parse(String(row.messages)) as Message[],
        );
      }
      this.db.run("DROP TABLE session_legacy");
    })();
  }

  /** Inserts a turn and its message rows; replaces any previous rows for the same turn. */
  private insertTurn(
    record: Omit<SessionRecord, "messages"> & { checkpoint?: number },
    delta: Message[],
  ): void {
    this.db
      .prepare(
        `INSERT INTO session (
          response_id, conversation_id, previous_response_id, user_hash, agent_id,
          created_at, system_prompt, response, checkpoint
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(response_id) DO UPDATE SET
          conversation_id = excluded.conversation_id,
          previous_response_id = excluded.previous_response_id,
          user_hash = excluded.user_hash,
          agent_id = excluded.agent_id,
          created_at = excluded.created_at,
          system_prompt = excluded.system_prompt,
          response = excluded.response,
          checkpoint = excluded.checkpoint`,
      )
      .run(
        record.responseId,
        record.conversationId,
        record.previousResponseId ?? null,
        record.userHash,
        record.agentId,
        record.createdAt,
        record.systemPrompt,
        JSON.stringify(record.response),
        record.checkpoint ?? 0,
      );
    this.db.run("DELETE FROM chat_log WHERE session_id = ?", [record.responseId]);
    const insert = this.db.prepare(
      `INSERT INTO chat_log (session_id, conversation_id, seq, created_at, role, message, search_text)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    delta.forEach((message, index) => {
      insert.run(
        record.responseId,
        record.conversationId,
        index,
        record.createdAt,
        message.role,
        JSON.stringify(message),
        messagesToSearchText([message]),
      );
    });
  }

  private candidates(
    record: SessionSave,
  ): { conversationId: string; start: number; checkpoint?: number } | undefined {
    if (record.previousResponseId) {
      const parent = this.get(record.previousResponseId, record.userHash);
      if (parent) {
        const start = isPrefix(projections(parent.messages, false), projections(record.messages, false))
          ? parent.messages.length
          : 0;
        // Compaction rewrites the transcript; the full copy becomes a new checkpoint.
        return { conversationId: parent.conversationId, start, checkpoint: start === 0 ? 1 : 0 };
      }
    }
    if (!record.replay) return undefined;

    const rows = this.db
      .query(
        `SELECT response_id FROM session
         WHERE user_hash = ? AND agent_id = ? AND response_id <> ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(record.userHash, record.agentId, record.responseId, REPLAY_CANDIDATES) as {
      response_id: string;
    }[];
    const incoming = projections(record.messages, true);
    let best: { conversationId: string; start: number; length: number } | undefined;
    for (const row of rows) {
      const prior = this.get(row.response_id, record.userHash);
      if (!prior) continue;
      const prefix = projections(prior.messages, true);
      if (!isPrefix(prefix, incoming)) continue;
      if (best && prefix.length <= best.length) continue;
      best = {
        conversationId: prior.conversationId,
        start: indexAfterVisible(record.messages, prefix.length),
        length: prefix.length,
      };
    }
    return best;
  }

  save(record: SessionSave): void {
    const resume = this.candidates(record);
    const conversationId = resume?.conversationId ?? record.responseId;
    const delta = record.messages.slice(resume?.start ?? 0);
    this.db.transaction(() => {
      this.insertTurn({ ...record, conversationId, checkpoint: resume?.checkpoint ?? 0 }, delta);
    })();
  }

  private transcript(responseId: string, userHash: string): Message[] {
    const turn = this.db
      .query(
        "SELECT conversation_id, previous_response_id FROM session WHERE response_id = ? AND user_hash = ?",
      )
      .get(responseId, userHash) as
      | { conversation_id: string; previous_response_id: string | null }
      | null;
    if (!turn) return [];

    // Chat replays are linear: order the conversation's rows and stop at this turn's last row.
    if (!turn.previous_response_id) {
      const rows = this.db
        .query(
          `SELECT c.message AS message
           FROM chat_log c JOIN session s ON s.response_id = c.session_id
           WHERE s.conversation_id = ? AND s.user_hash = ?
             AND c.id <= (SELECT MAX(id) FROM chat_log WHERE session_id = ?)
           ORDER BY c.id ASC`,
        )
        .all(turn.conversation_id, userHash, responseId) as { message: string }[];
      return rows.map((row) => JSON.parse(row.message) as Message);
    }

    // Responses chains: walk parents and stop at the nearest checkpoint.
    const rows = this.db
      .query(
        `WITH RECURSIVE chain(response_id, previous_response_id, depth, checkpoint) AS (
           SELECT response_id, previous_response_id, 0, checkpoint
           FROM session WHERE response_id = ? AND user_hash = ?
           UNION ALL
           SELECT s.response_id, s.previous_response_id, chain.depth + 1, s.checkpoint
           FROM session s JOIN chain ON s.response_id = chain.previous_response_id
           WHERE s.user_hash = ? AND chain.checkpoint = 0
         )
         SELECT c.message AS message
         FROM chat_log c JOIN chain ON c.session_id = chain.response_id
         ORDER BY chain.depth DESC, c.seq ASC`,
      )
      .all(responseId, userHash, userHash) as { message: string }[];
    return rows.map((row) => JSON.parse(row.message) as Message);
  }

  get(responseId: string, userHash: string): SessionRecord | null {
    const row = this.db
      .query("SELECT * FROM session WHERE response_id = ? AND user_hash = ?")
      .get(responseId, userHash) as Record<string, unknown> | null;
    if (!row) return null;
    return {
      responseId: String(row.response_id),
      conversationId: String(row.conversation_id),
      previousResponseId: row.previous_response_id === null ? null : String(row.previous_response_id),
      userHash: String(row.user_hash),
      agentId: String(row.agent_id),
      createdAt: Number(row.created_at),
      systemPrompt: String(row.system_prompt),
      messages: this.transcript(responseId, userHash),
      response: JSON.parse(String(row.response)) as Record<string, unknown>,
    };
  }

  search(userHash: string, query: string, limit = 5, responseId?: string): SessionSearchResult[] {
    const needle = query.trim();
    if (!needle) return [];
    const capped = Math.max(1, Math.min(20, Math.floor(limit)));
    const rows = this.db
      .query(
        `SELECT s.response_id, s.conversation_id, s.created_at, c.id, c.search_text
         FROM chat_log c JOIN session s ON s.response_id = c.session_id
         WHERE s.user_hash = ?
           AND instr(lower(c.search_text), lower(?)) > 0
           AND (? IS NULL OR s.response_id = ?)
         ORDER BY s.created_at DESC, c.seq ASC
         LIMIT ?`,
      )
      .all(userHash, needle, responseId ?? null, responseId ?? null, capped) as {
      response_id: string;
      conversation_id: string;
      created_at: number;
      id: number;
      search_text: string;
    }[];
    return rows.map((row) => ({
      response_id: row.response_id,
      conversation_id: row.conversation_id,
      created_at: row.created_at,
      message_id: row.id,
      snippet: snippet(row.search_text, needle),
    }));
  }

  /** Messages surrounding one search hit, ordered by turn timestamp then insertion order. */
  context(userHash: string, messageId: number, before = 3, after = 3): SessionContextMessage[] {
    const hit = this.db
      .query(
        `SELECT c.id, c.session_id, c.conversation_id, c.created_at, c.role, c.search_text
         FROM chat_log c JOIN session s ON s.response_id = c.session_id
         WHERE c.id = ? AND s.user_hash = ?`,
      )
      .get(messageId, userHash) as Record<string, unknown> | null;
    if (!hit) return [];

    const conversationId = String(hit.conversation_id);
    const createdAt = Number(hit.created_at);
    const previous = this.db
      .query(
        `SELECT session_id, created_at, role, search_text FROM chat_log
         WHERE conversation_id = ?
           AND (created_at < ? OR (created_at = ? AND id < ?))
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(conversationId, createdAt, createdAt, Number(hit.id), Math.max(0, Math.floor(before))) as Record<
      string,
      unknown
    >[];
    const next = this.db
      .query(
        `SELECT session_id, created_at, role, search_text FROM chat_log
         WHERE conversation_id = ?
           AND (created_at > ? OR (created_at = ? AND id > ?))
         ORDER BY created_at ASC, id ASC LIMIT ?`,
      )
      .all(conversationId, createdAt, createdAt, Number(hit.id), Math.max(0, Math.floor(after))) as Record<
      string,
      unknown
    >[];

    const shape = (row: Record<string, unknown>): SessionContextMessage => ({
      response_id: String(row.session_id),
      created_at: Number(row.created_at),
      role: String(row.role),
      text: truncate(String(row.search_text)),
    });
    return [...previous.reverse().map(shape), shape(hit), ...next.map(shape)];
  }

  close(): void {
    this.db.close();
  }
}
