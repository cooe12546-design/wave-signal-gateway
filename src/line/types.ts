/**
 * LINE OA Sender types (L3).
 */

export interface SendLineTextParams {
  recipientId: string;
  messageText: string;
  /**
   * L5 OWNER AMENDMENT: an optional PRE-EXISTING retry key to reuse
   * (persistent, restart-safe delivery rows pass their own stored
   * retry_key here). If omitted, sendLineText() generates a fresh one
   * exactly as before (L3's original ephemeral behavior) -- this keeps
   * /line/test's existing behavior completely unchanged, since it never
   * passes this field.
   */
  retryKey?: string;
}

export interface LineSenderConfig {
  channelAccessToken: string | undefined;
  maxAttempts: number;
  retryDelayMs: number;
  timeoutMs: number;
  /** Injectable for testing (brief §24's mocked HTTP QA) -- defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export type LineErrorCode =
  | "CONFIG_MISSING_TOKEN"
  | "RECIPIENT_MISSING"
  | "MESSAGE_EMPTY"
  | "HTTP_ERROR"
  | "RATE_LIMITED"
  | "NETWORK_ERROR"
  | "TIMEOUT";

/**
 * Result exposes ONLY safe information (brief §4's "safe information only").
 * Never contains the channel access token, the Authorization header, or any
 * raw request/response body beyond a short, generic error message.
 */
export interface SendLineTextResult {
  success: boolean;
  httpStatus: number | null;
  requestId: string | null;
  retryKey: string;
  errorCode: LineErrorCode | null;
  errorMessage: string | null;
  attempts: number;
}
