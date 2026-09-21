import type { FastifyInstance } from "fastify";
import { checkApiKey } from "../lib/auth.js";
import { sendLineText } from "../line/line-sender.js";
import { loadLineSenderConfig } from "../lib/line-config.js";
import { logger } from "../lib/logger.js";

const DEFAULT_TEST_TEXT = "[wave-signal-gateway] LINE OA test delivery — L3 sender verification.";
const MAX_TEST_TEXT_LENGTH = 500;

export interface LineTestRouteOptions {
  apiKey: string | undefined;
}

/**
 * Development/test-only route (brief §15) to prove LINE OA delivery
 * independently of the ingest pipeline. Protected by the SAME X-API-Key
 * secret the ingest endpoint uses (SIGNAL_EVENT_API_KEY) -- brief §15
 * explicitly allows reusing the existing gate rather than inventing a
 * second one, and a second, purpose-specific secret would be more
 * complexity for no real security benefit at this stage.
 */
export async function lineTestRoute(app: FastifyInstance, opts: LineTestRouteOptions): Promise<void> {
  app.post("/line/test", async (request, reply) => {
    const authResult = checkApiKey(request.headers["x-api-key"], opts.apiKey);
    if (authResult === "unconfigured") {
      logger.error("line_test.service_unavailable");
      return reply.code(503).send({ ok: false, error: "Service unavailable" });
    }
    if (authResult === "unauthorized") {
      logger.warn("line_test.auth_rejected");
      return reply.code(401).send({ ok: false, error: "Unauthorized" });
    }

    const recipientId = process.env.LINE_TEST_RECIPIENT_ID || "";
    if (!recipientId) {
      logger.warn("line_test.no_recipient_configured");
      return reply.code(503).send({ ok: false, error: "LINE_TEST_RECIPIENT_ID not configured" });
    }

    const body = (request.body ?? {}) as { text?: unknown };
    let text = DEFAULT_TEST_TEXT;
    if (typeof body.text === "string" && body.text.length > 0) {
      // Bounded supplied test text (brief §15) -- truncated, never used
      // unbounded, and never allowed to be empty (falls back to default).
      text = body.text.slice(0, MAX_TEST_TEXT_LENGTH);
    }

    const config = loadLineSenderConfig();
    const result = await sendLineText({ recipientId, messageText: text }, config);

    logger.info("line_test.result", {
      success: result.success,
      httpStatus: result.httpStatus,
      errorCode: result.errorCode,
      attempts: result.attempts,
    });

    return reply.code(result.success ? 200 : 502).send({
      ok: result.success,
      httpStatus: result.httpStatus,
      requestId: result.requestId,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      attempts: result.attempts,
    });
  });
}
