/**
 * Validation for incoming WAVE_SIGNAL_EVENT_V1 payloads.
 *
 * This module makes NO business decisions about Signal lifecycle — it only
 * confirms the envelope is well-formed and internally consistent, per the
 * L1 brief §5/§6. Every rule here traces to an explicit brief section.
 */

export const SCHEMA_VERSION = "WAVE_SIGNAL_EVENT_V1";

// Frozen 12-type list (brief §5). No aliasing, no extra type — this Set is
// the single source of truth every check in this module reads from.
export const VALID_EVENT_TYPES = new Set([
  "SIGNAL_CREATED",
  "MARKET_CONTEXT_SNAPSHOT",
  "MARKET_CONTEXT_UPDATE",
  "ENTRY_TOUCHED",
  "ENTRY_RETEST",
  "TP1_HIT",
  "TP2_HIT",
  "SIGNAL_WEAKENING",
  "SIGNAL_RECOVERED",
  "SIGNAL_INVALIDATED",
  "SIGNAL_EXPIRED",
  "SIGNAL_REPLACED",
]);

export interface ValidatedEvent {
  event_id: string;
  event_key: string;
  schema_version: string;
  signal_id: string;
  event_type: string;
  event_sequence: number;
  symbol: string | null;
  timeframe: string | null;
  direction: string | null;
}

export type ValidationResult =
  | { ok: true; event: ValidatedEvent }
  | { ok: false; reason: string };

function toText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.length > 0 ? s : null;
}

/**
 * Validates one incoming JSON payload against the L1 brief's identity
 * rules, in the exact order the brief lists them, so a caller can map a
 * failure directly back to the brief section that required it:
 *   §5  schema_version
 *   §5  event_type (12-type allowlist)
 *   §6  non-empty event_id / event_key / signal_id, event_sequence integer >= 1
 *   §6  event_key === "{signal_id}:{event_type}:{event_sequence}"
 *   §6  event_id === event_key
 *   §7  convenience fields (symbol/timeframe/direction) are optional and
 *       never cause rejection on their own — extracted last, after every
 *       identity check has already passed.
 */
export function validateEvent(payload: unknown): ValidationResult {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "Payload must be a JSON object" };
  }
  const d = payload as Record<string, unknown>;

  const schemaVersion = toText(d.schema_version);
  if (schemaVersion !== SCHEMA_VERSION) {
    return { ok: false, reason: "Invalid schema_version" };
  }

  const eventType = toText(d.event_type);
  if (!eventType || !VALID_EVENT_TYPES.has(eventType)) {
    return { ok: false, reason: "Unknown event_type" };
  }

  const eventId = toText(d.event_id);
  const eventKey = toText(d.event_key);
  const signalId = toText(d.signal_id);
  const rawSeq = d.event_sequence;
  const eventSequence =
    typeof rawSeq === "number" && Number.isInteger(rawSeq) ? rawSeq : null;

  if (!eventId || !eventKey || !signalId || eventSequence === null || eventSequence < 1) {
    return { ok: false, reason: "Malformed event identity" };
  }

  const expectedEventKey = `${signalId}:${eventType}:${eventSequence}`;
  if (eventKey !== expectedEventKey) {
    return { ok: false, reason: "event_key does not match expected deterministic format" };
  }

  if (eventId !== eventKey) {
    return { ok: false, reason: "event_id must equal event_key" };
  }

  // Convenience columns only (brief §7) -- read from the canonical blocks
  // where WAVE_SIGNAL_EVENT_V1 places them; absence never fails validation.
  const marketBlock = (d.market ?? {}) as Record<string, unknown>;
  const signalBlock = (d.signal ?? {}) as Record<string, unknown>;
  const symbol = toText(marketBlock.symbol);
  const timeframe = toText(marketBlock.timeframe);
  const direction = toText(signalBlock.direction);

  return {
    ok: true,
    event: {
      event_id: eventId,
      event_key: eventKey,
      schema_version: schemaVersion,
      signal_id: signalId,
      event_type: eventType,
      event_sequence: eventSequence,
      symbol,
      timeframe,
      direction,
    },
  };
}
