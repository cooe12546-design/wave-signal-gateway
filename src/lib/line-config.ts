import type { LineSenderConfig } from "../line/types.js";

/**
 * Builds LineSenderConfig from environment variables, with the brief's own
 * documented defaults (§10: LINE_MAX_ATTEMPTS=3, LINE_RETRY_DELAY_MS=1000).
 * channelAccessToken is intentionally allowed to be undefined here -- the
 * Sender itself (not this loader) is responsible for failing safely when
 * it's missing (brief §12).
 */
export function loadLineSenderConfig(): LineSenderConfig {
  return {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || undefined,
    maxAttempts: Number(process.env.LINE_MAX_ATTEMPTS ?? 3),
    retryDelayMs: Number(process.env.LINE_RETRY_DELAY_MS ?? 1000),
    timeoutMs: Number(process.env.LINE_TIMEOUT_MS ?? 8000),
  };
}
