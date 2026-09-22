import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import type { ValidatedEvent } from "./validation.js";

export interface StoredEvent {
  id: number;
  event_id: string;
  event_key: string;
  schema_version: string;
  signal_id: string;
  event_type: string;
  event_sequence: number;
  symbol: string | null;
  timeframe: string | null;
  direction: string | null;
  payload_json: string;
  received_at: string;
  account_id: string | null;
}

/**
 * Opens (creating if needed) the standalone SQLite database and ensures the
 * signal_events table exists, per brief §8's exact suggested schema.
 * No processed_at column -- brief §8 says it is not required yet.
 *
 * L4 OWNER AMENDMENT: account_id is added via a migration step below
 * rather than directly in this CREATE TABLE, so an existing database file
 * created before L4 (with the original L1 schema) is upgraded safely --
 * ALTER TABLE ADD COLUMN on an existing SQLite table, rather than
 * requiring a fresh file. A brand-new database goes through the exact
 * same migration path (CREATE, then the "does the column already exist"
 * check finds it missing and adds it) -- one code path for both cases,
 * not two to keep in sync.
 */
export function openDatabase(dbPath: string): Database.Database {
  const dir = path.dirname(dbPath);
  if (dir && dir !== "." && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS signal_events (
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
  `);

  const signalEventsColumns = db.prepare(`PRAGMA table_info(signal_events)`).all() as Array<{ name: string }>;
  if (!signalEventsColumns.some((c) => c.name === "account_id")) {
    // Nullable at the schema level deliberately (SQLite's ADD COLUMN can't
    // retroactively enforce NOT NULL against existing rows) -- "required"
    // is enforced at the application layer instead, by the ingest route's
    // own 400 rejection of a missing/blank X-Account-Id (brief's own
    // "Missing Header Policy"), which is where it belongs since this is
    // gateway-owned routing metadata, not canonical event content.
    db.exec(`ALTER TABLE signal_events ADD COLUMN account_id TEXT`);
  }

  // L4: recipient/subscription tables. account_id here is the SAME opaque
  // external id persisted on signal_events.account_id -- never validated
  // against Trading Insight Pro/Supabase from this standalone gateway
  // (explicit Owner instruction), only ever compared for equality.
  db.exec(`
    CREATE TABLE IF NOT EXISTS line_recipients (
      id TEXT PRIMARY KEY,
      line_user_id TEXT NOT NULL,
      recipient_type TEXT NOT NULL DEFAULT 'user',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS alert_subscriptions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL REFERENCES line_recipients(id),
      enabled INTEGER NOT NULL DEFAULT 1,
      alert_a_enabled INTEGER NOT NULL DEFAULT 1,
      alert_b_enabled INTEGER NOT NULL DEFAULT 1,
      alert_c_enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      UNIQUE(account_id, recipient_id)
    );

    CREATE INDEX IF NOT EXISTS idx_alert_subscriptions_account_id ON alert_subscriptions(account_id);
  `);

  // L5: persistent delivery ledger.
  // UNIQUE(event_key, recipient_id, alert_type) is the sole persistent
  // delivery-dedupe authority (Owner's own exact instruction) -- the same
  // race-safe "attempt INSERT, catch constraint violation" pattern used by
  // signal_events.event_key is used again here (see createDeliveryRow() in
  // src/lib/deliveries.ts), never SELECT-then-INSERT.
  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_deliveries (
      id TEXT PRIMARY KEY,
      event_key TEXT NOT NULL,
      signal_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      retry_key TEXT NOT NULL,
      message_text TEXT NOT NULL,
      last_http_status INTEGER,
      last_error_code TEXT,
      last_error_message TEXT,
      next_retry_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      delivered_at TEXT,
      UNIQUE(event_key, recipient_id, alert_type)
    );

    CREATE INDEX IF NOT EXISTS idx_alert_deliveries_due ON alert_deliveries(status, next_retry_at);
    CREATE INDEX IF NOT EXISTS idx_alert_deliveries_event_key ON alert_deliveries(event_key);
  `);

  // L5 §7 -- crash/restart recovery for stale SENDING rows. A process may
  // crash after marking a row SENDING but before writing the final
  // outcome; on every openDatabase() call (i.e. every process start), any
  // SENDING row whose updated_at is older than the stale threshold is
  // converted back to FAILED_RETRYABLE (immediately due, next_retry_at =
  // now) so the retry sweep picks it back up. A freshly-marked SENDING row
  // (younger than the threshold) is deliberately left alone -- it may
  // still be a genuinely in-flight attempt from a still-running process
  // (or one that only just crashed), and retrying it immediately would
  // risk a real double-send if it actually completes moments later.
  //
  // STALE_SENDING_THRESHOLD_MS is an interim default, NOT Owner-frozen --
  // reported explicitly as such in the L5 build report, per that task's
  // own instruction. Reasoning for the chosen value: one real delivery
  // attempt takes at most roughly LINE_TIMEOUT_MS x LINE_MAX_ATTEMPTS
  // (8000ms x 3 = 24s in this project's own established L3 defaults) even
  // in the worst case, so 5 minutes is a generous multiple of that -- long
  // enough to avoid recovering a row that is still legitimately in
  // flight, short enough to recover promptly after a real crash.
  const STALE_SENDING_THRESHOLD_MS = Number(process.env.DELIVERY_STALE_SENDING_THRESHOLD_MS ?? 5 * 60 * 1000);
  const staleCutoffIso = new Date(Date.now() - STALE_SENDING_THRESHOLD_MS).toISOString();
  const recovered = db
    .prepare(
      `UPDATE alert_deliveries
       SET status = 'FAILED_RETRYABLE', next_retry_at = ?, updated_at = ?
       WHERE status = 'SENDING' AND updated_at < ?`,
    )
    .run(new Date().toISOString(), new Date().toISOString(), staleCutoffIso);
  if (recovered.changes > 0) {
    // Logged here (not via src/lib/logger.ts) because this runs during
    // openDatabase(), before any route/logger wiring is guaranteed set up
    // in every caller (including the self-test harness, which opens many
    // short-lived in-memory databases) -- kept to a single safe,
    // structured line, no secrets, consistent shape with the rest of the
    // app's logs.
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        event: "delivery.restart_recovered",
        recovered_count: recovered.changes,
        stale_threshold_ms: STALE_SENDING_THRESHOLD_MS,
      }),
    );
  }

  return db;
}

