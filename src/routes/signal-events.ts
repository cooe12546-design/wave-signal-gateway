import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { checkApiKey } from "../lib/auth.js";
import { validateEvent } from "../lib/validation.js";
import { insertEventIdempotent } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { classifyEvent } from "../router/alert-router.js";
import type { RouterInputEvent } from "../router/types.js";
import { loadLineSenderConfig } from "../lib/line-config.js";
import type { LineSenderConfig } from "../line/types.js";
import { resolveRecipients } from "../lib/recipients.js";
import { createDeliveryRow, executeDelivery } from "../lib/deliveries.js";

export interface SignalEventsRouteOptions {
  db: Database.Database;
  apiKey: string | undefined;
  /** Injectable for testing (brief §26/§27's regression + integration QA) -- defaults to env-derived config via loadLineSenderConfig(). */
  lineConfig?: LineSenderConfig;
}

const MAX_ACCOUNT_ID_LENGTH = 200;

/**
 * L4 OWNER AMENDMENT: validates the X-Account-Id header per Owner's exact
 * "Validation V1" spec -- string, trimmed, non-empty, bounded reasonable
 * length, treated as an OPAQUE external id (never parsed, never validated
 * against Trading Insight Pro/Supabase from this standalone gateway).
 */
function extractAccountId(headerValue: string | string[] | undefined): string | null {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_ACCOUNT_ID_LENGTH) return null;
  return trimmed;
}

/**
 * Router+LINE integration (brief §16/§17/§18/§19), deliberately isolated
 * into its own function so its failure boundary is explicit: this is
 * called AFTER the ingest response has already been fully determined by
 * the caller (see below), and nothing this function does or throws can
 * change that already-decided response. It is only ever invoked for a
 * NEWLY inserted (idempotent=false) event (brief §17 -- critical
 * invariant: a deduped retry must never re-invoke the Router or LINE).
 *
 * L4 OWNER AMENDMENT: recipients are now resolved per (accountId,
 * alertType) via resolveRecipients() -- replacing L3's single hardcoded
 * LINE_TEST_RECIPIENT_ID for this PRODUCTION path entirely.
 * LINE_TEST_RECIPIENT_ID is no longer read anywhere in this file; it
 * remains exclusively /line/test's own concern (src/routes/line-test.ts,
 * untouched by this change).
 *
 * L5 OWNER AMENDMENT: each resolved recipient now gets a PERSISTENT
 * delivery row (createDeliveryRow(), idempotent on
 * (event_key, recipient_id, alert_type)) before any LINE call is
 * attempted, and the first attempt is executed inline via
 * executeDelivery() -- giving the normal happy path the exact same
 * immediate-delivery behavior as before L5, while every attempt (this one
 * and any future retry-sweep attempt) is now restart-safe, deduplicated,
 * and auditable. A duplicate /signal-events request still never reaches
 * this function at all (unchanged L3 invariant, the idempotent branch
 * below never calls it) -- AND, as defense in depth, even if it somehow
 * did, createDeliveryRow()'s own UNIQUE constraint would still prevent a
 * second delivery row from ever being created.
 */
async function classifyAndDeliver(payload: unknown, eventKey: string, signalId: string, lineConfig: LineSenderConfig, db: Database.Database, accountId: string): Promise<void> {
  try {
    const decision = classifyEvent(payload as RouterInputEvent);
    if (!decision.shouldDeliver) {
      logger.info("line_delivery.suppressed", {
        event_key: eventKey,
        alert_type: decision.alertType,
        reason: decision.suppressionReason,
      });
      return;
    }

    const recipients = resolveRecipients(db, accountId, decision.alertType);
    if (recipients.length === 0) {
      // Unknown account, disabled subscription, disabled recipient, or
      // that specific alert-type preference off -- all indistinguishable
      // from here by design (resolveRecipients() itself is the single
      // place that distinction is enforced); zero delivery rows, zero
      // LINE sends either way.
      logger.info("line_delivery.no_recipients", {
        event_key: eventKey,
        alert_type: decision.alertType,
        account_id: accountId,
      });
      return;
    }

    for (const recipient of recipients) {
      const { row } = createDeliveryRow(db, {
        eventKey,
        signalId,
        accountId,
        recipientId: recipient.recipientId,
        alertType: decision.alertType,
        messageText: decision.messageText,
      });
      // Only ever execute a freshly-created PENDING row inline here -- a
      // row that already existed (createDeliveryRow's `created: false`
      // branch, e.g. DELIVERED or still-SENDING from a genuinely
      // concurrent attempt) is left completely alone; the retry sweep
      // (runDueDeliveries()) is the only other code path that ever calls
      // executeDelivery(), and only for rows it queried as due.
      if (row.status === "PENDING") {
        await executeDelivery(db, row, lineConfig);
      }
    }
  } catch (err) {
    // Router/Sender/resolver/delivery failure must NEVER propagate to the
    // ingest response -- the event is already safely persisted by the
    // time this function is ever called (brief §16's canonical boundary:
    // event persistence success != LINE delivery success). Logged, not
    // rethrown.
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("line_delivery.unexpected_error", { event_key: eventKey, message: msg });
  }
}

