import { loadOtelConfig } from "./src/config.ts";
import { replayUsageCsv } from "./src/replay.ts";
import { createTelemetry } from "./src/telemetry.ts";

// Usage:
//   bun run backfill -- --file dump.csv    resume from the cursor (default: $USAGE_CSV_PATH or dump.csv)
//   bun run backfill -- --file dump.csv --all                 replay every row again
//   bun run backfill -- --file dump.csv --ingestion-timestamps stamp spans at export time

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

const filePath = valueOf("--file") ?? (process.env.USAGE_CSV_PATH?.trim() || "dump.csv");
const full = args.includes("--all");
const telemetry = createTelemetry(otel);

const result = await replayUsageCsv(filePath, telemetry, {
  ignoreCursor: full,
  ingestionTimestamps: args.includes("--ingestion-timestamps"),
});

await telemetry.shutdown();

if (!result) {
  console.error(`[backfill] nothing replayed from ${filePath}`);
  process.exit(1);
}
console.log(
  `[backfill] replayed ${result.replayed} of ${result.total} rows from ${result.source} (${full ? "full" : "resumed"})`
);
