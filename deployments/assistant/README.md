# assistant

OpenAI-compatible **Responses API** on top of a [pi](https://github.com/badlogic/pi-mono) agent
(`@mariozechner/pi-agent-core`) served by Bun. One process, multiple agents and users, per-user
memory per agent.

```
client ──Bearer sk-...──> assistant :8787
                           │  pi Agent (tools, loop)
                           ├─ agents/ (SOUL.md + optional config.yaml; one /v1/models entry each)
                           ├─ Infisical (client keys: name = user id, value = key)
                           ├─ memory (MEMORY.md / USER.md per user per agent)
                           └─ OpenAI-compatible backend (per-agent override or .env)
```

## What it does

- `POST /v1/responses` with `stream: true|false`.
- **Server-side tools**: the pi agent executes tools inline and keeps looping until it answers.
  Server tools are exposed to the model as `server_<name>` (for example `server_memory`); the
  convention is also stated in the system prompt.
- **Client-side tools**: function tools in the request are returned as `function_call` output items
  (`call_id`, `name`, `arguments`) under their original names. The caller executes them and sends
  `function_call_output` items on the next request. A batch containing a client tool stops the
  server loop immediately; server tool calls in the same batch still execute and stay in the stored
  transcript, but are not exposed as output items. Client tool names starting with `server_` are
  rejected with `400` because that prefix is reserved for server tools.
- `previous_response_id` replays the stored pi transcript for the same user key hash and agent.
  Sessions persist in SQLite (`bun:sqlite`, table `session`) and survive restarts.
- Automatic compaction summarizes older turns when the estimated context crosses a configurable
  fraction of the context window, keeping recent turns verbatim for long-running chats.
- Server file/shell tools (`server_read`, `server_write`, `server_edit`, `server_bash`) run in a
  per-agent, per-user workspace (`data/agents/<agent>/user-<key-hash>`); `server_session_search`
  searches this user's persisted conversations.
- Hermes-style persistent memory per user, with `MEMORY.md` (agent notes, 2200 chars) and
  `USER.md` (user profile, 1375 chars), injected as a frozen snapshot at conversation start.
- Multi-user via Infisical secrets: secret **name** is the user id, secret **value** is that user's
  client API key. The key set is refreshed atomically (`TOKEN_REFRESH_MS`); unknown keys get 401 and
  the API fails closed with 503 until at least one key is loaded. Memory and transcripts are
  isolated per user.
- Multi-agent: every `agents/<id>/` directory with a `SOUL.md` is selectable. `/v1/models` lists
  those ids, and the request `model` field selects one. `.env` remains the required default backend;
  `agents/<id>/config.yaml` can override the backend URL, key, or model per agent.
- SOUL prompt and memory are scoped per agent (`data/users/<user>/agents/<agent>/memories/`).

## Setup

```bash
bun install
cp .env.example .env   # fill in backend + Infisical credentials
cp agents/default/config.example.yaml agents/default/config.yaml   # optional overrides
bun run start
```

In Infisical, create one secret per user in `INFISICAL_SECRET_PATH` (folder, e.g. `users`):
secret name `alice`, value `sk-...`; secret name `bob`, value `sk-...`.

OpenWebUI / any Responses-API client: base URL `http://<host>:8787/v1`, API key = one of the
Infisical secret values, model = an agent id from `/v1/models` (for example `default`). The
default agent's backend `MODEL`/`MODEL_ALIASES` are also accepted as `model` values for
compatibility, but only agent ids are listed.

## Per-agent overrides

`<AGENT_DIR>/config.yaml` may override any of:

```yaml
apiUrl: https://other-backend.example/v1
apiKey: sk-other-backend
model: other:cloud
maxInputTokens: 100000
compactionThreshold: 0.75
compactionKeepTurns: 6
```

- `.env` is still required: `BASE_API_URL`, `API_KEY`, and `MODEL` are the defaults.
- Missing file or unset keys fall back to `.env`.
- The file is read once at startup; restart to apply changes.
- Unknown keys, non-string values, and empty values fail startup instead of being ignored.
- `maxInputTokens` is a non-negative integer; `0` disables the input check for that agent.
- `compactionThreshold` is in `[0,1]` (`0` disables compaction); `compactionKeepTurns` is a
  positive integer.
- Overriding `model` changes that agent's backend model; it does not change the agent id listed in
  `/v1/models`. Env `MODEL_ALIASES` are accepted for the default agent but are not listed.
- `config.yaml` is gitignored because it can contain an API key; commit
  `config.example.yaml` instead.

## Agents and model selection

```
agents/
  default/
    SOUL.md
    config.yaml            # optional, gitignored
    config.example.yaml
  other/
    SOUL.md                # required marker
    config.yaml            # optional backend overrides
```

- `/v1/models` returns one entry per agent directory that contains `SOUL.md`, using the directory
  name as the model id. The env-configured default (`AGENT_ID` / `AGENT_DIR`) is always included.
- The request `model` field selects the agent. `model` omitted → the env default agent.
- Backend `MODEL`/`MODEL_ALIASES` are accepted for the default agent only; this keeps old clients
  working. Agent ids win if an id collides with an alias.
- Agent directories are discovered at startup; restart after adding, removing, or renaming one.
- Each agent applies its own `config.yaml` overrides (backend URL/key/model, `maxInputTokens`,
  `compactionThreshold`, `compactionKeepTurns`), SOUL prompt, sessions, workspace, and memory
  namespace. Infisical, port, data root, and refresh settings remain process-wide.

## Environment

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `BASE_API_URL` | yes | – | OpenAI-compatible backend, e.g. `https://ollama.example/v1` |
| `API_KEY` | yes | – | Backend credential (never sent to clients) |
| `MODEL` | no | `beam:cloud` | Default backend model |
| `MODEL_ALIASES` | no | – | Extra accepted `model` values for the default agent (not listed in `/v1/models`) |
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
| `AGENTS_DIR` | no | `agents` | Root scanned for selectable agent directories |
| `AGENT_ID` | no | `default` | Env-configured default agent id |
| `AGENT_DIR` | no | `<AGENTS_DIR>/<AGENT_ID>` | Directory for the env-configured default agent |
| `CONTEXT_WINDOW` / `MAX_TOKENS` | no | `128000` / `8192` | Model metadata |
| `MAX_INPUT_TOKENS` | no | `0` | Estimated input-token cap per request; `0` disables it |
| `COMPACTION_THRESHOLD` | no | `0.75` | Fraction of `CONTEXT_WINDOW` that triggers compaction; `0` disables |
| `COMPACTION_KEEP_TURNS` | no | `6` | Recent conversation turns kept verbatim |

Local fallback keys must be at least 12 characters. They are useful for tests/offline work and are
always accepted alongside Infisical secrets.

## API

```bash
# list agents (model ids)
curl http://localhost:8787/v1/models -H "Authorization: Bearer $KEY"

# server-side loop (server tools available automatically)
curl http://localhost:8787/v1/responses \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"default","input":"Remember that my timezone is CET, then say ok."}'

# client-side tool
curl http://localhost:8787/v1/responses \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"default","input":"Weather in Paris?","tools":[{"type":"function","name":"get_weather","description":"Weather","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}]}'

# return the tool result
curl http://localhost:8787/v1/responses \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"default","previous_response_id":"resp_...","input":[{"type":"function_call_output","call_id":"call_...","output":"Sunny, 22C"}]}'
```

Also implemented: `GET /v1/responses/:id` (if `store` was not `false`), `GET /v1/models/:id`,
`GET /health` (`{ok,authReady,users,agents}`), CORS preflight. Errors use the OpenAI
`{error:{message,type,param,code}}` shape.
Streaming emits the Responses SSE sequence (`response.created`, `response.in_progress`,
`response.output_item.added`, `response.output_text.delta`, `response.function_call_arguments.*`,
`response.completed` / `response.failed` / `response.incomplete`, `error`).

## Memory

Paths: `data/users/<user>/agents/<agent>/memories/{MEMORY.md,USER.md}`.

The model calls `server_memory` with `target` (`memory` or `user`), `action` (`add`, `patch`, `remove`,
`batch`), `content`, `old_text`, `operations`. Entries are separated by a line containing only `§`.
Writes are atomic and serialized; the limit is checked on the batch result, so one batch can free
space and add in the same call. Duplicate adds are no-ops, ambiguous `old_text` matches fail,
invisible/bidi Unicode and the delimiter are rejected. The system prompt snapshot is frozen for the
life of a conversation; tool results always show live entries and usage.

## Sessions

One SQLite database per agent: `data/agents/<agent>/sessions.db` (WAL mode), table `session`.

- Each row stores `response_id`, `previous_response_id`, `user_hash`, `agent_id`, timestamp, the
  frozen base system prompt, the pi transcript (`messages` JSON), and the Responses payload.
- Queries are filtered by the short API-key hash (`user_hash`) and response id. The agent is
  implicit in the database file.
- `previous_response_id` works after a restart and is rejected if the id belongs to another user
  key hash or agent.
- `store: false` skips writing the new response, but earlier stored ids remain usable.
- `GET /v1/responses/:id` searches the agent databases for the requesting key hash.
- `server_session_search` searches only the current user's rows in the current agent database and
  returns `response_id`, timestamp, and a snippet. Pass `response_id` to restrict the search to one
  stored response.

## Compaction

When the estimated prompt exceeds `COMPACTION_THRESHOLD × CONTEXT_WINDOW` (capped by
`MAX_INPUT_TOKENS` when set), older conversation units are summarized before the model call:

- The last `COMPACTION_KEEP_TURNS` user turns (including their assistant and tool messages) are kept
  verbatim.
- Older turns are summarized by the same backend model; if that call fails, a deterministic digest
  is used so a chat never wedges.
- The summary is inserted as a reference-only user message and the compacted transcript replaces
  the stored session state, giving long conversations a bounded context.
- Set `compactionThreshold` in `config.yaml` or `COMPACTION_THRESHOLD=0` to disable compaction for an
  agent.

## Workspace tools

Server tools run in `data/agents/<agent>/user-<key-hash>/`:

| Tool | Behavior |
| --- | --- |
| `server_read` | Read a UTF-8 file, 1-based `offset`/`limit` lines |
| `server_write` | Write a UTF-8 file, creating parent directories |
| `server_edit` | Replace exact text (`old_string` unique unless `replace_all`) |
| `server_bash` | Run bash with the workspace as cwd and a minimal environment |

File tools reject paths that resolve outside the workspace. `server_bash` is a working directory,
not a filesystem sandbox: it can still reach other paths the process can read. Server secrets are
not passed in its environment.

## Notes / limits

- Transcripts and response ids persist in `data/agents/<agent>/sessions.db`; memory files and
  workspaces also survive restarts. Sessions are filtered by the short API-key hash, so rotating a
  user's key starts a fresh session namespace. `store: false` skips persistence for that response.
- Auto-compaction runs before the model call and after the input-limit estimate; the summary call
  uses the same backend model and is not counted as user-visible output tokens.
- `MAX_INPUT_TOKENS` / `maxInputTokens` rejects oversized requests with `400
  context_length_exceeded` before the model call. The estimate is approximate (4 chars/token,
  fixed 1000 tokens per image, tool schemas included), not a model tokenizer. The limit is checked
  against the incoming prompt (system prompt + history + new input + tools); server tool results
  produced during the loop are bounded and not re-checked.
- Model input is text-only. `input_image` parts are accepted only as `data:` URLs; remote image URLs
  are dropped (no server-side fetch).
- Server tools use the reserved `server_` prefix; a client tool with the same base name (for example
  `bash`) is a different tool and both are available. Client tool names starting with `server_` are
  rejected.
- Add server tools in `src/tools.ts` and wrap them with `namespaceServerTool` in `src/runner.ts`
  (`serverTools`). The wrapper exposes them as `server_<name>`, so a client `bash` and a server
  `bash` remain distinct. Server file/shell tools are scoped to the per-user workspace; add more
  only if you trust the model with their side effects.
- `bun test` covers memory semantics, Responses input conversion, the Infisical key registry,
  agent config overrides, agent discovery/resolution, server tool namespacing, token estimation,
  SQLite session persistence/search, compaction, and workspace tools; `bun run typecheck` for
  types. Tests live in `test/`.
- Client keys are hashed for lookup and never logged. Infisical failures keep the last known good
  key set; an empty initial load keeps the API at 503 instead of running open.
