import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AssistantConfig } from "./config.ts";

export type HandoffStatus = "pending" | "read" | "consumed";
/** `agent`: another agent for the same user. `user`: another user of the same agent. */
export type HandoffKind = "agent" | "user";

/** Inbox identity: a user may have several API keys, so rows are scoped by user id. */
export interface HandoffScope {
  userId: string;
  userHash: string;
  agent: string;
}

export interface HandoffInput {
  kind: HandoffKind;
  sourceUserId: string;
  sourceUserHash: string;
  targetUserId: string;
  /** Null for user-to-user rows: the recipient may present any of their keys. */
  targetUserHash: string | null;
  sourceAgent: string;
  targetAgent: string;
  title: string;
  summary: string;
  context?: string;
  transcript?: string;
  sourceResponseId?: string | null;
}

export interface HandoffRecord {
  id: string;
  kind: HandoffKind;
  sourceUserId: string | null;
  sourceUserHash: string;
  targetUserId: string | null;
  targetUserHash: string | null;
  sourceAgent: string;
  targetAgent: string;
  title: string;
  summary: string;
  context: string;
  transcript: string;
  sourceResponseId: string | null;
  status: HandoffStatus;
  createdAt: number;
  readAt: number | null;
  consumedAt: number | null;
}

export interface HandoffListEntry {
  id: string;
  kind: HandoffKind;
  title: string;
  source_agent: string;
  source_user: string | null;
  target_agent: string;
  status: HandoffStatus;
  created_at: number;
  snippet: string;
}

const MAX_SUMMARY = 20_000;
const MAX_CONTEXT = 100_000;
const MAX_TRANSCRIPT = 100_000;

/**
 * Recipient predicate. Rows created before user ids were stored only have a key
 * hash, so they fall back to the current key's hash.
 */
const TARGET_SCOPE = "(target_user_id = ? OR (target_user_id IS NULL AND target_user_hash = ?))";

export function handoffFile(config: AssistantConfig): string {
  return join(config.basedir, "handoffs.db");
}

/**
 * Cross-agent and cross-user handoffs live in one database because source and
 * target agents have separate session databases.
 *
 * Agent-to-agent rows target the same user id and hash on another agent.
 * User-to-user rows target another user id on the same agent. The inbox query
 * uses the user id, so any of that user's API keys can read the handoff.
 */
