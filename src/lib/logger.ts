/**
 * Structured, minimal logger.
 *
 * Hard rule (brief §12/§13): this module — and every caller of it — must
 * never be passed a secret value (SIGNAL_EVENT_API_KEY, the incoming
 * X-API-Key header value, or any future LINE token). There is no
 * redaction/masking logic here on purpose: the discipline is "never pass
 * a secret in", not "try to scrub it on the way out". Every call site in
 * this project was written to only ever pass safe identifiers
 * (event_key, event_type, signal_id, HTTP status, error codes).
 */

type LogFields = Record<string, string | number | boolean | null | undefined>;

function line(level: string, event: string, fields?: LogFields): string {
  const base = { ts: new Date().toISOString(), level, event, ...fields };
  return JSON.stringify(base);
}

export const logger = {
  info(event: string, fields?: LogFields): void {
    console.log(line("info", event, fields));
  },
  warn(event: string, fields?: LogFields): void {
    console.warn(line("warn", event, fields));
  },
  error(event: string, fields?: LogFields): void {
    console.error(line("error", event, fields));
  },
};
