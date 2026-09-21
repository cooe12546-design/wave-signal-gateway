# wave-signal-gateway

Standalone L1 ingest gateway for canonical `WAVE_SIGNAL_EVENT_V1` events emitted by the Wave Market Sensor EA (`WaveMarketSensorEA_SIGNAL_FULL_WORKING.mq5`, W9 transport).

**This service is completely independent of Trading Insight Pro / Lovable / Supabase.** It has its own storage, its own auth, its own deployment. Nothing in this repository writes to, reads from, or depends on the Trading Insight Pro codebase or database.

## Scope (L1 only)

```
EA → POST /signal-events → API-key auth → validation → event dedupe → SQLite → deterministic response
```

Not implemented yet (later roadmap stages — see below): Alert Router (A/B/C classification), LINE OA sending, recipient/subscription mapping, delivery retry/dedupe, or any bridge back to Trading Insight Pro.

## Requirements

- Node.js >= 18
- npm

## Setup

```bash
npm install
cp .env.example .env
# edit .env and set a real SIGNAL_EVENT_API_KEY
```

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port the gateway listens on |
| `SIGNAL_EVENT_API_KEY` | *(none — must be set)* | Shared secret the EA must send in the `X-API-Key` header. If unset, every request to `/signal-events` and `/line/test` returns `503`. |
| `DATABASE_PATH` | `./data/wave-signal-gateway.db` | SQLite file path. Use `:memory:` for ephemeral/test runs. |
| `LINE_CHANNEL_ACCESS_TOKEN` | *(none)* | LINE Messaging API Bearer token, server-side only. If unset, every LINE send fails safely with `CONFIG_MISSING_TOKEN` — ingest is unaffected. |
| `LINE_TEST_RECIPIENT_ID` | *(none)* | L3-only test recipient (userId/groupId/roomId). Real per-account mapping is L4's responsibility. |
| `LINE_MAX_ATTEMPTS` | `3` | Bounded retry attempts for a LINE send. |
| `LINE_RETRY_DELAY_MS` | `1000` | Delay between LINE retry attempts. |
| `LINE_TIMEOUT_MS` | `8000` | Per-attempt LINE request timeout. |
| `LINE_CHANNEL_SECRET` | *(none)* | Verifies inbound `POST /line/webhook` signatures. **Different from `LINE_CHANNEL_ACCESS_TOKEN`** — never sent to LINE, only used locally for HMAC verification. |

