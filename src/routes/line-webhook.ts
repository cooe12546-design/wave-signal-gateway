import type { FastifyInstance } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { logger } from "../lib/logger.js";

/**
 * POST /line/webhook (L3A) — narrow utility endpoint: verify a real LINE
 * Messaging API webhook, extract events[].source.userId, and log it so the
 * Owner can copy it into LINE_TEST_RECIPIENT_ID.
 *
 * Explicitly NOT part of this task (brief §12/§13/§14): no reply message,
 * no push message, no call into the existing LINE Sender, no database
 * write, no classifyEvent()/Router call. Receive-only, log-only.
 */

/**
 * Timing-safe comparison of two signature strings (brief §5's "timing-safe
 * comparison where practical"). node:crypto's timingSafeEqual requires
 * equal-length buffers or it throws -- an attacker-controlled signature of
 * a different length is handled by returning false directly rather than
 * letting that exception escape; comparing the length itself leaks no
 * exploitable information for a fixed-format base64-SHA256 digest.
 */
function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** LINE's required flow (brief §5): HMAC-SHA256(channelSecret, rawBody), then base64. */
function computeLineSignature(channelSecret: string, rawBody: string): string {
  return createHmac("sha256", channelSecret).update(rawBody, "utf8").digest("base64");
}

interface LineWebhookEventSource {
  type?: unknown;
  userId?: unknown;
  groupId?: unknown;
  roomId?: unknown;
}

interface LineWebhookEvent {
  source?: LineWebhookEventSource;
  [key: string]: unknown;
}

/**
 * Processes one already-verified webhook payload's events (brief §8/§9).
 * Pure logging only -- no persistence, no Router, no LINE Sender call.
 */
function logExtractedIdentities(events: unknown[]): void {
  for (const raw of events) {
    const event = raw as LineWebhookEvent;
    const source = event?.source;
    const sourceType = source?.type;

    if (sourceType === "user" && typeof source?.userId === "string" && source.userId.length > 0) {
      // Deliberately logged in full for THIS development-only endpoint --
      // the Owner needs to copy this exact value into LINE_TEST_RECIPIENT_ID
      // (brief §8's own explicit instruction). Not a secret -- a LINE
      // userId is an opaque recipient identifier, not a credential.
      logger.info("LINE_WEBHOOK_USER_ID", { userId: source.userId });
    } else if (sourceType === "group" || sourceType === "room") {
      logger.info("line_webhook.group_or_room_event", {
        source_type: String(sourceType),
        group_id: typeof source?.groupId === "string" ? source.groupId : null,
        room_id: typeof source?.roomId === "string" ? source.roomId : null,
      });
    }
  }
}

export interface LineWebhookRouteOptions {
  /** Injectable for testing -- defaults to process.env.LINE_CHANNEL_SECRET, mirroring every other secret in this codebase's own DI convention. */
  channelSecret?: string;
}

export async function lineWebhookRoute(app: FastifyInstance, opts: LineWebhookRouteOptions = {}): Promise<void> {
  // Scoped content-type parser (brief §3): Fastify plugin encapsulation
  // means this addContentTypeParser call ONLY applies within this
  // plugin's own routes (this file registers exactly one: POST
  // /line/webhook) -- it does NOT replace or affect the default JSON
  // parser used by /signal-events, /line/test, or /health, which are
  // registered as separate plugins in server.ts. parseAs: 'string'
  // captures the exact raw body text with no re-encoding; nothing here
  // JSON.parses it -- that only happens later, after signature
  // verification succeeds (brief §7).
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    done(null, body);
  });

  app.post("/line/webhook", async (request, reply) => {
    const channelSecret = opts.channelSecret ?? process.env.LINE_CHANNEL_SECRET;
    if (!channelSecret) {
      logger.error("line_webhook.service_unavailable");
      return reply.code(503).send({ ok: false, error: "Service unavailable" });
    }

    const signatureHeader = request.headers["x-line-signature"];
    const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
    if (!signature) {
      logger.warn("line_webhook.missing_signature");
      return reply.code(401).send({ ok: false, error: "Missing signature" });
    }

    // request.body is the raw string, per this route's own scoped content-
    // type parser above -- never JSON-parsed by Fastify's default parser,
    // never re-stringified, so the exact bytes LINE signed are the exact
    // bytes verified here (brief §3's explicit requirement).
    const rawBody = request.body as unknown as string;
    if (typeof rawBody !== "string") {
      logger.error("line_webhook.no_raw_body");
      return reply.code(400).send({ ok: false, error: "Invalid request body" });
    }

    const expectedSignature = computeLineSignature(channelSecret, rawBody);
    // Never log `signature` (the raw x-line-signature value) or
    // `expectedSignature` anywhere -- brief §15.
    const valid = timingSafeEqualStrings(signature, expectedSignature);
    if (!valid) {
      logger.warn("line_webhook.invalid_signature");
      return reply.code(401).send({ ok: false, error: "Invalid signature" });
    }

    // Only now, after verification succeeded, parse JSON (brief §7).
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      logger.warn("line_webhook.invalid_json");
      return reply.code(400).send({ ok: false, error: "Invalid JSON" });
    }

    const events = Array.isArray((payload as { events?: unknown })?.events) ? (payload as { events: unknown[] }).events : [];
    // brief §11: LINE's own verification webhook sends events: [] -- this
    // is NOT an error; still processed (as a zero-iteration loop) and
    // still returns 200.
    logExtractedIdentities(events);

    logger.info("line_webhook.verified", { event_count: events.length });
    return reply.code(200).send({ ok: true });
  });
}
