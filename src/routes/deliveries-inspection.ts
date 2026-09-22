import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { checkApiKey } from "../lib/auth.js";
import { logger } from "../lib/logger.js";

export interface DeliveriesInspectionRouteOptions {
  db: Database.Database;
  apiKey: string | undefined;
}

/**
 * L5 §10 (optional, built since it is minimal and directly useful for QA):
 * GET /deliveries/:eventKey -- read-only inspection of persistent delivery
 * state for one event_key. Same X-API-Key gate as every other production
 * route. No UI, no write operations, nothing public.
 */
export async function deliveriesInspectionRoute(app: FastifyInstance, opts: DeliveriesInspectionRouteOptions): Promise<void> {
  app.get<{ Params: { eventKey: string } }>("/deliveries/:eventKey", async (request, reply) => {
    const authResult = checkApiKey(request.headers["x-api-key"], opts.apiKey);
    if (authResult === "unconfigured") {
      logger.error("deliveries_inspection.service_unavailable");
      return reply.code(503).send({ ok: false, error: "Service unavailable" });
    }
    if (authResult === "unauthorized") {
      logger.warn("deliveries_inspection.auth_rejected");
      return reply.code(401).send({ ok: false, error: "Unauthorized" });
    }

    const eventKey = request.params.eventKey;
    // retry_key deliberately excluded -- treated as sensitive by design
    // (src/lib/deliveries.ts never logs it either), so this explicit
    // column list is used instead of SELECT * on purpose.
    const rows = opts.db
      .prepare(
        `SELECT id, event_key, signal_id, account_id, recipient_id, alert_type, status,
                attempt_count, message_text, last_http_status, last_error_code, last_error_message,
                next_retry_at, created_at, updated_at, delivered_at
         FROM alert_deliveries WHERE event_key = ? ORDER BY created_at ASC`,
      )
      .all(eventKey);

    return reply.code(200).send({ ok: true, event_key: eventKey, deliveries: rows });
  });
}