No real secret is committed anywhere in this repository — `.env.example` only contains placeholder values, and `.env` itself should never be committed (add it to your deployment platform's secret store instead).

## Run

```bash
npm run dev     # ts-node/tsx watch mode
npm run build   # compile to dist/
npm start        # run the compiled build (node dist/server.js)
```

## Self-test (real runtime QA, not just static checks)

```bash
npm test                 # runs all suites below, sequentially
npm run test:gateway      # L1: ingest endpoint + SQLite idempotency (30 assertions)
npm run test:router        # L2: Alert Router A/B/C classification + templates (48 assertions)
npm run test:line            # L3: LINE Sender retry/timeout/auth policy, mocked HTTP (28 assertions)
npm run test:integration      # L3: full ingest -> Router -> LINE pipeline, mocked LINE fetch (13 assertions)
npm run test:webhook           # L3A: LINE webhook signature verification, REAL computed HMAC (14 assertions)
```

`test:gateway` starts real, in-process Fastify server instances (backed by an in-memory SQLite database) and issues real HTTP requests against them, covering: health check, missing/wrong/unconfigured auth, every validation rule, a full valid insert with payload-preservation checks, retry idempotency, all 12 canonical event types, and a genuine concurrent-duplicate race test via `Promise.all`.

`test:router` calls the real `classifyEvent()` function (no mocking) and verifies: all 12 event types map to the correct, frozen alert type with the correct `shouldDeliver` flag; `ENTRY_RETEST`'s specific default-suppression reason; `SIGNAL_REPLACED`'s old/new signal-id mapping is never reversed; a mixed event sequence is classified in input order without reordering/buffering; every template is free of forbidden trading-advice/guarantee phrasing and never leaks a secret, an auth header value, or a raw JSON/object dump; and the Router never throws when optional payload blocks are entirely absent.

`test:line` calls the real `sendLineText()` function against a **controlled mocked `fetch`** (no real network call) and verifies: the Sender's own defensive boundary (missing token / empty recipient / empty message, none of which ever reach `fetch`); 2xx success with no retry; 400/401/403 are never retried; 5xx and network errors are retried up to the bounded attempt limit, then correctly fail; 429 is retried honoring `Retry-After`; `X-Line-Retry-Key` is identical across every retry attempt within one invocation, is a valid hex UUID, and a separate invocation always gets a different key; and the channel access token never appears in the returned result object.

`test:integration` exercises the **real** `/signal-events` route end-to-end (real SQLite, real validation, real `classifyEvent()`, only the LINE `fetch` call itself mocked) and verifies the critical cross-cutting invariants: a deliverable event triggers exactly one LINE call; `ENTRY_RETEST` triggers **zero** LINE calls; a duplicate (retried) event does **not** re-invoke the Router or LINE a second time; and ingest still returns success even when the mocked LINE call fails on every attempt or when `LINE_CHANNEL_ACCESS_TOKEN` is entirely unconfigured.

`test:webhook` calls the real `POST /line/webhook` route with **genuinely computed HMAC-SHA256 signatures** (not a bypass) — verifying: missing secret/signature/invalid-signature rejection; LINE's own verification request (`events: []`) succeeds; a real `source.userId` is extracted and logged; multiple mixed user/group events are all handled correctly; secrets never appear in logs; and — the key proof that raw-byte verification is genuinely in effect — a signature computed for one exact byte sequence is correctly rejected when a *semantically identical but differently-formatted* JSON body is submitted instead.

## Alert Router (L2)

`src/router/` — a **pure** module: `classifyEvent(event)` takes one accepted canonical event and returns a deterministic `RouterDecision` (`alertType`, `shouldDeliver`, `suppressionReason`, `messageText`). It never writes a database, sends HTTP, calls LINE, mutates its input, reads live market state, or recomputes any lifecycle/materiality decision the EA already made — those are out of scope by design (L3+ owns delivery; the EA already owns lifecycle/A4).

| Alert | Event types | Notes |
|---|---|---|
| **A** | `SIGNAL_CREATED` | New actionable Signal announcement |
| **B** | `MARKET_CONTEXT_SNAPSHOT`, `MARKET_CONTEXT_UPDATE` | Context at creation, and later material updates (EA already decided materiality) |
| **C** | `ENTRY_TOUCHED`, `ENTRY_RETEST`, `TP1_HIT`, `TP2_HIT`, `SIGNAL_WEAKENING`, `SIGNAL_RECOVERED`, `SIGNAL_INVALIDATED`, `SIGNAL_EXPIRED`, `SIGNAL_REPLACED` | Lifecycle/progress reporting. `ENTRY_RETEST` is the one type with `shouldDeliver=false` by default (still fully classified and stored, never discarded) |

Templates are plain, deterministic text (V1, no Flex Message yet) — no trading advice, no execution commands, no profit/guarantee language, no raw JSON, no secrets.

## LINE OA Sender (L3)

`src/line/line-sender.ts` — `sendLineText({recipientId, messageText}, config)`. Uses the **official** LINE Messaging API push-message endpoint (`POST https://api.line.me/v2/bot/message/push`) only — never LINE Notify, never an unofficial SDK. Bearer-authenticated with `LINE_CHANNEL_ACCESS_TOKEN` (server-side secret only — never returned in a response, never logged, never stored, never present in a `RouterDecision`).

- **Retry**: bounded (`LINE_MAX_ATTEMPTS`, default 3), `LINE_RETRY_DELAY_MS` (default 1000ms) between attempts. Retries 5xx, network errors, and 429 (honoring `Retry-After` when LINE supplies a valid one); **never** retries 400/401/403 (permanent failures).
- **`X-Line-Retry-Key`**: a fresh hex UUID (`crypto.randomUUID()`) generated once per `sendLineText()` call and reused unchanged across every retry attempt inside that one call — never regenerated per attempt, never derived from the token. **Known limitation, stated plainly**: this key lives only in memory for the duration of one function call; it does not survive a process restart. Restart-safe retry identity is explicitly L5's responsibility, not L3's.
- **Timeout**: `LINE_TIMEOUT_MS` (default 8000ms) via `AbortController` — a hung LINE request cannot hang the caller indefinitely.
- **Fails safely, never crashes**: missing token, empty recipient, or empty message text are all caught before any network call is made.

**Integration** (`src/routes/signal-events.ts`): after a *newly inserted* (non-duplicate) event is persisted, the same request handler calls `classifyEvent()` then, if `shouldDeliver`, `sendLineText()` — **awaited**, not fire-and-forget, specifically because the EA's own transport sends one Signal Event at a time and waits for each response before sending the next, so awaiting here preserves EA-input delivery order for free. Critically, **the ingest HTTP response is already fully determined before this step runs**, and the whole step is wrapped in its own `try`/`catch` — a LINE failure (or even an unexpected Router exception) is logged and can never change the `200` ingest response for an event that was genuinely persisted. A duplicate (`idempotent: true`) event **never** re-triggers the Router or LINE at all — that branch doesn't call this integration step.

A `POST /line/test` route (same `X-API-Key` gate as `/signal-events`) sends one fixed or bounded-length supplied test message to `LINE_TEST_RECIPIENT_ID`, for proving delivery independently of the ingest pipeline.

## LINE Webhook — Test User-ID Capture (L3A)

`src/routes/line-webhook.ts` — `POST /line/webhook`. A narrow, receive-only utility: verifies a real inbound LINE Messaging API webhook and logs `events[].source.userId` so you can copy a real value into `LINE_TEST_RECIPIENT_ID`. **Not part of the delivery pipeline** — it never calls the Router, the LINE Sender, or writes to SQLite.

- **Signature verification** uses the *exact raw request bytes* LINE signed — this route registers its own scoped Fastify content-type parser (`parseAs: 'string'`) so the body is never JSON-parsed-then-re-stringified before verification (which would change whitespace/key order and invalidate the signature). Verified with a real test proving that a byte-different-but-JSON-equivalent body fails signature verification.
- **`HMAC-SHA256(LINE_CHANNEL_SECRET, rawBody)`, base64-encoded, compared with `node:crypto`'s `timingSafeEqual`** against the `x-line-signature` header. A length mismatch (e.g. garbage input) is handled safely without throwing.
- **`LINE_CHANNEL_SECRET` is a separate secret from `LINE_CHANNEL_ACCESS_TOKEN`** — used only for verifying inbound webhooks, never sent to LINE, never logged.
- LINE's own webhook-verification request (`events: []`) is handled correctly — still returns `200` after a valid signature, no event required.
- `group`/`room` source events are logged (type + id) without ever inventing a user identity for them.
- No reply message, no push message, no `sendLineText()` call, no database write — confirmed by direct source inspection and a dedicated test asserting neither the Router nor the Sender's mock is ever invoked from this route.

## API

### `GET /health`
```json
{ "ok": true, "service": "wave-signal-gateway" }
```

### `POST /signal-events`
Header: `X-API-Key: <SIGNAL_EVENT_API_KEY>`
Body: one `WAVE_SIGNAL_EVENT_V1` JSON event.

Responses:
- `200 { ok: true, idempotent: false, id, event_key }` — new event stored.
- `200 { ok: true, idempotent: true, event_key }` — duplicate `event_key`; nothing new was stored, the existing event remains unmodified.
- `400 { ok: false, error }` — schema/identity validation failed (invalid `schema_version`, unknown `event_type`, malformed identity fields, `event_key` not matching the deterministic `{signal_id}:{event_type}:{event_sequence}` format, or `event_id !== event_key`).
- `401 { ok: false, error: "Unauthorized" }` — missing or incorrect `X-API-Key`.
- `503 { ok: false, error: "Service unavailable" }` — `SIGNAL_EVENT_API_KEY` is not configured server-side.
- `500 { ok: false, error: "Internal error" }` — unexpected storage failure.

### `POST /line/test`
Header: `X-API-Key: <SIGNAL_EVENT_API_KEY>` (same secret as `/signal-events`)
Body (optional): `{ "text": "..." }` — truncated to 500 characters; falls back to a fixed default test message if omitted.

Sends one text message to `LINE_TEST_RECIPIENT_ID` via the real LINE Sender. Responses:
- `200 { ok: true, httpStatus, requestId, attempts }` — LINE accepted the message.
- `502 { ok: false, errorCode, errorMessage, attempts }` — LINE rejected it or the request failed after retries.
- `401` — missing/wrong `X-API-Key`. `503` — `SIGNAL_EVENT_API_KEY` or `LINE_TEST_RECIPIENT_ID` not configured.

### `POST /line/webhook`
Header: `x-line-signature: <HMAC-SHA256 base64 signature>`
Body: raw LINE webhook payload (`{"events": [...]}`, or `{"events": []}` for LINE's own verification request).

- `200 { ok: true }` — signature verified, `events[].source.userId` (if any) logged.
- `401 { ok: false, error }` — missing or invalid `x-line-signature`.
- `503 { ok: false, error: "Service unavailable" }` — `LINE_CHANNEL_SECRET` not configured.
- `400 { ok: false, error }` — malformed body after successful signature verification.

## Storage

SQLite (`better-sqlite3`), one table:

```sql
CREATE TABLE signal_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  event_key TEXT NOT NULL UNIQUE,
  schema_version TEXT NOT NULL,
  signal_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_sequence INTEGER NOT NULL,
  symbol TEXT,
  timeframe TEXT,
  direction TEXT,
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL
);
```

`UNIQUE(event_key)` is the sole idempotency authority — the insert path never does "SELECT then INSERT"; it always attempts the INSERT directly and treats SQLite's own constraint-violation error as a successful idempotent outcome. `payload_json` always holds the complete, unmodified accepted payload — `symbol`/`timeframe`/`direction` are convenience columns extracted for querying, never a substitute for the raw payload.

## Deployment portability

No Lovable, Supabase, or Trading-Insight-Pro dependency anywhere. Deploys anywhere Node.js runs:

- **Railway / Render / Fly.io**: point at this repo, set the three env vars, done. The `DATABASE_PATH` should point at a persistent volume/disk if the platform offers one (SQLite is a single file).
- **Docker**: a minimal Dockerfile would be `FROM node:20-slim`, `COPY . .`, `RUN npm ci && npm run build`, `CMD ["node", "dist/server.js"]` — not included in L1 since it wasn't requested, but the project needs no changes to containerize.
- **VPS**: `npm ci && npm run build && npm start` behind any reverse proxy/process manager (pm2, systemd) of your choice.

## Roadmap

- **L2 — Alert Router: DONE.** Classifies each stored event into Alert A / B / C with deterministic text, per the frozen B0 mapping. No LINE sending yet — `shouldDeliver` is returned, not acted on.
- **L3 — LINE OA Sender: DONE** (this delivery). Real push-message delivery to one server-side test recipient, wired minimally into the ingest pipeline (fire-after-persist, never fire-before or in place of persistence).
- **L4** — Recipient Binding: subscription/recipient mapping (frozen decision: account authority = Trading Insight Pro's `trade_accounts.id`, to be synced/bridged later, not duplicated here). Replaces the single `LINE_TEST_RECIPIENT_ID` env var with real per-account recipient resolution.
- **L5** — Retry / Delivery Dedupe / Logs: `alert_deliveries`-equivalent persistent record, `UNIQUE(event_key, recipient_id, alert_type)`, **restart-safe** retry identity (closing L3's own documented in-memory-only retry-key limitation), structured observability.
- **L6** — End-to-end EA → LINE QA.

### Future WEB-BRIDGE (documentation only — not implemented in this track)

A later, separate integration point would connect this finished standalone system back to Trading Insight Pro:
- Forwarding accepted events (or a subset) into Trading Insight Pro's own `signal_events`-equivalent table for in-app display.
- Reconciling account/user identity between this gateway's recipient model and Trading Insight Pro's `trade_accounts`/`profiles`.
- Syncing subscription state so a user manages alert preferences in one place.

None of this is built, scaffolded, or assumed by the code in this repository — it is documented here only so the eventual bridge design has a fixed reference point.
