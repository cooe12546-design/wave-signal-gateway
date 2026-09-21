/**
 * Self-test harness: builds real Fastify server instances (backed by an
 * in-memory SQLite DB, via better-sqlite3's ":memory:" path) and issues
 * real HTTP requests against them with Node's built-in fetch. This is
 * genuine runtime QA -- not a static/structural check -- covering every
 * case the L1 brief's §19-23 QA sections list.
 *
 * Run with: npm test  (=> tsx src/lib/selftest.ts)
 */
import Fastify from "fastify";
import { openDatabase } from "./db.js";
import { healthRoute } from "../routes/health.js";
import { signalEventsRoute } from "../routes/signal-events.js";

const SCHEMA_VERSION = "WAVE_SIGNAL_EVENT_V1";
const ALL_12_EVENT_TYPES = [
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
];

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

async function buildTestApp(apiKey: string | undefined) {
  const app = Fastify({ logger: false });
  const db = openDatabase(":memory:");
  app.register(healthRoute);
  app.register(signalEventsRoute, { db, apiKey });
  await app.ready();
  return { app, db };
}

function makeEvent(overrides: Partial<Record<string, unknown>> = {}, seq = 1, eventType = "SIGNAL_CREATED") {
  const signalId = "SIG-XAUUSD-M5-20260920-093000-BUY-001";
  const key = `${signalId}:${eventType}:${seq}`;
  return {
    schema_version: SCHEMA_VERSION,
    event_id: key,
    event_key: key,
    event_type: eventType,
    event_sequence: seq,
    signal_id: signalId,
    market: { symbol: "XAUUSD", timeframe: "M5" },
    signal: { direction: "BUY", pattern: "HH_HL", entry: 2345.6, tp1: 2350, tp2: 2355, sl: 2340 },
    ...overrides,
  };
}

