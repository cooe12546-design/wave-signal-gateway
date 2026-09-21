/**
 * Full integration self-test: POST /signal-events through the REAL Fastify
 * route (real SQLite, real validation, real classifyEvent(), real
 * sendLineText() call shape) with ONLY the LINE fetch call mocked (brief
 * §24's "regardless of real secrets, test sender behavior with controlled
 * mocked fetch" principle, applied end-to-end through the actual ingest
 * pipeline rather than the Sender in isolation).
 *
 * Run with: npm run test:integration
 */
import Fastify from "fastify";
import { openDatabase } from "./db.js";
import { healthRoute } from "../routes/health.js";
import { signalEventsRoute } from "../routes/signal-events.js";
import type { LineSenderConfig } from "../line/types.js";

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

const SECRET = "integration-test-secret";

function makeEvent(overrides: Record<string, unknown> = {}, seq = 1, eventType = "SIGNAL_CREATED") {
  const signalId = "SIG-XAUUSD-M5-20260920-093000-BUY-001";
  const key = `${signalId}:${eventType}:${seq}`;
  return {
    schema_version: "WAVE_SIGNAL_EVENT_V1",
    event_id: key,
    event_key: key,
    event_type: eventType,
    event_sequence: seq,
    signal_id: signalId,
    market: { symbol: "XAUUSD", timeframe: "M5" },
    signal: { direction: "BUY", pattern: "HH_HL", entry: 2345.6, tp1: 2350, tp2: 2355, sl: 2340 },
    lifecycle: { reason_codes: [], replaced_by_signal_id: null, replaces_signal_id: null },
    ...overrides,
  };
}

function mockLineConfig(onCall: () => void): LineSenderConfig {
  return {
    channelAccessToken: "mock-token",
    maxAttempts: 1,
    retryDelayMs: 5,
    timeoutMs: 2000,
    fetchImpl: (async () => {
      onCall();
      return new Response("{}", { status: 200, headers: { "x-line-request-id": "mock-req" } });
    }) as unknown as typeof fetch,
  };
}

async function buildIntegrationApp(lineCallCounter: { count: number }) {
  const app = Fastify({ logger: false });
  const db = openDatabase(":memory:");
  const lineConfig = mockLineConfig(() => {
    lineCallCounter.count++;
  });
  app.register(healthRoute);
  app.register(signalEventsRoute, { db, apiKey: SECRET, lineConfig, lineTestRecipientId: "U-mock-recipient" });
  await app.ready();
  return { app, db };
}

async function main() {
  console.log("=== wave-signal-gateway full integration self-test ===\n");

  // ---- deliverable event -> exactly one LINE call ----
  {
    const counter = { count: 0 };
    const { app } = await buildIntegrationApp(counter);
    const res = await app.inject({
      method: "POST",
      url: "/signal-events",
      headers: { "x-api-key": SECRET },
      payload: makeEvent({}, 1, "SIGNAL_CREATED"),
    });
    // Give the awaited classifyAndDeliver a moment to have already run --
    // it is awaited inside the handler before the response is sent, so by
    // the time inject() resolves this has already completed synchronously
    // in the async chain; no extra wait should be needed, but this
    // assertion checks the actual outcome either way.
    check("SIGNAL_CREATED ingest -> 200", res.statusCode === 200);
    check("SIGNAL_CREATED (Alert A, shouldDeliver=true) -> exactly one LINE call", counter.count === 1, `got ${counter.count}`);
    await app.close();
  }

  // ---- ENTRY_RETEST -> ZERO LINE calls (brief §19/§25, critical) ----
  {
    const counter = { count: 0 };
    const { app } = await buildIntegrationApp(counter);
    const res = await app.inject({
      method: "POST",
      url: "/signal-events",
      headers: { "x-api-key": SECRET },
      payload: makeEvent({}, 1, "ENTRY_RETEST"),
    });
    check("ENTRY_RETEST ingest -> 200 (still stored)", res.statusCode === 200);
    check("ENTRY_RETEST -> ZERO LINE HTTP calls", counter.count === 0, `got ${counter.count}`);
    await app.close();
  }

  // ---- duplicate event -> Router/LINE invoked ONLY on first insert (brief §17/§26, critical) ----
  {
    const counter = { count: 0 };
    const { app, db } = await buildIntegrationApp(counter);
    const ev = makeEvent({}, 7, "TP1_HIT");

    const r1 = await app.inject({ method: "POST", url: "/signal-events", headers: { "x-api-key": SECRET }, payload: ev });
    const b1 = r1.json();
    check("first POST -> idempotent=false", b1.idempotent === false);
    check("first POST -> LINE called once", counter.count === 1, `got ${counter.count}`);

    const r2 = await app.inject({ method: "POST", url: "/signal-events", headers: { "x-api-key": SECRET }, payload: ev });
    const b2 = r2.json();
    check("retry POST -> idempotent=true", b2.idempotent === true);
    check("retry POST -> LINE call count UNCHANGED (still 1, not re-invoked)", counter.count === 1, `got ${counter.count}`);

    const rowCount = (db.prepare("SELECT COUNT(*) as c FROM signal_events WHERE event_key = ?").get(ev.event_key) as any).c;
    check("still exactly one stored row after retry", rowCount === 1);

    await app.close();
  }

  // ---- ingest success independent of LINE failure (brief §16) ----
  {
    const app = Fastify({ logger: false });
    const db = openDatabase(":memory:");
    const failingLineConfig: LineSenderConfig = {
      channelAccessToken: "mock-token",
      maxAttempts: 1,
      retryDelayMs: 5,
      timeoutMs: 2000,
      fetchImpl: (async () => {
        throw new TypeError("simulated network failure");
      }) as unknown as typeof fetch,
    };
    app.register(healthRoute);
    app.register(signalEventsRoute, { db, apiKey: SECRET, lineConfig: failingLineConfig, lineTestRecipientId: "U-mock-recipient" });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/signal-events",
      headers: { "x-api-key": SECRET },
      payload: makeEvent({}, 1, "SIGNAL_CREATED"),
    });
    const body = res.json();
    check("ingest still returns 200 even though the mocked LINE call fails every attempt", res.statusCode === 200);
    check("ingest response still reports idempotent=false (event genuinely persisted)", body.idempotent === false);

    const row = db.prepare("SELECT * FROM signal_events WHERE event_key = ?").get(makeEvent({}, 1, "SIGNAL_CREATED").event_key);
    check("event row exists in storage despite LINE failure", row !== undefined);

    await app.close();
  }

  // ---- LINE_CHANNEL_ACCESS_TOKEN missing entirely -> ingest still succeeds, no crash ----
  {
    const app = Fastify({ logger: false });
    const db = openDatabase(":memory:");
    const unconfiguredLineConfig: LineSenderConfig = {
      channelAccessToken: undefined,
      maxAttempts: 1,
      retryDelayMs: 5,
      timeoutMs: 2000,
    };
    app.register(healthRoute);
    app.register(signalEventsRoute, { db, apiKey: SECRET, lineConfig: unconfiguredLineConfig });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/signal-events",
      headers: { "x-api-key": SECRET },
      payload: makeEvent({}, 1, "SIGNAL_CREATED"),
    });
    check("ingest succeeds even with LINE entirely unconfigured (no token)", res.statusCode === 200 && res.json().idempotent === false);
    await app.close();
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fail > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Self-test crashed:", err);
  process.exit(1);
});
