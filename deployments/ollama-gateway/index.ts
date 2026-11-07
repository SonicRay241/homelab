import { createInfisicalClient } from "./src/auth/infisical.ts";
import { TokenRegistry } from "./src/auth/tokens.ts";
import { loadConfig } from "./src/config.ts";
import { migrateLegacyUsage } from "./src/migrate.ts";
import { createServer } from "./src/server.ts";
import { createTelemetry } from "./src/telemetry.ts";

const config = loadConfig();
const telemetry = createTelemetry(config.otel);
const registry = new TokenRegistry(createInfisicalClient(config.infisical), config.refreshMs);

await migrateLegacyUsage(config.legacyDbPath, telemetry);
await registry.start();

const server = createServer({ config, registry, telemetry });
console.log(`[gateway] listening on :${server.port} -> ${config.ollamaUrl}`);
console.log(`[gateway] otel: ${config.otel ? `${config.otel.endpoint} (${config.otel.serviceName})` : "disabled"}`);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`[gateway] ${signal} received, flushing telemetry`);
  registry.stop();
  server.stop();
  await telemetry.shutdown();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