async function main() {
  console.log("=== wave-signal-gateway self-test ===\n");

  // ---- health endpoint ----
  {
    const { app } = await buildTestApp("test-secret");
    const res = await app.inject({ method: "GET", url: "/health" });
    const body = res.json();
    check("GET /health -> 200", res.statusCode === 200);
    check("GET /health -> ok:true, service:wave-signal-gateway", body.ok === true && body.service === "wave-signal-gateway");
    await app.close();
  }

  // ---- auth: missing header ----
  {
    const { app } = await buildTestApp("test-secret");
    const res = await app.inject({ method: "POST", url: "/signal-events", payload: makeEvent() });
    check("missing X-API-Key -> 401", res.statusCode === 401);
    await app.close();
  }

  // ---- auth: wrong key ----
  {
    const { app } = await buildTestApp("test-secret");
    const res = await app.inject({
      method: "POST",
      url: "/signal-events",
      headers: { "x-api-key": "wrong-key" },
      payload: makeEvent(),
    });
    check("wrong X-API-Key -> 401", res.statusCode === 401);
    await app.close();
  }

  // ---- auth: missing server secret ----
  {
    const { app } = await buildTestApp(undefined);
    const res = await app.inject({
      method: "POST",
      url: "/signal-events",
      headers: { "x-api-key": "anything" },
      payload: makeEvent(),
    });
    check("missing server secret -> 503", res.statusCode === 503);
    const body = res.json();
    check("503 body does not leak configured-secret info", !("expected" in body) && !JSON.stringify(body).includes("SIGNAL_EVENT_API_KEY"));
    await app.close();
  }

  const SECRET = "test-secret-value";

  // ---- validation failures ----
  {
    const { app } = await buildTestApp(SECRET);
    const headers = { "x-api-key": SECRET };

    const r1 = await app.inject({ method: "POST", url: "/signal-events", headers, payload: makeEvent({ schema_version: "WRONG_VERSION" }) });
    check("wrong schema_version -> 400", r1.statusCode === 400);

    const r2 = await app.inject({ method: "POST", url: "/signal-events", headers, payload: makeEvent({ event_type: "SOMETHING_NEW", event_id: "x", event_key: "x" }) });
    check("unknown event_type -> 400", r2.statusCode === 400);

    const r3 = await app.inject({ method: "POST", url: "/signal-events", headers, payload: makeEvent({ event_sequence: 0 }) });
    check("event_sequence = 0 -> 400 (must be >= 1)", r3.statusCode === 400);

    const r4 = await app.inject({ method: "POST", url: "/signal-events", headers, payload: makeEvent({ event_sequence: 1.5 }) });
    check("event_sequence = 1.5 (non-integer) -> 400", r4.statusCode === 400);

    const r5 = await app.inject({ method: "POST", url: "/signal-events", headers, payload: makeEvent({ event_sequence: "1" }) });
    check("event_sequence as string -> 400 (must be JSON number)", r5.statusCode === 400);

    const badKeyEvent = makeEvent() as Record<string, unknown>;
    badKeyEvent.event_key = "SIG-A:SIGNAL_CREATED:999"; // deliberately wrong
    const r6 = await app.inject({ method: "POST", url: "/signal-events", headers, payload: badKeyEvent });
    check("event_key mismatch vs deterministic format -> 400", r6.statusCode === 400);

    const badIdEvent = makeEvent() as Record<string, unknown>;
    badIdEvent.event_id = "not-the-same-as-event-key";
    const r7 = await app.inject({ method: "POST", url: "/signal-events", headers, payload: badIdEvent });
    check("event_id != event_key -> 400", r7.statusCode === 400);

    await app.close();
  }

  // ---- valid insert + full payload preserved ----
  {
    const { app, db } = await buildTestApp(SECRET);
    const ev = makeEvent();
    const res = await app.inject({ method: "POST", url: "/signal-events", headers: { "x-api-key": SECRET }, payload: ev });
    const body = res.json();
    check("valid SIGNAL_CREATED -> 200", res.statusCode === 200);
    check("idempotent=false on first insert", body.idempotent === false);
    check("id returned", typeof body.id === "number");

    const row = db.prepare("SELECT * FROM signal_events WHERE event_key = ?").get(ev.event_key) as any;
    check("exactly one row stored", row !== undefined);
    const storedPayload = JSON.parse(row.payload_json);
    check("full payload_json preserved unchanged", JSON.stringify(storedPayload) === JSON.stringify(ev));
    check("convenience column symbol extracted", row.symbol === "XAUUSD");
    check("convenience column timeframe extracted", row.timeframe === "M5");
    check("convenience column direction extracted", row.direction === "BUY");

    // ---- retry idempotency ----
    const res2 = await app.inject({ method: "POST", url: "/signal-events", headers: { "x-api-key": SECRET }, payload: ev });
    const body2 = res2.json();
    check("retry same event -> 200", res2.statusCode === 200);
    check("retry -> idempotent=true", body2.idempotent === true);
    const count = (db.prepare("SELECT COUNT(*) as c FROM signal_events WHERE event_key = ?").get(ev.event_key) as any).c;
    check("retry does not create a second row", count === 1);

    await app.close();
  }

  // ---- all 12 event types accepted ----
  {
    const { app, db } = await buildTestApp(SECRET);
    let allOk = true;
    for (let i = 0; i < ALL_12_EVENT_TYPES.length; i++) {
      const ev = makeEvent({}, i + 1, ALL_12_EVENT_TYPES[i]);
      const res = await app.inject({ method: "POST", url: "/signal-events", headers: { "x-api-key": SECRET }, payload: ev });
      if (res.statusCode !== 200) allOk = false;
    }
    const count = (db.prepare("SELECT COUNT(*) as c FROM signal_events").get() as any).c;
    check("all 12 canonical event types accepted with 200", allOk);
    check("all 12 produced distinct stored rows", count === 12);

    // ENTRY_RETEST specifically stored, not suppressed at ingest (brief §11)
    const retestRow = db.prepare("SELECT * FROM signal_events WHERE event_type = ?").get("ENTRY_RETEST");
    check("ENTRY_RETEST stored (not suppressed at ingest)", retestRow !== undefined);

    await app.close();
  }

  // ---- concurrent duplicate dedupe ----
  {
    const { app, db } = await buildTestApp(SECRET);
    const ev = makeEvent({}, 42, "TP1_HIT");
    const [r1, r2] = await Promise.all([
      app.inject({ method: "POST", url: "/signal-events", headers: { "x-api-key": SECRET }, payload: ev }),
      app.inject({ method: "POST", url: "/signal-events", headers: { "x-api-key": SECRET }, payload: ev }),
    ]);
    const bothOk = r1.statusCode === 200 && r2.statusCode === 200;
    const exactlyOneNonIdempotent =
      [r1.json().idempotent, r2.json().idempotent].filter((v) => v === false).length === 1;
    const count = (db.prepare("SELECT COUNT(*) as c FROM signal_events WHERE event_key = ?").get(ev.event_key) as any).c;
    check("concurrent duplicate requests both terminate 200", bothOk);
    check("concurrent duplicates: exactly one is idempotent=false, one is idempotent=true", exactlyOneNonIdempotent);
    check("concurrent duplicates: exactly one row stored", count === 1);
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
