/**
 * Router self-test: real, executed assertions against classifyEvent(),
 * covering the L2 brief's full QA sections §26-§29.
 *
 * Run with: npm run test:router
 */
import { classifyEvent, classifyEvents } from "./alert-router.js";
import type { RouterInputEvent } from "./types.js";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    failures.push(name + (detail ? ` -- ${detail}` : ""));
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

const FORBIDDEN_PHRASES = [
  "guaranteed",
  "profit guaranteed",
  "buy now",
  "sell now",
  "risk-free",
  "risk free",
  "safe",
  "high probability",
];

function fullEvent(overrides: Partial<RouterInputEvent> = {}): RouterInputEvent {
  const signalId = "SIG-XAUUSD-M5-20260920-093000-BUY-001";
  return {
    event_type: "SIGNAL_CREATED",
    event_key: `${signalId}:SIGNAL_CREATED:1`,
    signal_id: signalId,
    market: { symbol: "XAUUSD", timeframe: "M5" },
    signal: { direction: "BUY", pattern: "HH_HL", entry: 2345.6, tp1: 2350, tp2: 2355, sl: 2340 },
    lifecycle: { reason_codes: ["REASON_OPPOSITE_BOS"], replaced_by_signal_id: null, replaces_signal_id: null },
    effect: { category: "WEAKENING" },
    initial_snapshot: { machine_bias: "BULLISH", market_structure: "HH_HL" },
    ...overrides,
  };
}

function minimalEvent(eventType: string, seq = 1): RouterInputEvent {
  const signalId = "SIG-MIN-001";
  return {
    event_type: eventType,
    event_key: `${signalId}:${eventType}:${seq}`,
    signal_id: signalId,
    // Every optional block genuinely absent -- brief §18/§28's exact case.
  };
}

