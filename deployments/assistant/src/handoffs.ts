import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AssistantConfig } from "./config.ts";

export type HandoffStatus = "pending" | "read" | "consumed";

export interface HandoffInput {
  userHash: string;
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
  userHash: string;
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
  title: string;
  source_agent: string;
  target_agent: string;
  status: HandoffStatus;
  created_at: number;
  snippet: string;
}

const MAX_SUMMARY = 20_000;
const MAX_CONTEXT = 100_000;
const MAX_TRANSCRIPT = 100_000;

export function handoffFile(config: AssistantConfig): string {
  return join(config.dataDir, "handoffs.db");
}

/**
 * Cross-agent handoffs live in one database because source and target agents
 * have separate session databases. Rows are scoped by the short API-key hash
 * and target agent; agent ids are validated by the caller.
 */
export class HandoffStore {
  private readonly db: Database;

  constructor(readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS handoff (
        id TEXT PRIMARY KEY,
        user_hash TEXT NOT NULL,
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
      "CREATE INDEX IF NOT EXISTS idx_handoff_inbox ON handoff(user_hash, target_agent, status, created_at DESC)",
    );
  }

  create(input: HandoffInput): HandoffRecord {
    const id = `ho_${randomUUID().replaceAll("-", "")}`;
    const now = Date.now();
    const record: HandoffRecord = {
      id,
      userHash: input.userHash,
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
          id, user_hash, source_agent, target_agent, title, summary, context,
          transcript, source_response_id, status, created_at, read_at, consumed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.userHash,
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
      userHash: String(row.user_hash),
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

  get(id: string, userHash: string, targetAgent: string): HandoffRecord | null {
    const row = this.db
      .query("SELECT * FROM handoff WHERE id = ? AND user_hash = ? AND target_agent = ?")
      .get(id, userHash, targetAgent) as Record<string, unknown> | null;
    return row ? this.rowToRecord(row) : null;
  }

  list(
    userHash: string,
    targetAgent: string,
    status: HandoffStatus | "all" = "pending",
    limit = 20,
  ): HandoffListEntry[] {
    const capped = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows =
      status === "all"
        ? this.db
            .query(
              `SELECT id, title, source_agent, target_agent, status, created_at, summary
               FROM handoff WHERE user_hash = ? AND target_agent = ?
               ORDER BY created_at DESC LIMIT ?`,
            )
            .all(userHash, targetAgent, capped)
        : this.db
            .query(
              `SELECT id, title, source_agent, target_agent, status, created_at, summary
               FROM handoff WHERE user_hash = ? AND target_agent = ? AND status = ?
               ORDER BY created_at DESC LIMIT ?`,
            )
            .all(userHash, targetAgent, status, capped);
    return (rows as Record<string, unknown>[]).map((row) => ({
      id: String(row.id),
      title: String(row.title),
      source_agent: String(row.source_agent),
      target_agent: String(row.target_agent),
      status: String(row.status) as HandoffStatus,
      created_at: Number(row.created_at),
      snippet: String(row.summary).slice(0, 500),
    }));
  }

  countPending(userHash: string, targetAgent: string): number {
    const row = this.db
      .query("SELECT count(*) AS n FROM handoff WHERE user_hash = ? AND target_agent = ? AND status = 'pending'")
      .get(userHash, targetAgent) as { n: number } | null;
    return Number(row?.n ?? 0);
  }

  markRead(id: string, userHash: string, targetAgent: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE handoff SET status = 'read', read_at = ? WHERE id = ? AND user_hash = ? AND target_agent = ? AND status = 'pending'",
      )
      .run(Date.now(), id, userHash, targetAgent);
    return result.changes > 0;
  }

  consume(id: string, userHash: string, targetAgent: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE handoff SET status = 'consumed', consumed_at = ?
         WHERE id = ? AND user_hash = ? AND target_agent = ? AND status IN ('pending', 'read')`,
      )
      .run(Date.now(), id, userHash, targetAgent);
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
    `- from: ${record.sourceAgent}`,
    `- to: ${record.targetAgent}`,
    `- status: ${record.status}`,
    `- created_at: ${new Date(record.createdAt).toISOString()}`,
  ];
  if (record.sourceResponseId) lines.push(`- source_response_id: ${record.sourceResponseId}`);
  lines.push("", "## Summary", "", record.summary);
  if (record.context) lines.push("", "## Context", "", record.context);
  if (record.transcript) lines.push("", "## Transcript", "", record.transcript);
  return `${lines.join("\n")}\n`;
}
