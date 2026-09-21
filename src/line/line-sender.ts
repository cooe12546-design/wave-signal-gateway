/**
 * LINE Messaging API Push Message sender (L3).
 *
 * Official push-message endpoint only (brief §1) -- never LINE Notify,
 * never the notification-message API, never an unofficial SDK. Uses
 * Node's built-in global fetch (brief §22 -- no heavy SDK dependency).
 */
import { randomUUID } from "node:crypto";
import type { LineSenderConfig, SendLineTextParams, SendLineTextResult, LineErrorCode } from "./types.js";

const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parses a Retry-After header per HTTP semantics: either an integer number
 * of seconds, or an HTTP-date. Returns milliseconds, or null if absent/
 * unparseable (brief §10 -- "respect it when valid... otherwise bounded delay").
 */
function parseRetryAfterMs(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const asSeconds = Number(headerValue);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.round(asSeconds * 1000);
  }
  const asDate = Date.parse(headerValue);
  if (!Number.isNaN(asDate)) {
    const deltaMs = asDate - Date.now();
    return deltaMs > 0 ? deltaMs : 0;
  }
  return null;
}

async function safeReadBodySnippet(res: Response): Promise<string | null> {
  try {
    const text = await res.text();
    // Truncated, and never assumed to be secret-free by construction -- LINE
    // error bodies are documented to be plain JSON error descriptions, but
    // this is still capped short and never logged with any request header.
    return text.length > 200 ? text.slice(0, 200) + "..." : text || null;
  } catch {
    return null;
  }
}

/**
 * Sends one text message via the LINE Messaging API push endpoint, with a
 * bounded retry policy and a single, stable X-Line-Retry-Key for the whole
 * invocation (brief §8/§9 -- generated ONCE here, reused for every retry
 * attempt inside this one call; a NEW call to this function always gets a
 * NEW key).
 *
 * RETRY KEY LIMITATION (brief §9, reported explicitly, not glossed over):
 * this retry key lives only in memory for the duration of this single
 * function invocation. If the process restarts mid-retry, the next attempt
 * (from a fresh call, e.g. from L5's future persistent retry queue) would
 * get a NEW retry key -- this module does NOT persist retry identity
 * across restarts. That is explicitly out of scope for L3 (brief §9: "L5
 * may later persist retry identity for restart-safe retries").
 *
 * Retry policy (brief §10, exact):
 *   - 2xx                -> success, no retry
 *   - 400 / 401 / 403     -> permanent failure, NEVER retried
 *   - 429                  -> retried (bounded), honoring Retry-After if
 *                             LINE supplies a valid one, else retryDelayMs
 *   - 5xx                   -> retried (bounded), retryDelayMs
 *   - network error/timeout  -> retried (bounded), retryDelayMs
 *   - any other unexpected status -> treated as permanent (not retried),
 *     to avoid silently retrying a status this policy was never told to
 *     handle
 */
export async function sendLineText(params: SendLineTextParams, config: LineSenderConfig): Promise<SendLineTextResult> {
  const retryKey = randomUUID();
  const fetchFn = config.fetchImpl ?? fetch;

  // --- Sender's own defensive boundary (brief §12/§13/§14) -- the Router
  // normally guarantees these, but the Sender must not trust that blindly.
  if (!config.channelAccessToken) {
    return { success: false, httpStatus: null, requestId: null, retryKey, errorCode: "CONFIG_MISSING_TOKEN", errorMessage: "LINE_CHANNEL_ACCESS_TOKEN not configured", attempts: 0 };
  }
  if (!params.recipientId) {
    return { success: false, httpStatus: null, requestId: null, retryKey, errorCode: "RECIPIENT_MISSING", errorMessage: "recipientId is empty", attempts: 0 };
  }
  if (!params.messageText) {
    return { success: false, httpStatus: null, requestId: null, retryKey, errorCode: "MESSAGE_EMPTY", errorMessage: "messageText is empty", attempts: 0 };
  }

  const maxAttempts = Math.max(1, config.maxAttempts);
  let lastErrorCode: LineErrorCode | null = null;
  let lastErrorMessage: string | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), config.timeoutMs);

    try {
      const res = await fetchFn(LINE_PUSH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${config.channelAccessToken}`,
          "X-Line-Retry-Key": retryKey,
        },
        body: JSON.stringify({ to: params.recipientId, messages: [{ type: "text", text: params.messageText }] }),
        signal: controller.signal,
      });
      clearTimeout(timeoutHandle);

      const requestId = res.headers.get("x-line-request-id");

      if (res.status >= 200 && res.status < 300) {
        return { success: true, httpStatus: res.status, requestId, retryKey, errorCode: null, errorMessage: null, attempts: attempt };
      }

      // Permanent failures -- never retried, regardless of remaining attempts.
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        const snippet = await safeReadBodySnippet(res);
        return {
          success: false,
          httpStatus: res.status,
          requestId,
          retryKey,
          errorCode: "HTTP_ERROR",
          errorMessage: `LINE API returned ${res.status}${snippet ? `: ${snippet}` : ""}`,
          attempts: attempt,
        };
      }

      if (res.status === 429) {
        lastErrorCode = "RATE_LIMITED";
        lastErrorMessage = "LINE API rate limited (429)";
        if (attempt < maxAttempts) {
          const delay = parseRetryAfterMs(res.headers.get("retry-after")) ?? config.retryDelayMs;
          await sleep(delay);
          continue;
        }
        return { success: false, httpStatus: res.status, requestId, retryKey, errorCode: lastErrorCode, errorMessage: lastErrorMessage, attempts: attempt };
      }

      if (res.status >= 500) {
        lastErrorCode = "HTTP_ERROR";
        lastErrorMessage = `LINE API returned ${res.status}`;
        if (attempt < maxAttempts) {
          await sleep(config.retryDelayMs);
          continue;
        }
        return { success: false, httpStatus: res.status, requestId, retryKey, errorCode: lastErrorCode, errorMessage: lastErrorMessage, attempts: attempt };
      }

      // Any other status this policy was not explicitly told to retry --
      // treated as permanent rather than silently retried.
      return {
        success: false,
        httpStatus: res.status,
        requestId,
        retryKey,
        errorCode: "HTTP_ERROR",
        errorMessage: `LINE API returned unexpected status ${res.status}`,
        attempts: attempt,
      };
    } catch (err) {
      clearTimeout(timeoutHandle);
      const isAbort = err instanceof Error && err.name === "AbortError";
      lastErrorCode = isAbort ? "TIMEOUT" : "NETWORK_ERROR";
      lastErrorMessage = isAbort
        ? `LINE request timed out after ${config.timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err);

      if (attempt < maxAttempts) {
        await sleep(config.retryDelayMs);
        continue;
      }
      return { success: false, httpStatus: null, requestId: null, retryKey, errorCode: lastErrorCode, errorMessage: lastErrorMessage, attempts: attempt };
    }
  }

  // Unreachable (the loop always returns on its last iteration), kept only
  // to satisfy TypeScript's control-flow analysis.
  return { success: false, httpStatus: null, requestId: null, retryKey, errorCode: lastErrorCode, errorMessage: lastErrorMessage, attempts: maxAttempts };
}
