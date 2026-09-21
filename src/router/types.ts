/**
 * Alert Router types (L2).
 *
 * The Router is a PURE function: canonical event in, one deterministic
 * decision out. It never writes a database, never calls HTTP, never calls
 * LINE, never mutates the event it was given, never reads live market
 * state, and never re-derives lifecycle/materiality decisions the EA
 * already made (brief §4).
 */

export type AlertType = "A" | "B" | "C";

export interface RouterDecision {
  alertType: AlertType;
  eventType: string;
  eventKey: string;
  signalId: string;
  shouldDeliver: boolean;
  suppressionReason: string | null;
  messageText: string;
}

/**
 * The minimal shape the Router reads from an accepted WAVE_SIGNAL_EVENT_V1
 * payload. Deliberately loose/partial (every field optional except the
 * identity fields L1 already validated) -- the Router must never throw on
 * a missing optional block (brief §18/§28), so its own input type reflects
 * that reality rather than pretending every field is always present.
 */
export interface RouterInputEvent {
  event_type: string;
  event_key: string;
  signal_id: string;
  market?: {
    symbol?: unknown;
    timeframe?: unknown;
  };
  signal?: {
    direction?: unknown;
    pattern?: unknown;
    entry?: unknown;
    tp1?: unknown;
    tp2?: unknown;
    sl?: unknown;
  };
  lifecycle?: {
    reason_codes?: unknown;
    replaced_by_signal_id?: unknown;
    replaces_signal_id?: unknown;
  };
  effect?: {
    category?: unknown;
  };
  // initial_snapshot: only its individual scalar fields (machine_bias,
  // market_structure) are ever read, for one display line each -- reading
  // a named field out of this block for a label is NOT the same as
  // surfacing the raw block, which brief §19 forbids and this Router still
  // never does (no code anywhere serializes this whole object into a
  // message).
  initial_snapshot?: {
    machine_bias?: unknown;
    market_structure?: unknown;
  };
  // Anything else (current_snapshot, routing, meta, source) is
  // intentionally NOT part of this type -- the Router must never read or
  // surface those blocks in a message (brief §19).
  [key: string]: unknown;
}
