/**
 * X-API-Key authentication (brief §4).
 *
 * - Missing server-side secret  -> caller must respond 503 (service not
 *   configured) -- this module signals that via a distinct result value
 *   rather than silently treating it as an auth failure, so the route can
 *   pick the correct status code.
 * - Missing/incorrect header    -> caller must respond 401.
 * - The expected secret value is NEVER included in any returned value or
 *   logged from this module -- see src/lib/logger.ts's own discipline note.
 */

export type AuthResult = "ok" | "unconfigured" | "unauthorized";

export function checkApiKey(headerValue: string | undefined | string[], expectedSecret: string | undefined): AuthResult {
  if (!expectedSecret || expectedSecret.length === 0) {
    return "unconfigured";
  }
  const incoming = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!incoming || incoming !== expectedSecret) {
    return "unauthorized";
  }
  return "ok";
}