export type InsertOutcome = { idempotent: boolean; row: StoredEvent };

/**
 * Race-safe idempotent insert (brief §9/§10/§23).
 *
 * Deliberately NEVER does "SELECT then INSERT" as the dedupe mechanism --
 * that pattern has a race window between the two statements. Instead this
 * always attempts the INSERT directly and treats SQLite's own
 * UNIQUE(event_key) constraint as the sole authority:
 *
 *   - New event_key  -> INSERT succeeds -> idempotent=false.
 *   - Existing event_key -> INSERT throws a constraint-violation error
 *     (SQLITE_CONSTRAINT_UNIQUE) -> caught here, treated as a SUCCESSFUL
 *     idempotent outcome (not an error) -> the already-stored row is
 *     fetched and returned, unmodified. payload_json is never overwritten
 *     on a duplicate (brief §10), and neither is account_id -- a retried
 *     event keeps whatever account_id its original, first-ever insert
 *     recorded (L4 OWNER AMENDMENT: account_id is NOT part of the
 *     event_key dedupe identity -- Owner's own instruction that account
 *     routing metadata must never change event dedupe identity).
 *
 * Concurrency note (reported honestly, not overclaimed): better-sqlite3 is
 * synchronous and this process is single-threaded for JS execution, so two
 * requests handled by ONE gateway process can never actually interleave
 * inside this function -- one INSERT fully completes (success or
 * exception) before the next request's handler code can run at all, which
 * is a stronger guarantee than typical "the constraint prevents it" async
 * reasoning. If this gateway is ever run as multiple processes/workers
 * sharing one SQLite file, true concurrent writers become possible again --
 * in that case SQLite's own UNIQUE constraint (enforced by the database
 * engine itself, independent of which process is writing) remains the
 * authority and this same catch-and-treat-as-idempotent logic still
 * produces the correct, deterministic result.
 */
export function insertEventIdempotent(
  db: Database.Database,
  event: ValidatedEvent,
  rawPayload: unknown,
  accountId: string,
): InsertOutcome {
  const insertStmt = db.prepare(`
    INSERT INTO signal_events
      (event_id, event_key, schema_version, signal_id, event_type, event_sequence, symbol, timeframe, direction, payload_json, received_at, account_id)
    VALUES (@event_id, @event_key, @schema_version, @signal_id, @event_type, @event_sequence, @symbol, @timeframe, @direction, @payload_json, @received_at, @account_id)
  `);
  const selectStmt = db.prepare(`SELECT * FROM signal_events WHERE event_key = ?`);

  const receivedAt = new Date().toISOString();

  try {
    insertStmt.run({
      event_id: event.event_id,
      event_key: event.event_key,
      schema_version: event.schema_version,
      signal_id: event.signal_id,
      event_type: event.event_type,
      event_sequence: event.event_sequence,
      symbol: event.symbol,
      timeframe: event.timeframe,
      direction: event.direction,
      payload_json: JSON.stringify(rawPayload),
      received_at: receivedAt,
      account_id: accountId,
    });
    const row = selectStmt.get(event.event_key) as StoredEvent;
    return { idempotent: false, row };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    const isUniqueViolation =
      e?.code === "SQLITE_CONSTRAINT_UNIQUE" ||
      e?.code === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
      /UNIQUE constraint failed/i.test(String(e?.message ?? ""));

    if (isUniqueViolation) {
      const row = selectStmt.get(event.event_key) as StoredEvent | undefined;
      if (row) {
        return { idempotent: true, row };
      }
    }
    throw err;
  }
}
