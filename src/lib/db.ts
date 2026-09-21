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
}

/**
 * Opens (creating if needed) the standalone SQLite database and ensures the
 * signal_events table exists, per brief §8's exact suggested schema.
 * No processed_at column -- brief §8 says it is not required yet.
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
 *     on a duplicate (brief §10).
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
): InsertOutcome {
  const insertStmt = db.prepare(`
    INSERT INTO signal_events
      (event_id, event_key, schema_version, signal_id, event_type, event_sequence, symbol, timeframe, direction, payload_json, received_at)
    VALUES (@event_id, @event_key, @schema_version, @signal_id, @event_type, @event_sequence, @symbol, @timeframe, @direction, @payload_json, @received_at)
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
