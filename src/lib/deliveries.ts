import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { sendLineText } from "../line/line-sender.js";
import type { LineSenderConfig } from "../line/types.js";
import { logger } from "./logger.js";
import type { AlertType } from "../router/types.js";

/**
 * L5 — Persistent Delivery State.
 *
 * (event_key, recipient_id, alert_type) is the sole persistent delivery
 * identity (Owner's own exact instruction) -- enforced by a real SQLite
 * UNIQUE constraint (src/lib/db.ts), never by application-level
 * SELECT-then-INSERT.
 *
 * Schema note (disclosed, not silently added): `message_text` is stored on
 * each row even though it wasn't in Owner's literal "minimum required
 * fields" list. Without it, a later retry-sweep execution (possibly
 * minutes or a restart later) would have no text to actually send.
 * Re-deriving it fresh via classifyEvent() at retry time was considered
 * and rejected: L5's own stated goal is an "auditable" ledger, and storing
 * the exact text that was (or will be) attempted is more faithful to that
 * than silently reflecting whatever the Router's templates compute today,
 * which could differ from what was true when the delivery was created if
 * templates are ever changed later.
 */

export type DeliveryStatus = "PENDING" | "SENDING" | "DELIVERED" | "FAILED_RETRYABLE" | "FAILED_PERMANENT";

export interface DeliveryRow {
  id: string;
  event_key: string;
  signal_id: string;
  account_id: string;
  recipient_id: string;
  alert_type: AlertType;
  status: DeliveryStatus;
  attempt_count: number;
  retry_key: string;
  message_text: string;
  last_http_status: number | null;
  last_error_code: string | null;
  last_error_message: string | null;
  next_retry_at: string | null;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
}

// Interim defaults, NOT Owner-frozen -- reported explicitly in the L5
// build report per that task's own §14 instruction. Both are small,
// easily-adjusted operational knobs, not architectural decisions: they
// only affect how long a persistently-failing delivery keeps retrying
// before being marked terminal, never whether the system is correct.
const DELIVERY_MAX_PERSISTED_ATTEMPTS = Number(process.env.DELIVERY_MAX_PERSISTED_ATTEMPTS ?? 8);
const DELIVERY_RETRY_BASE_DELAY_MS = Number(process.env.DELIVERY_RETRY_BASE_DELAY_MS ?? 30_000);

export interface CreateDeliveryInput {
  eventKey: string;
  signalId: string;
  accountId: string;
  recipientId: string;
  alertType: AlertType;
  messageText: string;
}

export type CreateDeliveryOutcome = { created: boolean; row: DeliveryRow };

/**
 * Race-safe idempotent delivery-row creation (brief §1/§3), mirroring
 * insertEventIdempotent()'s own exact pattern in src/lib/db.ts: always
 * attempts the INSERT directly, treats the UNIQUE(event_key, recipient_id,
 * alert_type) constraint violation as a successful "already exists"
 * outcome (never an error), never does SELECT-then-INSERT.
 *
 * On a duplicate: the existing row is returned COMPLETELY UNCHANGED --
 * retry_key is not reset, attempt_count is not reset, a DELIVERED row is
 * never reopened (Owner's own explicit invariants #2/#3/#5).
 */
export function createDeliveryRow(db: Database.Database, input: CreateDeliveryInput): CreateDeliveryOutcome {
  const id = randomUUID();
  const retryKey = randomUUID(); // generated exactly once, at creation (brief §2) -- never regenerated on retry
  const now = new Date().toISOString();

  const insertStmt = db.prepare(`
    INSERT INTO alert_deliveries
      (id, event_key, signal_id, account_id, recipient_id, alert_type, status, attempt_count, retry_key, message_text, created_at, updated_at)
    VALUES (@id, @event_key, @signal_id, @account_id, @recipient_id, @alert_type, 'PENDING', 0, @retry_key, @message_text, @created_at, @updated_at)
  `);
  const selectStmt = db.prepare(`SELECT * FROM alert_deliveries WHERE event_key = ? AND recipient_id = ? AND alert_type = ?`);

  try {
    insertStmt.run({
      id,
      event_key: input.eventKey,
      signal_id: input.signalId,
      account_id: input.accountId,
      recipient_id: input.recipientId,
      alert_type: input.alertType,
      retry_key: retryKey,
      message_text: input.messageText,
      created_at: now,
      updated_at: now,
    });
    const row = selectStmt.get(input.eventKey, input.recipientId, input.alertType) as DeliveryRow;
    logger.info("delivery.created", {
      delivery_id: row.id,
      event_key: row.event_key,
      signal_id: row.signal_id,
      account_id: row.account_id,
      recipient_id: row.recipient_id,
      alert_type: row.alert_type,
    });
    return { created: true, row };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    const isUniqueViolation =
      e?.code === "SQLITE_CONSTRAINT_UNIQUE" ||
      e?.code === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
      /UNIQUE constraint failed/i.test(String(e?.message ?? ""));
    if (isUniqueViolation) {
      const row = selectStmt.get(input.eventKey, input.recipientId, input.alertType) as DeliveryRow | undefined;
      if (row) {
        logger.info("delivery.duplicate", {
          delivery_id: row.id,
          event_key: row.event_key,
          recipient_id: row.recipient_id,
          alert_type: row.alert_type,
          existing_status: row.status,
        });
        return { created: false, row };
      }
    }
    throw err;
  }
}

