# assistant

OpenAI-compatible **Responses API** on top of a [pi](https://github.com/badlogic/pi-mono) agent
(`@mariozechner/pi-agent-core`) served by Bun. One process, multiple users, per-user memory.

```
client ──Bearer sk-...──> assistant :8787
                           │  pi Agent (tools, loop)
                           ├─ Infisical (client keys: name = user id, value = key)
                           ├─ memory (MEMORY.md / USER.md per user)
                           └─ OpenAI-compatible backend (BASE_API_URL / MODEL)
```

## What it does

- `POST /v1/responses` with `stream: true|false`.
- **Server-side tools**: the pi agent executes tools inline and keeps looping until it answers.
  The built-in server tool is `memory`; server tools are always available.
- **Client-side tools**: function tools in the request are returned as `function_call` output items
  (`call_id`, `name`, `arguments`). The caller executes them and sends
  `function_call_output` items on the next request. A batch containing a client tool stops the
  server loop immediately; server tool calls in the same batch still execute and stay in the stored
  transcript, but are not exposed as output items.
- `previous_response_id` replays the stored pi transcript (per user). Responses are kept in memory:
  TTL 7 days, max 500, lost on restart.
- Hermes-style persistent memory per user, with `MEMORY.md` (agent notes, 2200 chars) and
  `USER.md` (user profile, 1375 chars), injected as a frozen snapshot at conversation start.
- Multi-user via Infisical secrets: secret **name** is the user id, secret **value** is that user's
  client API key. The key set is refreshed atomically (`TOKEN_REFRESH_MS`); unknown keys get 401 and
  the API fails closed with 503 until at least one key is loaded. Memory and transcripts are
  isolated per user.
- Default agent directory (`agents/default/SOUL.md`) is the base system prompt. `AGENT_DIR` and
  `AGENT_ID` are already agent-scoped for future multi-agent support (`data/users/<user>/agents/<id>/`).

## Setup

```bash
bun install
cp .env.example .env   # fill in backend + Infisical credentials
bun run start
```

In Infisical, create one secret per user in `INFISICAL_SECRET_PATH` (folder, e.g. `users`):
secret name `alice`, value `sk-...`; secret name `bob`, value `sk-...`.

OpenWebUI / any Responses-API client: base URL `http://<host>:8787/v1`, API key = one of the
Infisical secret values, model = `MODEL` (or an alias from `MODEL_ALIASES`).

## Environment

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `BASE_API_URL` | yes | – | OpenAI-compatible backend, e.g. `https://ollama.example/v1` |
| `API_KEY` | yes | – | Backend credential (never sent to clients) |
| `MODEL` | no | `beam:cloud` | Model id sent to the backend |
| `MODEL_ALIASES` | no | – | Extra ids advertised by `/v1/models` (same backend model) |
| `INFISICAL_BASE_URL` | yes | – | Infisical instance URL |
| `INFISICAL_CLIENT_ID` / `INFISICAL_CLIENT_SECRET` | yes | – | Universal Auth machine identity |
| `INFISICAL_PROJECT_ID` | yes | – | Project holding the user secrets |
| `INFISICAL_ENV` | yes | – | Environment slug (`prod`, `dev`, …) |
| `INFISICAL_SECRET_PATH` | no | `/` | Folder holding the user secrets |
| `TOKEN_REFRESH_MS` | no | `60000` | Key refresh interval (min 1000) |
| `ASSISTANT_API_KEYS` | no | – | Local fallback merged with Infisical (`key:user`, JSON object, or `[{key,user}]`) |
| `ASSISTANT_API_KEY` / `ASSISTANT_USER` | no | `default` | Single-key local fallback |
| `PORT` / `BIND_HOST` | no | `8787` / `0.0.0.0` | Listen address |
| `DATA_DIR` | no | `data` | Per-user memory root |
| `AGENT_DIR` | no | `agents/default` | `SOUL.md` location |
| `AGENT_ID` | no | `default` | Memory namespace segment |
| `CONTEXT_WINDOW` / `MAX_TOKENS` | no | `128000` / `8192` | Model metadata |

Local fallback keys must be at least 12 characters. They are useful for tests/offline work and are
always accepted alongside Infisical secrets.

## API

```bash
# list models
curl http://localhost:8787/v1/models -H "Authorization: Bearer $KEY"

# server-side loop (memory tool available automatically)
curl http://localhost:8787/v1/responses \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"beam:cloud","input":"Remember that my timezone is CET, then say ok."}'

# client-side tool
curl http://localhost:8787/v1/responses \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"beam:cloud","input":"Weather in Paris?","tools":[{"type":"function","name":"get_weather","description":"Weather","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}]}'

# return the tool result
curl http://localhost:8787/v1/responses \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"beam:cloud","previous_response_id":"resp_...","input":[{"type":"function_call_output","call_id":"call_...","output":"Sunny, 22C"}]}'
```

Also implemented: `GET /v1/responses/:id` (if `store` was not `false`), `GET /v1/models/:id`,
`GET /health` (`{ok,authReady,users}`), CORS preflight. Errors use the OpenAI
`{error:{message,type,param,code}}` shape.
Streaming emits the Responses SSE sequence (`response.created`, `response.in_progress`,
`response.output_item.added`, `response.output_text.delta`, `response.function_call_arguments.*`,
`response.completed` / `response.failed` / `response.incomplete`, `error`).

## Memory

Paths: `data/users/<user>/agents/<agent>/memories/{MEMORY.md,USER.md}`.

The model calls `memory` with `target` (`memory` or `user`), `action` (`add`, `patch`, `remove`,
`batch`), `content`, `old_text`, `operations`. Entries are separated by a line containing only `§`.
Writes are atomic and serialized; the limit is checked on the batch result, so one batch can free
space and add in the same call. Duplicate adds are no-ops, ambiguous `old_text` matches fail,
invisible/bidi Unicode and the delimiter are rejected. The system prompt snapshot is frozen for the
life of a conversation; tool results always show live entries and usage.

## Notes / limits

- Transcripts and response ids are **in memory**; only memory files persist. Stateless clients can
  resend full input instead of relying on `previous_response_id`.
- Model input is text-only. `input_image` parts are accepted only as `data:` URLs; remote image URLs
  are dropped (no server-side fetch).
- Server tool names win over client tools with the same name.
- Add server tools in `src/tools.ts` and register them in `src/runner.ts` (`serverTools`). Add them
  only if you trust the model with their side effects; there are no file/shell tools by default.
- `bun test` covers memory semantics, Responses input conversion, and the Infisical key registry;
  `bun run typecheck` for types. Tests live in `test/`.
- Client keys are hashed for lookup and never logged. Infisical failures keep the last known good
  key set; an empty initial load keeps the API at 503 instead of running open.