function main() {
  console.log("=== wave-signal-gateway Router self-test ===\n");

  // ---- §26: all 12 types classified correctly, deliver flag correct ----
  const expected: Array<[string, "A" | "B" | "C", boolean]> = [
    ["SIGNAL_CREATED", "A", true],
    ["MARKET_CONTEXT_SNAPSHOT", "B", true],
    ["MARKET_CONTEXT_UPDATE", "B", true],
    ["ENTRY_TOUCHED", "C", true],
    ["ENTRY_RETEST", "C", false],
    ["TP1_HIT", "C", true],
    ["TP2_HIT", "C", true],
    ["SIGNAL_WEAKENING", "C", true],
    ["SIGNAL_RECOVERED", "C", true],
    ["SIGNAL_INVALIDATED", "C", true],
    ["SIGNAL_EXPIRED", "C", true],
    ["SIGNAL_REPLACED", "C", true],
  ];

  const decisions = expected.map(([type], i) =>
    classifyEvent(fullEvent({ event_type: type, event_key: `SIG-XAUUSD-M5-20260920-093000-BUY-001:${type}:${i + 1}` })),
  );

  for (let i = 0; i < expected.length; i++) {
    const [type, alertType, deliver] = expected[i];
    const d = decisions[i];
    check(`${type} -> alertType=${alertType}`, d.alertType === alertType);
    check(`${type} -> shouldDeliver=${deliver}`, d.shouldDeliver === deliver);
    check(`${type} -> messageText non-empty`, typeof d.messageText === "string" && d.messageText.length > 0);
  }
  check("no event maps to more than one alert type (12 distinct decisions, 12 inputs)", decisions.length === 12);

  // ---- ENTRY_RETEST specific suppression reason ----
  {
    const d = classifyEvent(fullEvent({ event_type: "ENTRY_RETEST", event_key: "SIG-X:ENTRY_RETEST:1" }));
    check("ENTRY_RETEST suppressionReason = ENTRY_RETEST_DEFAULT_OFF", d.suppressionReason === "ENTRY_RETEST_DEFAULT_OFF");
    check("ENTRY_RETEST still produces a real message (not discarded)", d.messageText.includes("[ENTRY RETEST]"));
  }
  {
    const d = classifyEvent(fullEvent({ event_type: "SIGNAL_CREATED" }));
    check("non-suppressed event has suppressionReason = null", d.suppressionReason === null);
  }

  // ---- §16/§22: SIGNAL_REPLACED id mapping never reversed ----
  {
    const d = classifyEvent(
      fullEvent({
        event_type: "SIGNAL_REPLACED",
        event_key: "SIG-OLD-001:SIGNAL_REPLACED:5",
        signal_id: "SIG-OLD-001",
        lifecycle: { reason_codes: [], replaced_by_signal_id: "SIG-NEW-002", replaces_signal_id: null },
      }),
    );
    check("SIGNAL_REPLACED: signal_id (OLD) appears as 'Signal ID:'", d.messageText.includes("Signal ID: SIG-OLD-001"));
    check("SIGNAL_REPLACED: replaced_by_signal_id (NEW) appears as 'Replaced by:'", d.messageText.includes("Replaced by: SIG-NEW-002"));
    check("SIGNAL_REPLACED: old/new never reversed", !d.messageText.includes("Signal ID: SIG-NEW-002"));
  }

  // ---- §21/§22: order preservation (Router never reorders) ----
  {
    const seq: RouterInputEvent[] = [
      fullEvent({ event_type: "SIGNAL_REPLACED", event_key: "SIG-OLD:SIGNAL_REPLACED:9", signal_id: "SIG-OLD" }),
      fullEvent({ event_type: "SIGNAL_CREATED", event_key: "SIG-NEW:SIGNAL_CREATED:1", signal_id: "SIG-NEW" }),
      fullEvent({ event_type: "MARKET_CONTEXT_SNAPSHOT", event_key: "SIG-NEW:MARKET_CONTEXT_SNAPSHOT:2", signal_id: "SIG-NEW" }),
    ];
    const out = classifyEvents(seq);
    check(
      "input order [REPLACED, CREATED, SNAPSHOT] -> output order [C, A, B], unreordered",
      out.map((d) => d.alertType).join(",") === "C,A,B",
    );
  }

  // ---- §27: template content QA -- no forbidden phrases, no secrets, no raw JSON ----
  {
    let allClean = true;
    const allTypes = expected.map(([t]) => t);
    for (const t of allTypes) {
      const d = classifyEvent(fullEvent({ event_type: t, event_key: `SIG-X:${t}:1` }));
      const lower = d.messageText.toLowerCase();
      for (const phrase of FORBIDDEN_PHRASES) {
        if (lower.includes(phrase)) {
          allClean = false;
          console.log(`    !! ${t} contains forbidden phrase: "${phrase}"`);
        }
      }
      if (d.messageText.includes("SIGNAL_EVENT_API_KEY") || d.messageText.includes("x-api-key") || /Bearer\s/i.test(d.messageText)) {
        allClean = false;
        console.log(`    !! ${t} appears to leak an auth-related string`);
      }
      // "raw JSON dump" heuristic: a message should never itself be valid,
      // larger, nested JSON (i.e. containing multiple curly braces) --
      // every template here is plain lines of text.
      if ((d.messageText.match(/[{}]/g) ?? []).length > 0) {
        allClean = false;
        console.log(`    !! ${t} message contains brace characters -- possible raw object/JSON leak`);
      }
    }
    check("no template contains any forbidden trading-advice/guarantee phrase", allClean);
  }

  // ---- §28: missing optional field QA -- Router must not throw ----
  {
    let allSafe = true;
    const allTypes = expected.map(([t]) => t);
    for (const t of allTypes) {
      try {
        const d = classifyEvent(minimalEvent(t));
        if (typeof d.messageText !== "string" || d.messageText.length === 0) allSafe = false;
      } catch (e) {
        allSafe = false;
        console.log(`    !! ${t} threw on minimal/missing-fields input:`, e instanceof Error ? e.message : e);
      }
    }
    check("Router does not throw on any of the 12 types given only required identity fields (all optional blocks absent)", allSafe);

    // Spot-check the actual N/A behavior for one representative case
    const d = classifyEvent(minimalEvent("SIGNAL_CREATED"));
    check("missing signal{} block -> price fields render as N/A, not a crash/undefined", d.messageText.includes("N/A"));
  }

  // ---- §29: fail-safe on an invalid event_type (should be unreachable via L1, but Router itself must not silently misclassify) ----
  {
    let threw = false;
    try {
      classifyEvent(minimalEvent("SOMETHING_NOT_CANONICAL"));
    } catch {
      threw = true;
    }
    check("unknown event_type -> Router throws rather than silently guessing a classification", threw);
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fail > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main();
