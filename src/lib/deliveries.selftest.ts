/**
 * L5 self-test: persistent delivery ledger, retry identity, outcome
 * classification, retry scheduling, genuine restart/reopen behavior, full
 * pipeline integration, and /line/test isolation. Covers Owner's exact
 * test matrix sections A-G from the L5 task.
 *
 * Restart tests use a REAL temporary file-based SQLite database (closed
 * and reopened), not :memory:, so "survives a restart" is genuinely
 * proven rather than assumed.
 *
 * Run with: npm run test:deliveries
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { openDatabase } from "./db.js";
import { healthRoute } from "../routes/health.js";
import { signalEventsRoute } from "../routes/signal-events.js";
import { lineTestRoute } from "../routes/line-test.js";
import { createRecipient, createSubscription } from "./recipients.js";
import { createDeliveryRow, executeDelivery, runDueDeliveries, type DeliveryRow } from "./deliveries.js";
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

function tempDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wsg-l5-")), "test.db");
}

function mockConfig(sequence: Array<Response | Error>): { config: LineSenderConfig; calls: number } {
  let i = 0;
  const state = { calls: 0 };
  const config: LineSenderConfig = {
    channelAccessToken: "mock-token",
    maxAttempts: 1, // L3's own internal bounded retry set to 1 -- L5's OWN persistent retry is what these tests exercise, kept separate from L3's already-proven internal retry (L3's own suite covers that layer)
    retryDelayMs: 5,
    timeoutMs: 2000,
    fetchImpl: (async () => {
      state.calls++;
      const result = sequence[Math.min(i, sequence.length - 1)];
      i++;
      if (result instanceof Error) throw result;
      return result;
    }) as unknown as typeof fetch,
  };
  return { config, calls: state.calls };
}

function makeEvent(overrides: Record<string, unknown> = {}, seq = 1, eventType = "SIGNAL_CREATED", signalId = "SIG-L5-TEST") {
  const key = `${signalId}:${eventType}:${seq}`;
  return {
    schema_version: "WAVE_SIGNAL_EVENT_V1",
    event_id: key,
    event_key: key,
    event_type: eventType,
    event_sequence: seq,
    signal_id: signalId,
    market: { symbol: "XAUUSD", timeframe: "M5" },
    signal: { direction: "BUY", pattern: "HH_HL", entry: 1, tp1: 2, tp2: 3, sl: 4 },
    lifecycle: { reason_codes: [], replaced_by_signal_id: null, replaces_signal_id: null },
    effect: { category: "WEAKENING" },
    ...overrides,
  };
}

async function main() {
  console.log("=== wave-signal-gateway L5 persistent delivery self-test ===\n");

  // =====================================================================
  // Section A: Persistence / dedupe
  // =====================================================================
  {
    const db = openDatabase(":memory:");
    const input = { eventKey: "EK-1", signalId: "SIG-1", accountId: "ACC-1", recipientId: "U-1", alertType: "A" as const, messageText: "hello" };

    const r1 = createDeliveryRow(db, input);
    check("first delivery row created (created=true)", r1.created === true);
    check("row starts PENDING", r1.row.status === "PENDING");
    check("row starts with attempt_count 0", r1.row.attempt_count === 0);

    const r2 = createDeliveryRow(db, input);
    check("duplicate same event/recipient/type -> created=false, same row", r2.created === false && r2.row.id === r1.row.id);
    const count = (db.prepare("SELECT COUNT(*) as c FROM alert_deliveries WHERE event_key = ?").get("EK-1") as any).c;
    check("duplicate insert -> still exactly one row", count === 1);
    check("retry_key unchanged across duplicate insert", r2.row.retry_key === r1.row.retry_key);

    const r3 = createDeliveryRow(db, { ...input, recipientId: "U-2" });
    check("different recipient -> separate row", r3.row.id !== r1.row.id);

    const r4 = createDeliveryRow(db, { ...input, alertType: "B" });
    check("different alert type -> separate row", r4.row.id !== r1.row.id);

    const totalRows = (db.prepare("SELECT COUNT(*) as c FROM alert_deliveries").get() as any).c;
    check("3 distinct logical deliveries produced 3 rows total", totalRows === 3);

    // Delivered row never reset by a subsequent duplicate insert attempt
    db.prepare("UPDATE alert_deliveries SET status = 'DELIVERED', delivered_at = ? WHERE id = ?").run(new Date().toISOString(), r1.row.id);
    const r5 = createDeliveryRow(db, input);
    check("delivered row never reset by duplicate insert (created=false)", r5.created === false);
    check("delivered row status remains DELIVERED after duplicate insert attempt", r5.row.status === "DELIVERED");
  }

  // =====================================================================
  // Section B: Retry identity
  // =====================================================================
  {
    const db = openDatabase(":memory:");
    const { config } = mockConfig([new Response("{}", { status: 500 }), new Response("{}", { status: 500 })]);
    const { row } = createDeliveryRow(db, { eventKey: "EK-B", signalId: "SIG-B", accountId: "ACC-B", recipientId: "U-B", alertType: "A", messageText: "hi" });
    const firstRetryKey = row.retry_key;

    const afterFirst = await executeDelivery(db, row, config);
    check("first attempt persists the SAME retry_key it was created with", afterFirst.retry_key === firstRetryKey);
    check("first attempt (500) -> FAILED_RETRYABLE", afterFirst.status === "FAILED_RETRYABLE");

    const afterSecond = await executeDelivery(db, afterFirst, config);
    check("second attempt after failure -> SAME retry_key reused (not regenerated)", afterSecond.retry_key === firstRetryKey);

    // "Restart" simulation: reload the row fresh from the DB (as a real
    // restarted process would) and confirm the retry_key read back is
    // identical -- the DB row IS the persistence, so this proves it.
    const reloaded = db.prepare("SELECT * FROM alert_deliveries WHERE id = ?").get(row.id) as DeliveryRow;
    check("row reloaded fresh from DB (restart simulation) -> same retry_key", reloaded.retry_key === firstRetryKey);
  }

  // =====================================================================
  // Section C: Outcome classification (each a fresh delivery row)
  // =====================================================================
  {
    const db = openDatabase(":memory:");
    async function classifyCase(name: string, seq: Array<Response | Error>, expectedStatus: string) {
      const { config } = mockConfig(seq);
      const { row } = createDeliveryRow(db, { eventKey: `EK-C-${name}`, signalId: "SIG-C", accountId: "ACC-C", recipientId: "U-C", alertType: "A", messageText: "hi" });
      const after = await executeDelivery(db, row, config);
      check(`${name} -> ${expectedStatus}`, after.status === expectedStatus, `got ${after.status}`);
    }
    await classifyCase("200", [new Response("{}", { status: 200 })], "DELIVERED");
    await classifyCase("400", [new Response("{}", { status: 400 })], "FAILED_PERMANENT");
    await classifyCase("401", [new Response("{}", { status: 401 })], "FAILED_PERMANENT");
    await classifyCase("403", [new Response("{}", { status: 403 })], "FAILED_PERMANENT");
    await classifyCase("429", [new Response("{}", { status: 429 })], "FAILED_RETRYABLE");
    await classifyCase("500", [new Response("{}", { status: 500 })], "FAILED_RETRYABLE");
    await classifyCase("network-error", [new TypeError("simulated network failure")], "FAILED_RETRYABLE");
    // timeout: config.timeoutMs so small the fetch never resolves in time
    {
      const config: LineSenderConfig = {
        channelAccessToken: "mock-token",
        maxAttempts: 1,
        retryDelayMs: 5,
        timeoutMs: 20,
        fetchImpl: ((_url: any, init: any) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              const e = new Error("aborted");
              e.name = "AbortError";
              reject(e);
            });
          })) as unknown as typeof fetch,
      };
      const { row } = createDeliveryRow(db, { eventKey: "EK-C-timeout", signalId: "SIG-C", accountId: "ACC-C", recipientId: "U-C", alertType: "A", messageText: "hi" });
      const after = await executeDelivery(db, row, config);
      check("timeout -> FAILED_RETRYABLE", after.status === "FAILED_RETRYABLE", `got ${after.status}`);
    }
  }

  // =====================================================================
  // Section D: Retry scheduling
  // =====================================================================
  {
    const db = openDatabase(":memory:");
    const { config } = mockConfig([new Response("{}", { status: 500 })]);
    const { row } = createDeliveryRow(db, { eventKey: "EK-D", signalId: "SIG-D", accountId: "ACC-D", recipientId: "U-D", alertType: "A", messageText: "hi" });
    const afterFail = await executeDelivery(db, row, config);
    check("retryable row receives a non-null next_retry_at", afterFail.next_retry_at !== null);
    check("next_retry_at is in the future relative to now", new Date(afterFail.next_retry_at as string).getTime() > Date.now());

    // Not due yet -- sweep should not touch it
    const { config: sweepConfig1 } = mockConfig([new Response("{}", { status: 200 })]);
    const notDueCount = await runDueDeliveries(db, sweepConfig1);
    check("not-due row -> sweep processes zero rows", notDueCount === 0);
    const stillRetryable = db.prepare("SELECT status FROM alert_deliveries WHERE id = ?").get(row.id) as any;
    check("not-due row status unchanged by sweep", stillRetryable.status === "FAILED_RETRYABLE");

    // Force it due (backdate next_retry_at) and sweep again -- should retry and succeed
    db.prepare("UPDATE alert_deliveries SET next_retry_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), row.id);
    const { config: sweepConfig2 } = mockConfig([new Response("{}", { status: 200 })]);
    const dueCount = await runDueDeliveries(db, sweepConfig2);
    check("due row -> sweep processes exactly one row", dueCount === 1);
    const afterSweep = db.prepare("SELECT * FROM alert_deliveries WHERE id = ?").get(row.id) as DeliveryRow;
    check("success on retry -> DELIVERED", afterSweep.status === "DELIVERED");

    // Bounded attempts: force many consecutive 500s past the max
    const { config: exhaustConfig } = mockConfig(Array(20).fill(new Response("{}", { status: 500 })));
    const { row: row2 } = createDeliveryRow(db, { eventKey: "EK-D2", signalId: "SIG-D2", accountId: "ACC-D2", recipientId: "U-D2", alertType: "A", messageText: "hi" });
    let current = row2;
    for (let i = 0; i < 10; i++) {
      current = await executeDelivery(db, current, exhaustConfig);
      if (current.status === "FAILED_PERMANENT") break;
    }
    check("bounded persisted attempts respected -> eventually FAILED_PERMANENT (attempts exhausted), not infinite retry", current.status === "FAILED_PERMANENT");
  }

  // =====================================================================
  // Section E: Restart behavior -- REAL file-based DB, closed and reopened
  // =====================================================================
  {
    const dbPath = tempDbPath();
    let db = openDatabase(dbPath);

    const { config: cfgFail } = mockConfig([new Response("{}", { status: 500 })]);
    const { row: retryableRow } = createDeliveryRow(db, { eventKey: "EK-E-retryable", signalId: "SIG-E", accountId: "ACC-E", recipientId: "U-E1", alertType: "A", messageText: "hi" });
    await executeDelivery(db, retryableRow, cfgFail);

    const { config: cfgOk } = mockConfig([new Response("{}", { status: 200 })]);
    const { row: deliveredRow } = createDeliveryRow(db, { eventKey: "EK-E-delivered", signalId: "SIG-E", accountId: "ACC-E", recipientId: "U-E2", alertType: "A", messageText: "hi" });
    await executeDelivery(db, deliveredRow, cfgOk);

    // Simulate a stale SENDING row (process crashed mid-attempt): insert
    // directly, mark SENDING, backdate updated_at past the stale threshold.
    const { row: staleRow } = createDeliveryRow(db, { eventKey: "EK-E-stale", signalId: "SIG-E", accountId: "ACC-E", recipientId: "U-E3", alertType: "A", messageText: "hi" });
    const longAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago, past the 5-min default threshold
    db.prepare("UPDATE alert_deliveries SET status = 'SENDING', updated_at = ? WHERE id = ?").run(longAgo, staleRow.id);

    db.close(); // genuine close

    // Genuine reopen -- a new Database handle on the same file, exactly
    // what a real process restart does.
    db = openDatabase(dbPath);

    const reopenedRetryable = db.prepare("SELECT * FROM alert_deliveries WHERE id = ?").get(retryableRow.id) as DeliveryRow;
    check("persistent row survives a genuine DB close+reopen", reopenedRetryable !== undefined);
    check("failed_retryable row remains retryable after reopen", reopenedRetryable.status === "FAILED_RETRYABLE");

    const reopenedDelivered = db.prepare("SELECT * FROM alert_deliveries WHERE id = ?").get(deliveredRow.id) as DeliveryRow;
    check("delivered row stays DELIVERED after reopen", reopenedDelivered.status === "DELIVERED");

    const reopenedStale = db.prepare("SELECT * FROM alert_deliveries WHERE id = ?").get(staleRow.id) as DeliveryRow;
    check("stale SENDING row recovered to FAILED_RETRYABLE on reopen (openDatabase's own startup recovery)", reopenedStale.status === "FAILED_RETRYABLE");
    check("recovered stale row has a due next_retry_at (immediately retryable)", reopenedStale.next_retry_at !== null && new Date(reopenedStale.next_retry_at as string).getTime() <= Date.now() + 1000);

    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }

  // =====================================================================
  // Section F: Full pipeline (through the real HTTP route)
  // =====================================================================
  {
    const app = Fastify({ logger: false });
    const db = openDatabase(":memory:");
    const { config: lineConfig } = mockConfig([
      new Response("{}", { status: 200 }),
      new Response("{}", { status: 200 }),
      new Response("{}", { status: 200 }),
    ]);
    const recA = createRecipient(db, { lineUserId: "U-pipe-A" });
    createSubscription(db, { accountId: "ACC-PIPE", recipientId: recA });
    const recB = createRecipient(db, { lineUserId: "U-pipe-B" });
    createSubscription(db, { accountId: "ACC-PIPE", recipientId: recB });

    app.register(healthRoute);
    app.register(signalEventsRoute, { db, apiKey: "SEC", lineConfig });
    await app.ready();

    await app.inject({
      method: "POST",
      url: "/signal-events",
      headers: { "x-api-key": "SEC", "x-account-id": "ACC-PIPE" },
      payload: makeEvent({}, 1, "SIGNAL_CREATED", "SIG-F1"),
    });
    const rowsForF1 = db.prepare("SELECT * FROM alert_deliveries WHERE event_key = ?").all("SIG-F1:SIGNAL_CREATED:1") as DeliveryRow[];
    check("SIGNAL_CREATED with 2 resolved recipients -> exactly 2 delivery rows created", rowsForF1.length === 2);
    check("both delivery rows DELIVERED", rowsForF1.every((r) => r.status === "DELIVERED"));
    check("both rows are Alert A", rowsForF1.every((r) => r.alert_type === "A"));

    await app.inject({
      method: "POST",
      url: "/signal-events",
      headers: { "x-api-key": "SEC", "x-account-id": "ACC-PIPE" },
      payload: makeEvent({}, 2, "MARKET_CONTEXT_SNAPSHOT", "SIG-F1"),
    });
    const rowsForSnapshot = db.prepare("SELECT * FROM alert_deliveries WHERE event_key = ?").all("SIG-F1:MARKET_CONTEXT_SNAPSHOT:2") as DeliveryRow[];
    check("MARKET_CONTEXT_SNAPSHOT -> delivery rows created with alert_type B", rowsForSnapshot.length === 2 && rowsForSnapshot.every((r) => r.alert_type === "B"));

    await app.inject({
      method: "POST",
      url: "/signal-events",
      headers: { "x-api-key": "SEC", "x-account-id": "ACC-PIPE" },
      payload: makeEvent({}, 3, "TP1_HIT", "SIG-F1"),
    });
    const rowsForLifecycle = db.prepare("SELECT * FROM alert_deliveries WHERE event_key = ?").all("SIG-F1:TP1_HIT:3") as DeliveryRow[];
    check("TP1_HIT (lifecycle) -> delivery rows created with alert_type C", rowsForLifecycle.length === 2 && rowsForLifecycle.every((r) => r.alert_type === "C"));

    await app.inject({
      method: "POST",
      url: "/signal-events",
      headers: { "x-api-key": "SEC", "x-account-id": "ACC-PIPE" },
      payload: makeEvent({}, 4, "ENTRY_RETEST", "SIG-F1"),
    });
    const rowsForRetest = db.prepare("SELECT * FROM alert_deliveries WHERE event_key = ?").all("SIG-F1:ENTRY_RETEST:4") as DeliveryRow[];
    check("ENTRY_RETEST -> ZERO delivery rows", rowsForRetest.length === 0);

    // duplicate event -> zero duplicate delivery rows
    const dupEvent = makeEvent({}, 5, "TP2_HIT", "SIG-F1");
    await app.inject({ method: "POST", url: "/signal-events", headers: { "x-api-key": "SEC", "x-account-id": "ACC-PIPE" }, payload: dupEvent });
    const countAfterFirst = (db.prepare("SELECT COUNT(*) as c FROM alert_deliveries WHERE event_key = ?").get(dupEvent.event_key) as any).c;
    await app.inject({ method: "POST", url: "/signal-events", headers: { "x-api-key": "SEC", "x-account-id": "ACC-PIPE" }, payload: dupEvent });
    const countAfterRetry = (db.prepare("SELECT COUNT(*) as c FROM alert_deliveries WHERE event_key = ?").get(dupEvent.event_key) as any).c;
    check("duplicate signal event -> zero additional delivery rows on retry", countAfterFirst === countAfterRetry);

    // unknown account -> zero delivery rows
    await app.inject({
      method: "POST",
      url: "/signal-events",
      headers: { "x-api-key": "SEC", "x-account-id": "ACC-NEVER-SEEN" },
      payload: makeEvent({}, 1, "SIGNAL_CREATED", "SIG-F-UNKNOWN"),
    });
    const unknownRows = db.prepare("SELECT * FROM alert_deliveries WHERE event_key = ?").all("SIG-F-UNKNOWN:SIGNAL_CREATED:1");
    check("unknown account -> ZERO delivery rows", unknownRows.length === 0);

    // disabled subscription -> zero delivery rows
    const recDisabled = createRecipient(db, { lineUserId: "U-disabled" });
    createSubscription(db, { accountId: "ACC-DISABLED", recipientId: recDisabled, enabled: false });
    await app.inject({
      method: "POST",
      url: "/signal-events",
      headers: { "x-api-key": "SEC", "x-account-id": "ACC-DISABLED" },
      payload: makeEvent({}, 1, "SIGNAL_CREATED", "SIG-F-DISABLED"),
    });
    const disabledRows = db.prepare("SELECT * FROM alert_deliveries WHERE event_key = ?").all("SIG-F-DISABLED:SIGNAL_CREATED:1");
    check("disabled subscription -> ZERO delivery rows", disabledRows.length === 0);

    await app.close();
  }

  // ---- LINE failure does not undo signal event persistence ----
  {
    const app = Fastify({ logger: false });
    const db = openDatabase(":memory:");
    const { config: failConfig } = mockConfig([new TypeError("boom")]);
    const rec = createRecipient(db, { lineUserId: "U-fail" });
    createSubscription(db, { accountId: "ACC-FAIL", recipientId: rec });
    app.register(healthRoute);
    app.register(signalEventsRoute, { db, apiKey: "SEC", lineConfig: failConfig });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/signal-events",
      headers: { "x-api-key": "SEC", "x-account-id": "ACC-FAIL" },
      payload: makeEvent({}, 1, "SIGNAL_CREATED", "SIG-F-FAIL"),
    });
    check("LINE failure -> ingest still 200", res.statusCode === 200);
    const eventRow = db.prepare("SELECT * FROM signal_events WHERE event_key = ?").get("SIG-F-FAIL:SIGNAL_CREATED:1");
    check("signal event persistence NOT undone by LINE failure", eventRow !== undefined);
    const deliveryRow = db.prepare("SELECT * FROM alert_deliveries WHERE event_key = ?").get("SIG-F-FAIL:SIGNAL_CREATED:1") as DeliveryRow;
    check("delivery row still created and marked FAILED_RETRYABLE despite LINE failure", deliveryRow !== undefined && deliveryRow.status === "FAILED_RETRYABLE");

    await app.close();
  }

  // =====================================================================
  // Section G: Isolation
  // =====================================================================
  {
    const app = Fastify({ logger: false });
    app.register(healthRoute);
    app.register(lineTestRoute, { apiKey: "SEC" });
    await app.ready();

    const lineTestSource = fs.readFileSync(new URL("../routes/line-test.ts", import.meta.url), "utf8");
    check("/line/test source never imports the L5 deliveries module (structural isolation)", !lineTestSource.includes("deliveries.js") && !lineTestSource.includes("createDeliveryRow") && !lineTestSource.includes("executeDelivery"));
    check("/line/test source never references alert_deliveries", !lineTestSource.includes("alert_deliveries"));

    // /line/test still calls sendLineText WITHOUT a retryKey param -- confirmed structurally (source never sets retryKey)
    check("/line/test source never passes a persistent retryKey (still ephemeral per-call, as before L5)", !lineTestSource.includes("retryKey"));

    await app.close();
  }

  // ---- GET /deliveries/:eventKey never exposes retry_key ----
  {
    const { deliveriesInspectionRoute } = await import("../routes/deliveries-inspection.js");
    const app = Fastify({ logger: false });
    const db = openDatabase(":memory:");
    createDeliveryRow(db, { eventKey: "EK-INSPECT", signalId: "SIG-INSPECT", accountId: "ACC-INSPECT", recipientId: "U-INSPECT", alertType: "A", messageText: "hi" });
    app.register(deliveriesInspectionRoute, { db, apiKey: "SEC" });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/deliveries/EK-INSPECT", headers: { "x-api-key": "SEC" } });
    const body = res.json();
    check("GET /deliveries/:eventKey -> 200", res.statusCode === 200);
    check("GET /deliveries/:eventKey -> returns the delivery row", body.deliveries.length === 1);
    check("GET /deliveries/:eventKey response never includes retry_key", !JSON.stringify(body).includes("retry_key") && !("retry_key" in body.deliveries[0]));

    const unauthRes = await app.inject({ method: "GET", url: "/deliveries/EK-INSPECT" });
    check("GET /deliveries/:eventKey without X-API-Key -> 401", unauthRes.statusCode === 401);

    await app.close();
  }

  // =====================================================================
  // Section H: CORRECTIVE — real outbound HTTP attempt accounting
  // (Owner's L5 corrective task: attempt_count must equal ACTUAL real LINE
  // HTTP attempts, not executeDelivery() invocations, and
  // DELIVERY_MAX_PERSISTED_ATTEMPTS (frozen = 8) must be a hard ceiling on
  // that same real-attempt count, never overshootable in a single call.)
  // =====================================================================
  {
    // ---- 1. 500 x3 within ONE sendLineText invocation -> attempt_count += 3 ----
    {
      const db = openDatabase(":memory:");
      const { config } = mockConfig([new Response("{}", { status: 500 }), new Response("{}", { status: 500 }), new Response("{}", { status: 500 })]);
      config.maxAttempts = 3; // sendLineText's OWN internal bounded retry, unchanged L3 shape
      const { row } = createDeliveryRow(db, { eventKey: "EK-H1", signalId: "SIG-H1", accountId: "ACC-H1", recipientId: "U-H1", alertType: "A", messageText: "hi" });
      const after = await executeDelivery(db, row, config);
      check("500x3 in one invocation -> attempt_count increases by 3 (not 1)", after.attempt_count === 3, `got ${after.attempt_count}`);
    }

    // ---- 2. network error x2 then success (within one invocation) -> attempt_count += 3 ----
    {
      const db = openDatabase(":memory:");
      const { config } = mockConfig([new TypeError("boom"), new TypeError("boom"), new Response("{}", { status: 200 })]);
      config.maxAttempts = 3;
      const { row } = createDeliveryRow(db, { eventKey: "EK-H2", signalId: "SIG-H2", accountId: "ACC-H2", recipientId: "U-H2", alertType: "A", messageText: "hi" });
      const after = await executeDelivery(db, row, config);
      check("network error x2 then success in one invocation -> attempt_count increases by 3", after.attempt_count === 3, `got ${after.attempt_count}`);
      check("...and status is DELIVERED (the eventual success)", after.status === "DELIVERED");
    }

    // ---- 3. attempt_count already 7, max=8 -> AT MOST 1 real HTTP request, never 2 or 3 ----
    {
      const db = openDatabase(":memory:");
      const { row } = createDeliveryRow(db, { eventKey: "EK-H3", signalId: "SIG-H3", accountId: "ACC-H3", recipientId: "U-H3", alertType: "A", messageText: "hi" });
      db.prepare("UPDATE alert_deliveries SET attempt_count = 7 WHERE id = ?").run(row.id);
      const preRow = db.prepare("SELECT * FROM alert_deliveries WHERE id = ?").get(row.id) as DeliveryRow;

      // Even though this config would normally allow 3 real internal
      // attempts, and every one of them would fail (500), the remaining
      // persistent budget is only 1 (8 - 7) -- executeDelivery MUST cap
      // sendLineText's own effective maxAttempts to 1, so the mocked
      // fetch must be called exactly once, never 2 or 3 times.
      const { config, calls: _unused } = mockConfig([new Response("{}", { status: 500 }), new Response("{}", { status: 500 }), new Response("{}", { status: 500 })]);
      config.maxAttempts = 3;
      let realCallCount = 0;
      config.fetchImpl = (async () => {
        realCallCount++;
        return new Response("{}", { status: 500 });
      }) as unknown as typeof fetch;

      const after = await executeDelivery(db, preRow, config);
      check("attempt_count=7, max=8 -> exactly ONE real HTTP request made (never 2 or 3)", realCallCount === 1, `got ${realCallCount}`);
      check("...resulting attempt_count is exactly 8 (7 + 1, budget-capped)", after.attempt_count === 8, `got ${after.attempt_count}`);
    }

    // ---- 4. attempt_count reaches 8 on a retryable failure -> FAILED_PERMANENT ----
    {
      const db = openDatabase(":memory:");
      const { row } = createDeliveryRow(db, { eventKey: "EK-H4", signalId: "SIG-H4", accountId: "ACC-H4", recipientId: "U-H4", alertType: "A", messageText: "hi" });
      db.prepare("UPDATE alert_deliveries SET attempt_count = 7 WHERE id = ?").run(row.id);
      const preRow = db.prepare("SELECT * FROM alert_deliveries WHERE id = ?").get(row.id) as DeliveryRow;
      const { config } = mockConfig([new Response("{}", { status: 500 })]);
      const after = await executeDelivery(db, preRow, config);
      check("attempt_count reaching 8 (the frozen max) on a retryable failure -> FAILED_PERMANENT", after.status === "FAILED_PERMANENT" && after.attempt_count === 8);
    }

    // ---- 4b. budget already exhausted BEFORE this call (attempt_count=8) -> zero further HTTP attempts, straight to FAILED_PERMANENT ----
    {
      const db = openDatabase(":memory:");
      const { row } = createDeliveryRow(db, { eventKey: "EK-H4B", signalId: "SIG-H4B", accountId: "ACC-H4B", recipientId: "U-H4B", alertType: "A", messageText: "hi" });
      db.prepare("UPDATE alert_deliveries SET attempt_count = 8, status = 'FAILED_RETRYABLE', next_retry_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), row.id);
      const preRow = db.prepare("SELECT * FROM alert_deliveries WHERE id = ?").get(row.id) as DeliveryRow;
      let realCallCount = 0;
      const config: LineSenderConfig = {
        channelAccessToken: "mock-token",
        maxAttempts: 3,
        retryDelayMs: 5,
        timeoutMs: 2000,
        fetchImpl: (async () => {
          realCallCount++;
          return new Response("{}", { status: 200 });
        }) as unknown as typeof fetch,
      };
      const after = await executeDelivery(db, preRow, config);
      check("budget already exhausted (attempt_count=8) -> ZERO further HTTP attempts", realCallCount === 0, `got ${realCallCount}`);
      check("...status is FAILED_PERMANENT, attempt_count unchanged at 8", after.status === "FAILED_PERMANENT" && after.attempt_count === 8);
    }

    // ---- 5. restart: stored attempt_count remains authoritative, remaining budget preserved ----
    {
      const dbPath = tempDbPath();
      let db = openDatabase(dbPath);
      const { row } = createDeliveryRow(db, { eventKey: "EK-H5", signalId: "SIG-H5", accountId: "ACC-H5", recipientId: "U-H5", alertType: "A", messageText: "hi" });
      const { config: failConfig } = mockConfig([new Response("{}", { status: 500 }), new Response("{}", { status: 500 })]);
      failConfig.maxAttempts = 2;
      await executeDelivery(db, row, failConfig); // attempt_count should become 2
      db.close();

      db = openDatabase(dbPath); // genuine restart
      const reloaded = db.prepare("SELECT * FROM alert_deliveries WHERE id = ?").get(row.id) as DeliveryRow;
      check("restart: stored attempt_count (2) read back correctly, authoritative", reloaded.attempt_count === 2, `got ${reloaded.attempt_count}`);

      // Remaining budget after restart = 8 - 2 = 6. Force due, then run
      // with a config that would allow up to 3 internal attempts -- must
      // still be capped to remaining budget (6 in this case, so 3 is fine
      // and unconstrained here since 3 <= 6), confirming the cap uses the
      // freshly-reloaded attempt_count, not a stale in-memory value.
      db.prepare("UPDATE alert_deliveries SET status='FAILED_RETRYABLE', next_retry_at=? WHERE id=?").run(new Date(Date.now() - 1000).toISOString(), row.id);
      const { config: okConfig } = mockConfig([new Response("{}", { status: 200 })]);
      const dueCount = await runDueDeliveries(db, okConfig);
      check("after restart, sweep picks up the row using its persisted (not reset) attempt_count", dueCount === 1);
      const finalRow = db.prepare("SELECT * FROM alert_deliveries WHERE id = ?").get(row.id) as DeliveryRow;
      check("remaining budget correctly preserved across restart (2 + 1 = 3, not reset to 1)", finalRow.attempt_count === 3, `got ${finalRow.attempt_count}`);

      db.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }

    // ---- 6. successful FIRST HTTP request -> attempt_count increases by exactly 1 ----
    {
      const db = openDatabase(":memory:");
      const { config } = mockConfig([new Response("{}", { status: 200 })]);
      const { row } = createDeliveryRow(db, { eventKey: "EK-H6", signalId: "SIG-H6", accountId: "ACC-H6", recipientId: "U-H6", alertType: "A", messageText: "hi" });
      const after = await executeDelivery(db, row, config);
      check("successful first HTTP request -> attempt_count increases by exactly 1", after.attempt_count === 1, `got ${after.attempt_count}`);
      check("...status DELIVERED", after.status === "DELIVERED");
    }

    // ---- 7. no outbound HTTP request at all (sender-boundary rejection) -> attempt_count must NOT increase ----
    {
      const db = openDatabase(":memory:");
      let realCallCount = 0;
      const configNoToken: LineSenderConfig = {
        channelAccessToken: undefined, // triggers CONFIG_MISSING_TOKEN before any fetch
        maxAttempts: 3,
        retryDelayMs: 5,
        timeoutMs: 2000,
        fetchImpl: (async () => {
          realCallCount++;
          return new Response("{}", { status: 200 });
        }) as unknown as typeof fetch,
      };
      const { row } = createDeliveryRow(db, { eventKey: "EK-H7", signalId: "SIG-H7", accountId: "ACC-H7", recipientId: "U-H7", alertType: "A", messageText: "hi" });
      const after = await executeDelivery(db, row, configNoToken);
      check("sender-boundary rejection (missing token) -> ZERO real HTTP calls", realCallCount === 0);
      check("...attempt_count does NOT increase (stays 0)", after.attempt_count === 0, `got ${after.attempt_count}`);
      check("...status is FAILED_PERMANENT (sender boundary rejections are never retryable)", after.status === "FAILED_PERMANENT");
    }
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