/**
 * Classifies a sendLineText() result into the L5 delivery status machine.
 * Preserves L3's exact existing retry policy (brief §5) -- this function
 * makes no new retry-vs-permanent decisions LINE itself didn't already
 * signal; it only maps that outcome onto persistent status values.
 */
function classifyOutcome(success: boolean, httpStatus: number | null, errorCode: string | null): DeliveryStatus {
  if (success) return "DELIVERED";
  // Sender-boundary rejections (brief §12/§13/§14 from L3) -- never
  // retryable regardless of network conditions, since retrying would send
  // to the exact same missing config/recipient/message.
  if (errorCode === "CONFIG_MISSING_TOKEN" || errorCode === "RECIPIENT_MISSING" || errorCode === "MESSAGE_EMPTY") {
    return "FAILED_PERMANENT";
  }
  if (httpStatus === 400 || httpStatus === 401 || httpStatus === 403) return "FAILED_PERMANENT";
  if (httpStatus === 429) return "FAILED_RETRYABLE";
  if (httpStatus !== null && httpStatus >= 500) return "FAILED_RETRYABLE";
  if (errorCode === "NETWORK_ERROR" || errorCode === "TIMEOUT") return "FAILED_RETRYABLE";
  // Brief §5's explicit fallback: "unexpected non-retry status -> FAILED_PERMANENT"
  return "FAILED_PERMANENT";
}

/**
 * The delivery execution boundary (brief §4, CORRECTED per Owner's L5
 * attempt-accounting review).
 *
 * CORRECTIVE FIX: attempt_count now tracks REAL OUTBOUND LINE HTTP
 * ATTEMPTS -- not "executeDelivery() invocations" -- and
 * DELIVERY_MAX_PERSISTED_ATTEMPTS is enforced as a hard ceiling on that
 * same real-attempt count, never overshootable in a single call:
 *
 *   1. Before calling sendLineText() at all, the REMAINING budget
 *      (DELIVERY_MAX_PERSISTED_ATTEMPTS - row.attempt_count) is computed.
 *      If it is already <= 0, sendLineText() is never called -- the row
 *      goes straight to FAILED_PERMANENT with zero additional HTTP
 *      attempts (test case #3/#4's exact requirement).
 *   2. Otherwise, sendLineText() is called with an EFFECTIVE maxAttempts
 *      capped to that remaining budget (Owner's Option B) -- so its own
 *      internal bounded retry loop (L3, unchanged in shape) can
 *      structurally never perform more real HTTP calls than the
 *      persistent budget allows, even if LINE_MAX_ATTEMPTS alone would
 *      have allowed more.
 *   3. attempt_count is incremented by result.attempts -- the ACTUAL
 *      number of real HTTP attempts sendLineText() just performed (Owner's
 *      Option A), not a hardcoded +1. A sender-boundary rejection (missing
 *      token/recipient/message) returns attempts: 0, so attempt_count
 *      correctly does not move at all in that case (test case #7).
 *
 * Still never touches signal_events (confirmed by this file having no
 * import of anything from src/lib/db.ts's signal_events-specific
 * functions), still reuses the row's own persistent retry_key unchanged.
 */
