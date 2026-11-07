import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import type { Telemetry } from "./telemetry.ts";

const FLUSH_EVERY = 500;

type LegacyRow = {
  id: number;
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

export type ReplayOptions = {
  /** Replay every row, ignoring the cursor. Produces duplicates if the backend already stored them. */
  ignoreCursor?: boolean;
  /** Stamp spans with the row's original time instead of replay time. */
  preserveTimestamps?: boolean;
};

export type ReplayResult = {
  source: string;
  replayed: number;
  lastId: number;
};

const isFile = (path: string) => existsSync(path) && statSync(path).isFile();

/** Prefer the configured DB; fall back to the newest `<DB_PATH>.migrated*` left by the old migrator. */
function findSource(dbPath: string): string | null {
  if (isFile(dbPath)) return dbPath;

  const dir = dirname(dbPath);
  if (!existsSync(dir)) return null;

  const prefix = `${basename(dbPath)}.migrated`;
  // Only the old migrator's outputs: `<name>.migrated` and `<name>.migrated-<epoch>`.
  // Must not match the `.replayed.json` cursor or SQLite `-wal`/`-shm` sidecars.
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const candidates = readdirSync(dir)
    .filter(name => new RegExp(`^${escaped}(-\\d+)?$`).test(name))
    .map(name => join(dir, name))
    .filter(isFile);

  // Newest first; old runs produced `name.migrated-<epoch>` variants.
  return candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
}

function readCursor(path: string): number {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { lastId?: unknown };
    return typeof parsed.lastId === "number" ? parsed.lastId : 0;
  } catch {
    return 0;
  }
}

function writeCursor(path: string, lastId: number): void {
  const temp = `${path}.tmp`;
  writeFileSync(temp, JSON.stringify({ lastId, updatedAt: new Date().toISOString() }));
  renameSync(temp, path);
}

/**
 * Replays legacy SQLite usage rows as OTLP spans and token counters. The source file is never
 * modified: progress lives in `<source>.replayed.json`, so a restart resumes where the last flushed
 * batch ended. Runs before the server boots and never aborts startup.
 */
export async function replayLegacyUsage(
  dbPath: string,
  telemetry: Telemetry,
  options: ReplayOptions = {}
): Promise<ReplayResult | null> {
  const source = findSource(dbPath);
  if (!source) return null;

  if (!telemetry.enabled) {
    console.warn(`[replay] ${source} left untouched: OTEL export is disabled`);
    return null;
  }

  const cursorPath = `${source}.replayed.json`;
  let lastId = options.ignoreCursor ? 0 : readCursor(cursorPath);
  let replayed = 0;

  const db = new Database(source, { readonly: true });
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
      console.warn(`[replay] ${source} has no usage_logs table, skipping`);
      return null;
    }

    const columns = new Set(
      (db.query("PRAGMA table_info(usage_logs)").all() as { name: string }[]).map(column => column.name)
    );
    const cached = columns.has("cached_input_tokens") ? "cached_input_tokens" : "NULL AS cached_input_tokens";
    const rows = db
      .query<LegacyRow, [number]>(
        `SELECT id, timestamp, date, model, input_tokens, output_tokens, total_tokens, endpoint, key_hash, ${cached}
         FROM usage_logs WHERE id > ? ORDER BY id`
      )
      .iterate(lastId);

    let pending = 0;
    for (const row of rows) {
      telemetry.replay(row, { preserveTimestamps: options.preserveTimestamps });
      lastId = row.id;
      replayed++;
      if (++pending === FLUSH_EVERY) {
        await telemetry.forceFlush();
        writeCursor(cursorPath, lastId);
        pending = 0;
      }
    }

    await telemetry.forceFlush();
    writeCursor(cursorPath, lastId);

    console.log(`[replay] ${replayed} usage rows from ${source} (cursor ${cursorPath})`);
    return { source, replayed, lastId };
  } catch (err) {
    console.error(`[replay] failed on ${source}, cursor kept at ${lastId}: ${String(err)}`);
    return null;
  } finally {
    closeDb();
  }
}