export async function signalEventsRoute(app: FastifyInstance, opts: SignalEventsRouteOptions): Promise<void> {
  const { db, apiKey } = opts;
  const lineConfig = opts.lineConfig ?? loadLineSenderConfig();

  app.post("/signal-events", async (request, reply) => {
    // --- Auth (brief §4) -- checked FIRST, before account id, per Owner's
    // own explicit test matrix ("wrong API key + valid account id ->
    // unauthorized"): X-Account-Id is identity metadata, not
    // authentication, and must never be checked before X-API-Key. ---
    const authResult = checkApiKey(request.headers["x-api-key"], apiKey);
    if (authResult === "unconfigured") {
      logger.error("signal_event.service_unavailable");
      return reply.code(503).send({ ok: false, error: "Service unavailable" });
    }
    if (authResult === "unauthorized") {
      logger.warn("signal_event.auth_rejected");
      return reply.code(401).send({ ok: false, error: "Unauthorized" });
    }

    // --- L4 OWNER AMENDMENT: X-Account-Id required (Missing Header
    // Policy) -- a missing OR malformed/blank header behaves identically
    // (both rejected here, both 400 ACCOUNT_ID_REQUIRED), per Owner's own
    // instruction. Checked before body parsing since it is header-only and
    // independent of the JSON body's own validity. ---
    const accountId = extractAccountId(request.headers["x-account-id"]);
    if (accountId === null) {
      logger.warn("signal_event.account_id_required");
      return reply.code(400).send({ ok: false, error: "ACCOUNT_ID_REQUIRED" });
    }

    // --- Body parsing ---
    // Fastify's default JSON body parser already rejects invalid JSON with a
    // 400 before this handler runs; request.body is a parsed object here.
    const payload: unknown = request.body;
    if (payload === undefined || payload === null || typeof payload !== "object") {
      logger.warn("signal_event.invalid_payload");
      return reply.code(400).send({ ok: false, error: "Invalid JSON payload" });
    }

    // --- Validation (brief §5/§6/§7) ---
    const result = validateEvent(payload);
    if (!result.ok) {
      logger.warn("signal_event.rejected", { reason: result.reason });
      return reply.code(400).send({ ok: false, error: result.reason });
    }
    const event = result.event;

    // --- Idempotent storage (brief §8/§9/§10/§23) ---
    try {
      // account_id is gateway-owned routing metadata persisted ALONGSIDE
      // the event (L4 OWNER AMENDMENT) -- it is never merged into, and
      // never read back out of, payload_json; the raw accepted payload
      // (`payload`, passed below exactly as received) remains byte-for-
      // byte unchanged, per Owner's own explicit "raw payload must remain
      // unchanged" instruction.
      const outcome = insertEventIdempotent(db, event, payload, accountId);
      if (outcome.idempotent) {
        // Critical invariant (L3 brief §17, unchanged by L4): a deduped
        // retry NEVER invokes the Router or LINE again -- confirmed by
        // this branch containing no call to classifyAndDeliver at all.
        logger.info("signal_event.deduped", {
          event_key: event.event_key,
          event_type: event.event_type,
          signal_id: event.signal_id,
        });
        return reply.code(200).send({ ok: true, idempotent: true, event_key: event.event_key });
      }

      logger.info("signal_event.accepted", {
        event_key: event.event_key,
        event_type: event.event_type,
        signal_id: event.signal_id,
        account_id: accountId,
      });

      // Ingest response is already fully determined at this point (brief
      // §16's canonical boundary) -- awaited here (not fire-and-forget)
      // specifically because the EA's own W9 transport sends one Signal
      // Event POST at a time and waits for each response before sending
      // the next (synchronous MQL5 WebRequest), so awaiting here preserves
      // EA-input delivery order (brief §18) for free, without any extra
      // ordering mechanism -- and classifyAndDeliver's own try/catch
      // guarantees nothing it does can change the response below.
      await classifyAndDeliver(payload, event.event_key, event.signal_id, lineConfig, db, accountId);

      return reply.code(200).send({
        ok: true,
        idempotent: false,
        id: outcome.row.id,
        event_key: event.event_key,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("signal_event.storage_error", { event_key: event.event_key, message: msg });
      return reply.code(500).send({ ok: false, error: "Internal error" });
    }
  });
}
