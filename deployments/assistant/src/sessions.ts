import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ImageContent, Message, TextContent } from "@mariozechner/pi-ai";
import type { AssistantConfig } from "./config.ts";

const MAX_SEARCH_TEXT = 500_000;

export interface SessionRecord {
  responseId: string;
  previousResponseId?: string | null;
  userHash: string;
  agentId: string;
  createdAt: number;
  systemPrompt: string;
  messages: Message[];
  response: Record<string, unknown>;
  searchText: string;
}

export interface SessionSearchResult {
  response_id: string;
  previous_response_id: string | null;
  created_at: number;
  snippet: string;
}

export function sessionFile(config: AssistantConfig): string {
  return join(config.dataDir, "agents", config.agentId, "sessions.db");
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

/**
 * Persistent Responses sessions, one SQLite file per agent.
 * Rows are filtered by short API-key hash for user isolation and by response id
 * to restore `previous_response_id` chains after a restart.
 */
export class SessionStore {
  private readonly db: Database;

  constructor(readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS session (
        response_id TEXT PRIMARY KEY,
        previous_response_id TEXT,
        user_hash TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        system_prompt TEXT NOT NULL,
        messages TEXT NOT NULL,
        response TEXT NOT NULL,
        search_text TEXT NOT NULL
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_session_user_response ON session(user_hash, response_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_session_user_created ON session(user_hash, created_at DESC)");
  }

  save(record: SessionRecord): void {
    this.db
      .prepare(
        `INSERT INTO session (
          response_id, previous_response_id, user_hash, agent_id, created_at,
          system_prompt, messages, response, search_text
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(response_id) DO UPDATE SET
          previous_response_id = excluded.previous_response_id,
          user_hash = excluded.user_hash,
          agent_id = excluded.agent_id,
          created_at = excluded.created_at,
          system_prompt = excluded.system_prompt,
          messages = excluded.messages,
          response = excluded.response,
          search_text = excluded.search_text`,
      )
      .run(
        record.responseId,
        record.previousResponseId ?? null,
        record.userHash,
        record.agentId,
        record.createdAt,
        record.systemPrompt,
        JSON.stringify(record.messages),
        JSON.stringify(record.response),
        record.searchText.slice(0, MAX_SEARCH_TEXT),
      );
  }

  get(responseId: string, userHash: string): SessionRecord | null {
    const row = this.db
      .query("SELECT * FROM session WHERE response_id = ? AND user_hash = ?")
      .get(responseId, userHash) as Record<string, unknown> | null;
    if (!row) return null;
    return {
      responseId: String(row.response_id),
      previousResponseId: row.previous_response_id === null ? null : String(row.previous_response_id),
      userHash: String(row.user_hash),
      agentId: String(row.agent_id),
      createdAt: Number(row.created_at),
      systemPrompt: String(row.system_prompt),
      messages: JSON.parse(String(row.messages)) as Message[],
      response: JSON.parse(String(row.response)) as Record<string, unknown>,
      searchText: String(row.search_text),
    };
  }

  search(userHash: string, query: string, limit = 5, responseId?: string): SessionSearchResult[] {
    const needle = query.trim();
    if (!needle) return [];
    const capped = Math.max(1, Math.min(20, Math.floor(limit)));
    const rows = this.db
      .query(
        `SELECT response_id, previous_response_id, created_at, search_text
         FROM session
         WHERE user_hash = ?
           AND instr(lower(search_text), lower(?)) > 0
           AND (? IS NULL OR response_id = ?)
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(userHash, needle, responseId ?? null, responseId ?? null, capped) as {
        response_id: string;
        previous_response_id: string | null;
        created_at: number;
        search_text: string;
      }[];
    return rows.map((row) => ({
      response_id: row.response_id,
      previous_response_id: row.previous_response_id,
      created_at: row.created_at,
      snippet: snippet(row.search_text, needle),
    }));
  }

  close(): void {
    this.db.close();
  }
}
