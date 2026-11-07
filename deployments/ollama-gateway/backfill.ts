import { loadOtelConfig } from "./src/config.ts";
import { replayLegacyUsage } from "./src/migrate.ts";
import { createTelemetry } from "./src/telemetry.ts";

// Usage:
//   bun run backfill                          resume from the cursor of <DB_PATH> (or newest .migrated)
//   bun run backfill -- --all                 replay every row again
//   bun run backfill -- --db path/to.db       explicit source
//   bun run backfill -- --preserve-timestamps stamp spans with original row times

const args = process.argv.slice(2);
const valueOf = (flag: string) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

const otel = loadOtelConfig();
if (!otel) {
  console.error("[backfill] OTEL_EXPORTER_OTLP_ENDPOINT is not set; nowhere to export to");
  process.exit(1);
}

const dbPath = valueOf("--db") ?? (process.env.DB_PATH?.trim() || "state/proxy-costs.db");
const full = args.includes("--all");
const telemetry = createTelemetry(otel);

const result = await replayLegacyUsage(dbPath, telemetry, {
  ignoreCursor: full,
  preserveTimestamps: args.includes("--preserve-timestamps"),
});

await telemetry.shutdown();

if (!result) {
  console.error(`[backfill] nothing replayed from ${dbPath}`);
  process.exit(1);
}
console.log(`[backfill] replayed ${result.replayed} rows from ${result.source} (${full ? "full" : "resumed"})`);
