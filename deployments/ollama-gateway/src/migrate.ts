import { Database } from "bun:sqlite";
import { existsSync, renameSync } from "fs";
import type { Telemetry } from "./telemetry.ts";

const FLUSH_EVERY = 500;

type LegacyRow = {
  timestamp: string;
  date: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  endpoint: string;
  key_hash: string;
  cached_input_tokens: number | null;
};

/**
 * One-time migration: replay the legacy SQLite usage log as OTLP spans, then move the file aside.
 * Runs before the server boots and never aborts startup; a failed migration leaves the file for the
 * next boot so no usage is lost.
 */
export async function migrateLegacyUsage(dbPath: string, telemetry: Telemetry): Promise<void> {
  if (!existsSync(dbPath)) return;

  if (!telemetry.enabled) {
    console.warn(`[migrate] legacy usage DB ${dbPath} left untouched: OTEL export is disabled`);
    return;
  }

  const db = new Database(dbPath, { readonly: true });
  let replayed = 0;
  let closed = false;
  const closeDb = () => {
    if (closed) return;
    closed = true;
    try {
      db.close();
    } catch {}
  };

  try {
    if (!db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage_logs'").get()) {
      console.warn(`[migrate] ${dbPath} has no usage_logs table, skipping`);
      return;
    }

    const columns = new Set(
      (db.query("PRAGMA table_info(usage_logs)").all() as { name: string }[]).map(column => column.name)
    );
    const cached = columns.has("cached_input_tokens") ? "cached_input_tokens" : "NULL AS cached_input_tokens";
    const rows = db
      .query<LegacyRow, []>(
        `SELECT timestamp, date, model, input_tokens, output_tokens, total_tokens, endpoint, key_hash, ${cached} FROM usage_logs ORDER BY id`
      )
      .iterate();

    for (const row of rows) {
      telemetry.replay(row);
      replayed++;
      if (replayed % FLUSH_EVERY === 0) await telemetry.forceFlush();
    }
    await telemetry.forceFlush();

    // Close before renaming so WAL sidecars are checkpointed.
    closeDb();

    let target = `${dbPath}.migrated`;
    if (existsSync(target)) target = `${dbPath}.migrated-${Date.now()}`;
    renameSync(dbPath, target);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(`${dbPath}${suffix}`)) renameSync(`${dbPath}${suffix}`, `${target}${suffix}`);
    }

    console.log(`[migrate] replayed ${replayed} usage rows from ${dbPath} -> ${target}`);
  } catch (err) {
    console.error(`[migrate] failed to replay ${dbPath}, keeping it for the next boot: ${String(err)}`);
  } finally {
    closeDb();
  }
}