export class HandoffStore {
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
    const columns = this.db.query("PRAGMA table_info(handoff)").all() as { name: string }[];
    const legacy = columns.length > 0 && !columns.some((column) => column.name === "kind");
    if (legacy) {
      this.db.run("ALTER TABLE handoff RENAME TO handoff_legacy");
      this.db.run("DROP INDEX IF EXISTS idx_handoff_inbox");
    }
    this.createTables();
    if (legacy) this.migrateLegacy();
  }

  private createTables(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS handoff (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        source_user_id TEXT,
        source_user_hash TEXT NOT NULL,
        target_user_id TEXT,
        target_user_hash TEXT,
        source_agent TEXT NOT NULL,
        target_agent TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        context TEXT NOT NULL,
        transcript TEXT NOT NULL,
        source_response_id TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        read_at INTEGER,
        consumed_at INTEGER
      )
    `);
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_handoff_inbox ON handoff(target_user_id, target_agent, status, created_at DESC)",
    );
  }

  /** Old rows were agent-to-agent for one user hash; user ids were not stored. */
  private migrateLegacy(): void {
    this.db.transaction(() => {
      this.db.run(`
        INSERT INTO handoff (
          id, kind, source_user_id, source_user_hash, target_user_id, target_user_hash,
          source_agent, target_agent, title, summary, context, transcript,
          source_response_id, status, created_at, read_at, consumed_at
        )
        SELECT id, 'agent', NULL, user_hash, NULL, user_hash,
               source_agent, target_agent, title, summary, context, transcript,
               source_response_id, status, created_at, read_at, consumed_at
        FROM handoff_legacy
      `);
      this.db.run("DROP TABLE handoff_legacy");
    })();
  }

  create(input: HandoffInput): HandoffRecord {
    const id = `ho_${randomUUID().replaceAll("-", "")}`;
    const now = Date.now();
    const record: HandoffRecord = {
      id,
      kind: input.kind,
      sourceUserId: input.sourceUserId,
      sourceUserHash: input.sourceUserHash,
      targetUserId: input.targetUserId,
      targetUserHash: input.targetUserHash,
      sourceAgent: input.sourceAgent,
      targetAgent: input.targetAgent,
      title: input.title.trim(),
      summary: input.summary.trim().slice(0, MAX_SUMMARY),
      context: (input.context ?? "").trim().slice(0, MAX_CONTEXT),
      transcript: (input.transcript ?? "").trim().slice(0, MAX_TRANSCRIPT),
      sourceResponseId: input.sourceResponseId ?? null,
      status: "pending",
      createdAt: now,
      readAt: null,
      consumedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO handoff (
          id, kind, source_user_id, source_user_hash, target_user_id, target_user_hash,
          source_agent, target_agent, title, summary, context, transcript,
          source_response_id, status, created_at, read_at, consumed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.kind,
        record.sourceUserId,
        record.sourceUserHash,
        record.targetUserId,
        record.targetUserHash,
        record.sourceAgent,
        record.targetAgent,
        record.title,
        record.summary,
        record.context,
        record.transcript,
        record.sourceResponseId,
        record.status,
        record.createdAt,
        null,
        null,
      );
    return record;
  }

  private rowToRecord(row: Record<string, unknown>): HandoffRecord {
    return {
      id: String(row.id),
      kind: String(row.kind) as HandoffKind,
      sourceUserId: row.source_user_id === null ? null : String(row.source_user_id),
      sourceUserHash: String(row.source_user_hash),
      targetUserId: row.target_user_id === null ? null : String(row.target_user_id),
      targetUserHash: row.target_user_hash === null ? null : String(row.target_user_hash),
      sourceAgent: String(row.source_agent),
      targetAgent: String(row.target_agent),
      title: String(row.title),
      summary: String(row.summary),
      context: String(row.context),
      transcript: String(row.transcript),
      sourceResponseId: row.source_response_id === null ? null : String(row.source_response_id),
      status: String(row.status) as HandoffStatus,
      createdAt: Number(row.created_at),
      readAt: row.read_at === null ? null : Number(row.read_at),
      consumedAt: row.consumed_at === null ? null : Number(row.consumed_at),
    };
  }

  get(id: string, scope: HandoffScope): HandoffRecord | null {
    const row = this.db
      .query(
        `SELECT * FROM handoff
         WHERE id = ? AND target_agent = ? AND ${TARGET_SCOPE}`,
      )
      .get(id, scope.agent, scope.userId, scope.userHash) as Record<string, unknown> | null;
    return row ? this.rowToRecord(row) : null;
  }

  list(
    scope: HandoffScope,
    status: HandoffStatus | "all" = "pending",
    limit = 20,
  ): HandoffListEntry[] {
    const capped = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows =
      status === "all"
        ? this.db
            .query(
              `SELECT id, kind, title, source_agent, source_user_id, target_agent, status, created_at, summary
               FROM handoff
               WHERE target_agent = ? AND ${TARGET_SCOPE}
               ORDER BY created_at DESC LIMIT ?`,
            )
            .all(scope.agent, scope.userId, scope.userHash, capped)
        : this.db
            .query(
              `SELECT id, kind, title, source_agent, source_user_id, target_agent, status, created_at, summary
               FROM handoff
               WHERE target_agent = ? AND ${TARGET_SCOPE} AND status = ?
               ORDER BY created_at DESC LIMIT ?`,
            )
            .all(scope.agent, scope.userId, scope.userHash, status, capped);
    return (rows as Record<string, unknown>[]).map((row) => ({
      id: String(row.id),
      kind: String(row.kind) as HandoffKind,
      title: String(row.title),
      source_agent: String(row.source_agent),
      source_user: row.source_user_id === null ? null : String(row.source_user_id),
      target_agent: String(row.target_agent),
      status: String(row.status) as HandoffStatus,
      created_at: Number(row.created_at),
      snippet: String(row.summary).slice(0, 500),
    }));
  }

  countPending(scope: HandoffScope): number {
    const row = this.db
      .query(
        `SELECT count(*) AS n FROM handoff
         WHERE target_agent = ? AND ${TARGET_SCOPE} AND status = 'pending'`,
      )
      .get(scope.agent, scope.userId, scope.userHash) as { n: number } | null;
    return Number(row?.n ?? 0);
  }

  markRead(id: string, scope: HandoffScope): boolean {
    const result = this.db
      .prepare(
        `UPDATE handoff SET status = 'read', read_at = ?
         WHERE id = ? AND target_agent = ? AND ${TARGET_SCOPE} AND status = 'pending'`,
      )
      .run(Date.now(), id, scope.agent, scope.userId, scope.userHash);
    return result.changes > 0;
  }

  consume(id: string, scope: HandoffScope): boolean {
    const result = this.db
      .prepare(
        `UPDATE handoff SET status = 'consumed', consumed_at = ?
         WHERE id = ? AND target_agent = ? AND ${TARGET_SCOPE} AND status IN ('pending', 'read')`,
      )
      .run(Date.now(), id, scope.agent, scope.userId, scope.userHash);
    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}

export function renderHandoffMarkdown(record: HandoffRecord): string {
  const lines = [
    `# Handoff: ${record.title}`,
    "",
    `- id: ${record.id}`,
    `- kind: ${record.kind}`,
    `- from: ${record.sourceAgent} (${record.sourceUserId ?? "unknown user"})`,
    `- to: ${record.targetAgent} (${record.targetUserId ?? "unknown user"})`,
    `- status: ${record.status}`,
    `- created_at: ${new Date(record.createdAt).toISOString()}`,
  ];
  if (record.sourceResponseId) lines.push(`- source_response_id: ${record.sourceResponseId}`);
  lines.push("", "## Summary", "", record.summary);
  if (record.context) lines.push("", "## Context", "", record.context);
  if (record.transcript) lines.push("", "## Transcript", "", record.transcript);
  return `${lines.join("\n")}\n`;
}