export async function executeDelivery(db: Database.Database, row: DeliveryRow, lineConfig: LineSenderConfig): Promise<DeliveryRow> {
  const remainingBudget = DELIVERY_MAX_PERSISTED_ATTEMPTS - row.attempt_count;

  // Budget already exhausted BEFORE this call -- do not perform any real
  // HTTP attempt at all (sendLineText() itself clamps maxAttempts to a
  // minimum of 1, so passing 0 through would still make one overshooting
  // call; the guard belongs here, one level up, not inside the sender).
  if (remainingBudget <= 0) {
    const updatedAt = new Date().toISOString();
    db.prepare(
      `UPDATE alert_deliveries SET status = 'FAILED_PERMANENT', updated_at = ?, next_retry_at = NULL WHERE id = ?`,
    ).run(updatedAt, row.id);
    const updatedRow = db.prepare(`SELECT * FROM alert_deliveries WHERE id = ?`).get(row.id) as DeliveryRow;
    logger.error("delivery.permanent_failure", {
      delivery_id: row.id,
      event_key: row.event_key,
      recipient_id: row.recipient_id,
      alert_type: row.alert_type,
      attempt_count: row.attempt_count,
      reason: "attempts_exhausted",
    });
    return updatedRow;
  }

  const now = new Date().toISOString();
  db.prepare(`UPDATE alert_deliveries SET status = 'SENDING', updated_at = ? WHERE id = ?`).run(now, row.id);

  logger.info("delivery.attempt", {
    delivery_id: row.id,
    event_key: row.event_key,
    recipient_id: row.recipient_id,
    alert_type: row.alert_type,
    attempt_count_before: row.attempt_count,
    remaining_budget: remainingBudget,
  });

  // Option B: cap this call's own internal bounded retry to whatever
  // budget remains -- never derived from LINE_MAX_ATTEMPTS alone.
  const cappedConfig: LineSenderConfig = { ...lineConfig, maxAttempts: Math.min(lineConfig.maxAttempts, remainingBudget) };
  const result = await sendLineText({ recipientId: row.recipient_id, messageText: row.message_text, retryKey: row.retry_key }, cappedConfig);

  // Option A: accurate accounting -- the real number of HTTP attempts
  // just performed, never a hardcoded +1. Structurally guaranteed
  // <= remainingBudget by the cap above, so newAttemptCount can never
  // exceed DELIVERY_MAX_PERSISTED_ATTEMPTS as a direct result of this call.
  const newAttemptCount = row.attempt_count + result.attempts;

  let status = classifyOutcome(result.success, result.httpStatus, result.errorCode);
  let nextRetryAt: string | null = null;
  let exhausted = false;

  if (status === "FAILED_RETRYABLE") {
    if (newAttemptCount >= DELIVERY_MAX_PERSISTED_ATTEMPTS) {
      status = "FAILED_PERMANENT";
      exhausted = true;
    } else {
      // Deterministic linear backoff (brief §6's "computed deterministically"
      // -- no specific shape was frozen, this is an interim, documented
      // choice): base delay x attempt count. Retry-After handling for 429
      // already happened INSIDE sendLineText()'s own bounded retry (L3,
      // unchanged) -- by the time a final 429 reaches this function, that
      // was already exhausted, so a plain backoff is used here.
      nextRetryAt = new Date(Date.now() + DELIVERY_RETRY_BASE_DELAY_MS * newAttemptCount).toISOString();
    }
  }

  const updatedAt = new Date().toISOString();
  const deliveredAt = status === "DELIVERED" ? updatedAt : null;

  db.prepare(
    `UPDATE alert_deliveries
     SET status = @status, attempt_count = @attempt_count, last_http_status = @last_http_status,
         last_error_code = @last_error_code, last_error_message = @last_error_message,
         next_retry_at = @next_retry_at, updated_at = @updated_at, delivered_at = COALESCE(@delivered_at, delivered_at)
     WHERE id = @id`,
  ).run({
    id: row.id,
    status,
    attempt_count: newAttemptCount,
    last_http_status: result.httpStatus,
    last_error_code: result.errorCode,
    last_error_message: result.errorMessage,
    next_retry_at: nextRetryAt,
    updated_at: updatedAt,
    delivered_at: deliveredAt,
  });

  const updatedRow = db.prepare(`SELECT * FROM alert_deliveries WHERE id = ?`).get(row.id) as DeliveryRow;

  const logFields = {
    delivery_id: row.id,
    event_key: row.event_key,
    recipient_id: row.recipient_id,
    alert_type: row.alert_type,
    attempt_count: newAttemptCount,
    attempts_this_call: result.attempts,
    http_status: result.httpStatus,
    error_code: result.errorCode,
  };
  if (status === "DELIVERED") {
    logger.info("delivery.delivered", logFields);
  } else if (status === "FAILED_RETRYABLE") {
    logger.info("delivery.retry_scheduled", { ...logFields, next_retry_at: nextRetryAt });
  } else {
    logger.error("delivery.permanent_failure", { ...logFields, reason: exhausted ? "attempts_exhausted" : "http_permanent" });
  }

  return updatedRow;
}

/**
 * The persistent retry sweep (brief §6): queries only
 * status='FAILED_RETRYABLE' AND next_retry_at <= now, retries each due row
 * in turn (sequentially -- no concurrency control is needed since
 * better-sqlite3 is synchronous within this single process, the same
 * reasoning already established for signal_events' own dedupe in L1).
 * A row not yet due is left completely alone -- confirmed by the WHERE
 * clause itself, not a post-hoc filter.
 */
export async function runDueDeliveries(db: Database.Database, lineConfig: LineSenderConfig): Promise<number> {
  const nowIso = new Date().toISOString();
  const dueRows = db
    .prepare(`SELECT * FROM alert_deliveries WHERE status = 'FAILED_RETRYABLE' AND next_retry_at <= ? ORDER BY next_retry_at ASC`)
    .all(nowIso) as DeliveryRow[];

  for (const row of dueRows) {
    await executeDelivery(db, row, lineConfig);
  }
  return dueRows.length;
}
