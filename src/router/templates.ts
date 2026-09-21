/**
 * Deterministic text templates for Alert A/B/C (L2 brief §5-§16).
 *
 * Rules enforced throughout this file:
 *  - Never throw on a missing optional field (brief §18/§28) -- every field
 *    read goes through the safe getters below, which return a placeholder
 *    "N/A" (a fixed, deterministic policy, brief §5 -- "omit the line or
 *    use a deterministic N/A policy... do not infer values") rather than
 *    throwing or guessing.
 *  - Never surface initial_snapshot/current_snapshot/routing/meta raw
 *    objects, and never dump the full JSON payload (brief §19).
 *  - Never add trading-advice language, profit/guarantee wording, or an
 *    execution command (brief §12/§13/§27, and the broader Contract's own
 *    copy-boundary rule from Phase 06's Alert design).
 */
import type { RouterInputEvent } from "./types.js";

const NA = "N/A";

function getString(value: unknown): string {
  if (value === null || value === undefined) return NA;
  const s = String(value);
  return s.length > 0 ? s : NA;
}

function getNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Deterministic price formatting -- fixed precision, no locale/currency guessing. */
function formatPrice(value: unknown): string {
  const n = getNumber(value);
  return n === null ? NA : n.toFixed(5);
}

/**
 * reason_codes is a canonical array (per WAVE_SIGNAL_EVENT_V1's own
 * lifecycle.reason_codes shape). L2 displays the raw canonical code names
 * as-is -- brief §17 explicitly permits this ("raw canonical codes are
 * acceptable in text if no human-label mapping has been explicitly frozen
 * yet... do not invent semantics beyond the code names").
 */
function formatReasons(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return NA;
  const codes = value.filter((v) => typeof v === "string" && v.length > 0);
  if (codes.length === 0) return NA;
  return codes.map((c) => `- ${c}`).join("\n");
}

function symbol(e: RouterInputEvent): string {
  return getString(e.market?.symbol);
}
function timeframe(e: RouterInputEvent): string {
  return getString(e.market?.timeframe);
}
function direction(e: RouterInputEvent): string {
  return getString(e.signal?.direction);
}
function pattern(e: RouterInputEvent): string {
  return getString(e.signal?.pattern);
}
function effectCategory(e: RouterInputEvent): string {
  return getString(e.effect?.category);
}
function reasons(e: RouterInputEvent): string {
  return formatReasons(e.lifecycle?.reason_codes);
}
function machineBias(e: RouterInputEvent): string {
  return getString(e.initial_snapshot?.machine_bias);
}
function marketStructure(e: RouterInputEvent): string {
  return getString(e.initial_snapshot?.market_structure);
}

// ---------------------------------------------------------------------
// Alert A (brief §5)
// ---------------------------------------------------------------------
export function templateSignalCreated(e: RouterInputEvent): string {
  return [
    "[NEW SIGNAL]",
    "",
    `${symbol(e)} | ${timeframe(e)}`,
    direction(e),
    "",
    `Setup: ${pattern(e)}`,
    "",
    `Entry: ${formatPrice(e.signal?.entry)}`,
    `TP1: ${formatPrice(e.signal?.tp1)}`,
    `TP2: ${formatPrice(e.signal?.tp2)}`,
    `SL: ${formatPrice(e.signal?.sl)}`,
    "",
    `Signal ID: ${getString(e.signal_id)}`,
  ].join("\n");
}

