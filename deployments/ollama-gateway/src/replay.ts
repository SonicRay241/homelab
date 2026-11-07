import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import type { Telemetry } from "./telemetry.ts";
import { uncachedInput } from "./usage.ts";

const FLUSH_EVERY = 500;
const REQUIRED_COLUMNS = ["timestamp", "model", "input_tokens", "output_tokens"];

/** Column order of the headerless `dump.csv` produced by the usage pipeline. */
const DEFAULT_COLUMNS = [
  "timestamp",
  "username",
  "model",
  "input_tokens",
  "output_tokens",
  "id",
  "cached_input_tokens",
];

const TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}[ T]/;

export type ReplayOptions = {
  /** Replay every row, ignoring the cursor. Produces duplicates if the backend already stored them. */
  ignoreCursor?: boolean;
  /** Stamp spans at export time instead of the row's original time. */
  ingestionTimestamps?: boolean;
};

export type ReplayResult = {
  source: string;
  replayed: number;
  skipped: number;
  total: number;
  lastRow: number;
};

/** RFC 4180: quoted fields, escaped quotes, CRLF and embedded newlines. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some(cell => cell.length > 0)) rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }

  row.push(field);
  if (row.some(cell => cell.length > 0)) rows.push(row);
  return rows;
}

const toCount = (value: string | undefined): number => {
  if (value === undefined) return 0;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : 0;
};

const toOptionalCount = (value: string | undefined): number | null => {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
};

type TimestampMode = "original" | "ingestion";

type Cursor = { lastRow: number; size: number; mode?: TimestampMode };

function readCursor(path: string): Cursor | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      lastRow?: unknown;
      size?: unknown;
      mode?: unknown;
    };
    if (typeof parsed.lastRow !== "number" || typeof parsed.size !== "number") return null;
    return {
      lastRow: parsed.lastRow,
      size: parsed.size,
      mode: parsed.mode === "ingestion" ? "ingestion" : parsed.mode === "original" ? "original" : undefined,
    };
  } catch {
    return null;
  }
}

function writeCursor(path: string, lastRow: number, size: number, mode: TimestampMode): void {
  const temp = `${path}.tmp`;
  writeFileSync(temp, JSON.stringify({ lastRow, size, mode, updatedAt: new Date().toISOString() }));
  renameSync(temp, path);
}

/**
 * Replays the usage CSV dump as OTLP spans and token counters. The file is never modified: progress
 * (`lastRow` + size + timestamp mode) lives in `<file>.replayed.json`, so a restart resumes where the
 * last flushed batch ended. If the file size changes the replay starts over.
 */
export async function replayUsageCsv(
  filePath: string,
  telemetry: Telemetry,
  options: ReplayOptions = {}
): Promise<ReplayResult | null> {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) return null;

  if (!telemetry.enabled) {
    console.warn(`[replay] ${filePath} left untouched: OTEL export is disabled`);
    return null;
  }

  const text = await Bun.file(filePath).text();
  const rows = parseCsv(text);
  if (rows.length === 0) {
    console.warn(`[replay] ${filePath} is empty`);
    return null;
  }

  const headerRow = rows[0]!;
  const headerless = TIMESTAMP_PREFIX.test((headerRow[0] ?? "").trim());
  const columns = headerless ? DEFAULT_COLUMNS : headerRow.map(cell => cell.trim().toLowerCase().replace(/^\uFEFF/, ""));
  const dataRows = headerless ? rows : rows.slice(1);

  if (!headerless) {
    const missing = REQUIRED_COLUMNS.filter(column => !columns.includes(column));
    if (missing.length > 0) {
      console.warn(`[replay] ${filePath} is missing columns: ${missing.join(", ")}`);
      return null;
    }
  }

  const index = new Map(columns.map((column, position) => [column, position]));
  const cell = (row: string[], column: string) => {
    const position = index.get(column);
    return position === undefined ? "" : (row[position] ?? "");
  };

  const cursorPath = `${filePath}.replayed.json`;
  const size = statSync(filePath).size;
  const mode: TimestampMode = options.ingestionTimestamps ? "ingestion" : "original";
  const cursor = readCursor(cursorPath);

  let startRow = 0;
  if (!options.ignoreCursor && cursor) {
    if (cursor.mode === mode && cursor.size === size) {
      startRow = Math.min(cursor.lastRow, dataRows.length);
    } else if (cursor.mode !== mode) {
      console.warn(`[replay] cursor timestamp mode ${cursor.mode ?? "legacy-ingestion"} != ${mode}, replaying from the first row`);
    } else {
      console.warn(`[replay] ${filePath} changed since the last replay, starting over`);
    }
  }

  let replayed = 0;
  let skipped = 0;
  let processed = startRow;

  const flush = async (lastRow: number) => {
    await telemetry.forceFlush();
    writeCursor(cursorPath, lastRow, size, mode);
  };

  for (let position = startRow; position < dataRows.length; position++) {
    const row = dataRows[position]!;
    processed = position + 1;

    const timestamp = cell(row, "timestamp").trim();
    if (!timestamp) {
      skipped++;
      continue;
    }

    const cached = toOptionalCount(cell(row, "cached_input_tokens"));
    const date = cell(row, "date").trim() || timestamp.slice(0, 10);
    const externalId = cell(row, "id").trim();
    const endpoint = cell(row, "endpoint").trim();
    const keyHash = cell(row, "key_hash").trim();
    const username = cell(row, "username").trim();

    telemetry.replay(
      {
        id: processed,
        timestamp,
        date,
        model: cell(row, "model").trim() || "unknown",
        // The dump stores cached tokens inside input_tokens; report the uncached remainder.
        input_tokens: uncachedInput(toCount(cell(row, "input_tokens")), cached),
        output_tokens: toCount(cell(row, "output_tokens")),
        cached_input_tokens: cached,
        ...(endpoint ? { endpoint } : {}),
        ...(keyHash ? { key_hash: keyHash } : {}),
        ...(username ? { username } : {}),
        ...(externalId ? { externalId } : {}),
      },
      { ingestionTimestamps: options.ingestionTimestamps }
    );
    replayed++;

    if (replayed % FLUSH_EVERY === 0) await flush(processed);
  }

  await flush(processed);

  console.log(
    `[replay] ${replayed} usage rows from ${filePath} (${dataRows.length} total${
      skipped > 0 ? `, ${skipped} skipped` : ""
    }, cursor ${cursorPath})`
  );
  return { source: filePath, replayed, skipped, total: dataRows.length, lastRow: processed };
}
