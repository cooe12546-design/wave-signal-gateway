import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { checkApiKey } from "../lib/auth.js";
import { validateEvent } from "../lib/validation.js";
import { insertEventIdempotent } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { classifyEvent } from "../router/alert-router.js";
import type { RouterInputEvent } from "../router/types.js";
import { sendLineText } from "../line/line-sender.js";
import { loadLineSenderConfig } from "../lib/line-config.js";
import type { LineSenderConfig } from "../line/types.js";

export interface SignalEventsRouteOptions {
  db: Database.Database;
  apiKey: string | undefined;
  /** Injectable for testing (brief §26/§27's regression + integration QA) -- defaults to env-derived config via loadLineSenderConfig(). */
  lineConfig?: LineSenderConfig;
  /** Injectable for testing -- defaults to process.env.LINE_TEST_RECIPIENT_ID (brief §3). */
  lineTestRecipientId?: string;
}

/**
 * Router+LINE integration (brief §16/§17/§18/§19), deliberately isolated
 * into its own function so its failure boundary is explicit: this is
 * called AFTER the ingest response has already been fully determined by
 * the caller (see below), and nothing this function does or throws can
 * change that already-decided response. It is only ever invoked for a
 * NEWLY inserted (idempotent=false) event (brief §17 -- critical
 * invariant: a deduped retry must never re-invoke the Router or LINE).
 */
async function classifyAndDeliver(payload: unknown, eventKey: string, lineConfig: LineSenderConfig, recipientId: string): Promise<void> {
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
    const result = await sendLineText({ recipientId, messageText: decision.messageText }, lineConfig);
    if (result.success) {
      logger.info("line_delivery.sent", { event_key: eventKey, alert_type: decision.alertType, http_status: result.httpStatus, attempts: result.attempts });
    } else {
      logger.error("line_delivery.failed", {
        event_key: eventKey,
        alert_type: decision.alertType,
        error_code: result.errorCode,
        http_status: result.httpStatus,
        attempts: result.attempts,
      });
    }
  } catch (err) {
    // Router/Sender failure must NEVER propagate to the ingest response --
    // the event is already safely persisted by the time this function is
    // ever called (brief §16's canonical boundary: event persistence
    // success != LINE delivery success). Logged, not rethrown.
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("line_delivery.unexpected_error", { event_key: eventKey, message: msg });
  }
}

export async function signalEventsRoute(app: FastifyInstance, opts: SignalEventsRouteOptions): Promise<void> {
  const { db, apiKey } = opts;
  const lineConfig = opts.lineConfig ?? loadLineSenderConfig();
  const lineTestRecipientId = opts.lineTestRecipientId ?? (process.env.LINE_TEST_RECIPIENT_ID || "");

  app.post("/signal-events", async (request, reply) => {
    // --- Auth (brief §4) ---
    const authResult = checkApiKey(request.headers["x-api-key"], apiKey);
    if (authResult === "unconfigured") {
      logger.error("signal_event.service_unavailable");
      return reply.code(503).send({ ok: false, error: "Service unavailable" });
    }
    if (authResult === "unauthorized") {
      logger.warn("signal_event.auth_rejected");
      return reply.code(401).send({ ok: false, error: "Unauthorized" });
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
      const outcome = insertEventIdempotent(db, event, payload);
      if (outcome.idempotent) {
        // Critical invariant (L3 brief §17): a deduped retry NEVER invokes
        // the Router or LINE again -- confirmed by this branch containing
        // no call to classifyAndDeliver at all.
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
      });

      // Ingest response is already fully determined at this point (brief
      // §16's canonical boundary) -- awaited here (not fire-and-forget)
      // specifically because the EA's own W9 transport sends one Signal
      // Event POST at a time and waits for each response before sending
      // the next (synchronous MQL5 WebRequest), so awaiting here preserves
      // EA-input delivery order (brief §18) for free, without any extra
      // ordering mechanism -- and classifyAndDeliver's own try/catch
      // guarantees nothing it does can change the response below.
      await classifyAndDeliver(payload, event.event_key, lineConfig, lineTestRecipientId);

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