// ---------------------------------------------------------------------
// Alert B (brief §6/§7)
// ---------------------------------------------------------------------
export function templateMarketContextSnapshot(e: RouterInputEvent): string {
  // Bias/Structure are read from initial_snapshot's own named scalar fields
  // (machine_bias / market_structure) -- reading one labeled field out of
  // that block for a single display line is NOT the same as surfacing the
  // raw block, which brief §19 forbids; this Router never serializes the
  // whole initial_snapshot object into a message anywhere. Effect/Reason
  // correctly read N/A: per the WAVE_SIGNAL_EVENT_V1 schema, this event
  // type never actually carries an `effect` block (only
  // MARKET_CONTEXT_UPDATE does) -- the safe getters below are behaving
  // correctly against a genuinely-absent field, not failing.
  return [
    "[MARKET CONTEXT]",
    "",
    `${symbol(e)} | ${timeframe(e)} | ${direction(e)}`,
    "",
    `Structure: ${marketStructure(e)}`,
    `Bias: ${machineBias(e)}`,
    `Effect: ${effectCategory(e)}`,
    `Reason: ${reasons(e)}`,
  ].join("\n");
}

export function templateMarketContextUpdate(e: RouterInputEvent): string {
  return [
    "[MARKET UPDATE]",
    "",
    `${symbol(e)} | ${timeframe(e)} | ${direction(e)}`,
    "",
    `Effect: ${effectCategory(e)}`,
    `Reason: ${reasons(e)}`,
  ].join("\n");
}

// ---------------------------------------------------------------------
// Alert C (brief §8-§16)
// ---------------------------------------------------------------------
export function templateEntryTouched(e: RouterInputEvent): string {
  return ["[ENTRY TOUCHED]", "", `${symbol(e)} | ${direction(e)}`, `Entry ${formatPrice(e.signal?.entry)} reached.`].join("\n");
}

export function templateEntryRetest(e: RouterInputEvent): string {
  return ["[ENTRY RETEST]", "", `${symbol(e)} | ${direction(e)}`, `Entry ${formatPrice(e.signal?.entry)} retested.`].join("\n");
}

export function templateTp1Hit(e: RouterInputEvent): string {
  return ["[TP1 HIT]", "", `${symbol(e)} | ${direction(e)}`, `TP1 ${formatPrice(e.signal?.tp1)} reached.`].join("\n");
}

export function templateTp2Hit(e: RouterInputEvent): string {
  return ["[TP2 HIT]", "", `${symbol(e)} | ${direction(e)}`, `TP2 ${formatPrice(e.signal?.tp2)} reached.`, "Signal completed."].join("\n");
}

export function templateSignalWeakening(e: RouterInputEvent): string {
  return [
    "[SIGNAL WEAKENING]",
    "",
    `${symbol(e)} | ${direction(e)}`,
    "Current market context is weakening the Signal.",
    "",
    `Reason: ${reasons(e)}`,
  ].join("\n");
}

export function templateSignalRecovered(e: RouterInputEvent): string {
  return ["[SIGNAL RECOVERED]", "", `${symbol(e)} | ${direction(e)}`, "Signal conditions recovered to ACTIVE."].join("\n");
}

export function templateSignalInvalidated(e: RouterInputEvent): string {
  return ["[SIGNAL INVALIDATED]", "", `${symbol(e)} | ${direction(e)}`, "Signal invalidated.", "", `Reason: ${reasons(e)}`].join("\n");
}

export function templateSignalExpired(e: RouterInputEvent): string {
  return [
    "[SIGNAL EXPIRED]",
    "",
    `${symbol(e)} | ${direction(e)}`,
    "Signal expired before entry eligibility remained valid.",
  ].join("\n");
}

export function templateSignalReplaced(e: RouterInputEvent): string {
  // Critical (brief §16): this event's OWN signal_id is the OLD (replaced)
  // Signal's id; replaced_by_signal_id (from lifecycle{}) is the NEW one.
  // Never reversed -- read directly, nothing swapped or inferred.
  return [
    "[SIGNAL REPLACED]",
    "",
    `${symbol(e)} | ${direction(e)}`,
    "Previous Signal replaced by a newer Signal.",
    "",
    `Signal ID: ${getString(e.signal_id)}`,
    `Replaced by: ${getString(e.lifecycle?.replaced_by_signal_id)}`,
  ].join("\n");
}
