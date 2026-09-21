/**
 * Alert Router (L2 brief §1-§4). PURE function: one accepted canonical
 * event in, one deterministic RouterDecision out.
 *
 * Explicitly does NONE of: write a database, send HTTP, call LINE, mutate
 * the event, read live market state, recompute A4 materiality, recompute
 * lifecycle, or perform subscription lookup (brief §4). Every one of those
 * concerns belongs to a later stage (L3-L5) or already happened on the EA
 * side (W4/W6/W7 A4 closure) -- this module only transforms.
 */
import type { AlertType, RouterDecision, RouterInputEvent } from "./types.js";
import {
  templateSignalCreated,
  templateMarketContextSnapshot,
  templateMarketContextUpdate,
  templateEntryTouched,
  templateEntryRetest,
  templateTp1Hit,
  templateTp2Hit,
  templateSignalWeakening,
  templateSignalRecovered,
  templateSignalInvalidated,
  templateSignalExpired,
  templateSignalReplaced,
} from "./templates.js";

// Exact frozen mapping (brief §1) -- no event maps to more than one alert
// type; this Record's value type (AlertType) makes a typo/omission a
// compile error rather than a silent runtime gap.
const ALERT_TYPE_MAP: Record<string, AlertType> = {
  SIGNAL_CREATED: "A",
  MARKET_CONTEXT_SNAPSHOT: "B",
  MARKET_CONTEXT_UPDATE: "B",
  ENTRY_TOUCHED: "C",
  ENTRY_RETEST: "C",
  TP1_HIT: "C",
  TP2_HIT: "C",
  SIGNAL_WEAKENING: "C",
  SIGNAL_RECOVERED: "C",
  SIGNAL_INVALIDATED: "C",
  SIGNAL_EXPIRED: "C",
  SIGNAL_REPLACED: "C",
};

// One template function per canonical type -- deliberately a flat map, not
// a chain of if/else, so "every one of the 12 types has exactly one
// template" is visible and checkable at a glance (and exhaustiveness is
// verified by the self-test, brief §26).
const TEMPLATE_MAP: Record<string, (e: RouterInputEvent) => string> = {
  SIGNAL_CREATED: templateSignalCreated,
  MARKET_CONTEXT_SNAPSHOT: templateMarketContextSnapshot,
  MARKET_CONTEXT_UPDATE: templateMarketContextUpdate,
  ENTRY_TOUCHED: templateEntryTouched,
  ENTRY_RETEST: templateEntryRetest,
  TP1_HIT: templateTp1Hit,
  TP2_HIT: templateTp2Hit,
  SIGNAL_WEAKENING: templateSignalWeakening,
  SIGNAL_RECOVERED: templateSignalRecovered,
  SIGNAL_INVALIDATED: templateSignalInvalidated,
  SIGNAL_EXPIRED: templateSignalExpired,
  SIGNAL_REPLACED: templateSignalReplaced,
};

/**
 * Classifies one accepted event into an alert decision.
 *
 * @throws Error if event_type is not one of the 12 canonical types. L1
 * already rejects any unknown event_type before persistence (brief §29:
 * "L1 should reject invalid types before Router. Still make Router fail
 * safely if called incorrectly. No silent fallback classification.") --
 * so this should be unreachable in the normal pipeline, and if it is ever
 * reached anyway, throwing loudly (not guessing an alert type) is the
 * correct "fail safely" behavior for a pure classification function.
 */
export function classifyEvent(event: RouterInputEvent): RouterDecision {
  const alertType = ALERT_TYPE_MAP[event.event_type];
  const template = TEMPLATE_MAP[event.event_type];

  if (!alertType || !template) {
    throw new Error(`Router: unknown event_type "${event.event_type}" -- no classification exists`);
  }

  // ENTRY_RETEST default-suppression (brief §2/§9) -- the ONLY event type
  // with shouldDeliver=false by default in this frozen mapping. The event
  // is still fully classified and given a real message (never discarded),
  // only its delivery flag differs.
  const shouldDeliver = event.event_type !== "ENTRY_RETEST";
  const suppressionReason = shouldDeliver ? null : "ENTRY_RETEST_DEFAULT_OFF";

  return {
    alertType,
    eventType: event.event_type,
    eventKey: event.event_key,
    signalId: event.signal_id,
    shouldDeliver,
    suppressionReason,
    messageText: template(event),
  };
}

/**
 * Classifies a sequence of events IN THE ORDER GIVEN, without reordering,
 * buffering, or merging any of them (brief §21/§22 -- creation-pair order
 * and same-side-replacement order are preserved by simply never touching
 * input order; L1's own event_sequence-ordered storage/retrieval is what
 * actually guarantees the order this function receives).
 */
export function classifyEvents(events: RouterInputEvent[]): RouterDecision[] {
  return events.map(classifyEvent);
}
