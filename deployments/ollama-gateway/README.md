# ollama-gateway

Bearer-token auth proxy in front of Ollama. Tokens are loaded from Infisical at startup and refreshed
periodically, so rotation needs no redeploy. Token usage and request traces are exported over OTLP.

```
client ──Bearer──> gateway ──> ollama:11434
                     │
                     ├── Infisical (token list, polled)
                     └── OTLP/HTTP collector (traces + metrics, incl. usage)
```

## Token source

Every secret in the configured Infisical folder is treated as one API token; the secret *value* is the
bearer token. Removed secrets stop authenticating on the next refresh (`TOKEN_REFRESH_MS`). If
Infisical is unreachable the last known good list stays in use; if no list has ever loaded, the
gateway answers `503` rather than running open.

## Environment

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `INFISICAL_BASE_URL` | yes | – | Infisical API base URL |
| `INFISICAL_CLIENT_ID` / `INFISICAL_CLIENT_SECRET` | yes | – | Universal Auth machine identity |
| `INFISICAL_PROJECT_ID` | yes | – | Project the folder belongs to |
| `INFISICAL_ENV` | yes | – | Environment slug (`prod`, `dev`, …) |
| `INFISICAL_SECRET_PATH` | no | `/` | Folder holding the token secrets |
| `TOKEN_REFRESH_MS` | no | `60000` | Token list poll interval |
| `OLLAMA_URL` | no | `http://ollama:11434` | Upstream Ollama |
| `PORT` | no | `8080` | Listen port |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no | – | OTLP/HTTP base URL; telemetry is off when unset |
| `OTEL_SERVICE_NAME` | no | `ollama-gateway` | `service.name` resource attribute |
| `OTEL_SDK_DISABLED` | no | – | `1`/`true` turns telemetry off explicitly |
| `DB_PATH` | no | `state/proxy-costs.db` | Legacy usage DB, replayed on startup |
| `LOGGING_DISABLED` | no | – | `1`/`true` disables usage capture and flag injection |

## Endpoints

Everything except the health of the gateway itself is an authenticated reverse proxy to Ollama:
`Authorization: Bearer <token>` is required and stripped before forwarding. `/usage` and
`/usage/export` are gone; usage lives in your observability backend.

For `/api/generate`, `/api/chat` and `/v1/chat/completions` the gateway injects the flags that make
Ollama report token counts (`stream: true`, `stream_options.include_usage`), then parses the final SSE
chunk. The response is streamed through untouched; parsing happens after the last chunk.

## Telemetry

- Span per request: `{method} {route}` with `http.*`, `proxy.key_hash`, `gen_ai.request.model`,
  `gen_ai.usage.input_tokens|output_tokens|cached_input_tokens`, `proxy.stream_aborted`.
- Metrics: `proxy.requests`, `proxy.request.duration` (ms), `proxy.tokens`
  (`gen_ai.token.type=input|output|cached`).
- Exported every 5s (spans) / 15s (metrics), flushed on `SIGTERM`.

## Legacy usage DB and backfill

The old SQLite cost log is replayed to OTLP on startup, before the server listens. The source file is
**never deleted or renamed**; progress is stored in `<source>.replayed.json` (`lastId`), so restarts
resume after the last flushed batch instead of duplicating rows. If `<DB_PATH>` is missing, the newest
`<DB_PATH>.migrated*` left by the old migrator is used.

Each row becomes one `usage.replay {endpoint}` span plus `proxy.tokens` counter additions:

- Spans are stamped at **replay time**, because backends reject or hide spans outside their
  ingestion/retention window. The original values stay on the span as `usage.timestamp`,
  `usage.date` and `usage.row_id`.
- Counters are cumulative and cannot be backdated, so they are attributed to replay time and tagged
  `proxy.replayed=true` to keep them separable from live traffic in dashboards.
- Spans are flushed every 500 rows and the cursor advances only after each flush.

If OTEL is not configured the file is left untouched and a warning is logged.

Manual backfill (safe to re-run; requires `OTEL_EXPORTER_OTLP_ENDPOINT`):

```sh
bun run backfill                          # resume from the cursor
bun run backfill -- --all                 # re-send every row (duplicates if already stored)
bun run backfill -- --db path/to.db       # explicit source
bun run backfill -- --all --preserve-timestamps   # keep original span times (self-hosted backends)
```

Inside the container: `docker compose run --rm proxy bun run /app/backfill.ts -- --all`.

## Development

```sh
bun install
bun run start      # Bun loads .env automatically
bun test           # fake Infisical + fake Ollama SSE + fake OTLP collector
bun run typecheck
```
