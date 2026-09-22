/**
 * L4 self-test: account-routing header validation, recipient/subscription
 * resolution, and the full production-vs-test-recipient isolation
 * guarantee. Covers Owner's exact test matrix from the L4 closure task.
 *
 * Run with: npm run test:accounts
 */
import Fastify from "fastify";
import { openDatabase } from "./db.js";
import { healthRoute } from "../routes/health.js";
import { signalEventsRoute } from "../routes/signal-events.js";
import { lineTestRoute } from "../routes/line-test.js";
import { createRecipient, createSubscription, resolveRecipients } from "./recipients.js";
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

const SECRET = "l4-test-secret";

function makeEvent(overrides: Record<string, unknown> = {}, seq = 1, eventType = "SIGNAL_CREATED", signalId = "SIG-XAUUSD-M5-20260920-093000-BUY-001") {
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

function mockLineConfig(onCall: (recipientId: string) => void): LineSenderConfig {
  return {
    channelAccessToken: "mock-token",
    maxAttempts: 1,
    retryDelayMs: 5,
    timeoutMs: 2000,
    fetchImpl: (async (_url: any, init?: any) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      onCall(body.to ?? "");
      return new Response("{}", { status: 200, headers: { "x-line-request-id": "mock-req" } });
    }) as unknown as typeof fetch,
  };
}

async function main() {
  console.log("=== wave-signal-gateway L4 account-routing & recipient-binding self-test ===\n");

  // =====================================================================
  // Section 1: Gateway header validation (Owner's exact matrix)
  // =====================================================================
  {
    const app = Fastify({ logger: false });
    const db = openDatabase(":memory:");
    const calls: string[] = [];
    const lineConfig = mockLineConfig((r) => calls.push(r));
    const recipientId = createRecipient(db, { lineUserId: "U-account-a-recipient" });
    createSubscription(db, { accountId: "ACC-A", recipientId });
    app.register(healthRoute);
    app.register(signalEventsRoute, { db, apiKey: SECRET, lineConfig });
    await app.ready();

    const validRes = await app.inject({
      method: "POST",
      url: "/signal-events",
      headers: { "x-api-key": SECRET, "x-account-id": "ACC-A" },
      payload: makeEvent({}, 1, "SIGNAL_CREATED"),
    });
    check("valid API key + valid account id -> accepted (200)", validRes.statusCode === 200);

    const missingRes = await app.inject({
      method: "POST",
      url: "/signal-events",
      headers: { "x-api-key": SECRET },
      payload: makeEvent({}, 2, "SIGNAL_CREATED"),
    });
    check("valid API key + missing account id -> 400", missingRes.statusCode === 400);
    check("missing account id -> error body says ACCOUNT_ID_REQUIRED", missingRes.json().error === "ACCOUNT_ID_REQUIRED");

    const blankRes = await app.inject({
      method: "POST",
      url: "/signal-events",
      headers: { "x-api-key": SECRET, "x-account-id": "   " },
      payload: makeEvent({}, 3, "SIGNAL_CREATED"),
    });
    check("valid API key + blank (whitespace-only) account id -> 400", blankRes.statusCode === 400);
    check("blank account id -> same ACCOUNT_ID_REQUIRED error", blankRes.json().error === "ACCOUNT_ID_REQUIRED");

    const emptyStringRes = await app.inject({
      method: "POST",
      url: "/signal-events",
      headers: { "x-api-key": SECRET, "x-account-id": "" },
      payload: makeEvent({}, 4, "SIGNAL_CREATED"),
    });
    check("empty-string account id -> 400", emptyStringRes.statusCode === 400);

    const wrongKeyRes = await app.inject({
      method: "POST",
      url: "/signal-events",
      headers: { "x-api-key": "totally-wrong-key", "x-account-id": "ACC-A" },
      payload: makeEvent({}, 5, "SIGNAL_CREATED"),
    });
    check("wrong API key + valid account id -> 401 (auth checked before account id)", wrongKeyRes.statusCode === 401);

    // Persisted as routing metadata
    const row = db.prepare("SELECT account_id, payload_json FROM signal_events WHERE event_key = ?").get(makeEvent({}, 1, "SIGNAL_CREATED").event_key) as any;
    check("account_id persisted as routing metadata on the stored row", row?.account_id === "ACC-A");

    // Raw payload unchanged (no account_id merged into the JSON)
    const storedPayload = JSON.parse(row.payload_json);
    const originalPayload = makeEvent({}, 1, "SIGNAL_CREATED");
    check("raw WAVE_SIGNAL_EVENT_V1 payload_json unchanged (account_id never merged in)", JSON.stringify(storedPayload) === JSON.stringify(originalPayload));
    check("payload_json itself has no account_id key", !("account_id" in storedPayload));

    await app.close();
  }

  // =====================================================================
  // Section 2: resolveRecipients() unit-level matrix
  // =====================================================================
  {
    const db = openDatabase(":memory:");

    const recA = createRecipient(db, { lineUserId: "U-recipient-A" });
    createSubscription(db, { accountId: "ACC-A", recipientId: recA });

    const recB = createRecipient(db, { lineUserId: "U-recipient-B" });
    createSubscription(db, { accountId: "ACC-B", recipientId: recB });

    const resultA = resolveRecipients(db, "ACC-A", "A");
    check("account A resolves to recipient A", resultA.length === 1 && resultA[0].recipientId === "U-recipient-A");

    const resultB = resolveRecipients(db, "ACC-B", "A");
    check("account B resolves to recipient B (different from A)", resultB.length === 1 && resultB[0].recipientId === "U-recipient-B");

    const unknownResult = resolveRecipients(db, "ACC-COMPLETELY-UNKNOWN", "A");
    check("unknown account -> zero recipients resolved", unknownResult.length === 0);

    // disabled subscription
    const recC = createRecipient(db, { lineUserId: "U-recipient-C" });
    createSubscription(db, { accountId: "ACC-C", recipientId: recC, enabled: false });
    check("disabled subscription -> zero recipients resolved", resolveRecipients(db, "ACC-C", "A").length === 0);

    // disabled recipient (subscription itself enabled, but the recipient record is not)
    const recD = createRecipient(db, { lineUserId: "U-recipient-D", enabled: false });
    createSubscription(db, { accountId: "ACC-D", recipientId: recD });
    check("disabled recipient -> zero recipients resolved", resolveRecipients(db, "ACC-D", "A").length === 0);

    // per-alert-type preference disabled
    const recE = createRecipient(db, { lineUserId: "U-recipient-E" });
    createSubscription(db, { accountId: "ACC-E", recipientId: recE, alertAEnabled: false });
    check("Alert A preference disabled -> zero Alert A recipients", resolveRecipients(db, "ACC-E", "A").length === 0);
    check("...but Alert B still resolves for the same account/recipient (preferences are independent)", resolveRecipients(db, "ACC-E", "B").length === 1);
    check("...and Alert C still resolves too", resolveRecipients(db, "ACC-E", "C").length === 1);

    const recF = createRecipient(db, { lineUserId: "U-recipient-F" });
    createSubscription(db, { accountId: "ACC-F", recipientId: recF, alertBEnabled: false });
    check("Alert B preference disabled -> zero Alert B recipients", resolveRecipients(db, "ACC-F", "B").length === 0);
    check("...Alert A still resolves for the same account", resolveRecipients(db, "ACC-F", "A").length === 1);

    const recG = createRecipient(db, { lineUserId: "U-recipient-G" });
    createSubscription(db, { accountId: "ACC-G", recipientId: recG, alertCEnabled: false });
    check("Alert C preference disabled -> zero Alert C recipients", resolveRecipients(db, "ACC-G", "C").length === 0);
    check("...Alert A still resolves for the same account", resolveRecipients(db, "ACC-G", "A").length === 1);
  }

  // =====================================================================
  // Section 3: full pipeline -- account A / account B route to DIFFERENT
  // real LINE recipients (mocked fetch captures the actual "to" field)
  // =====================================================================
  {
    const app = Fastify({ logger: false });
    const db = openDatabase(":memory:");
    const sentTo: string[] = [];
    const lineConfig = mockLineConfig((r) => sentTo.push(r));

    const recA = createRecipient(db, { lineUserId: "U-real-recipient-A" });
    createSubscription(db, { accountId: "ACC-PIPE-A", recipientId: recA });
    const recB = createRecipient(db, { lineUserId: "U-real-recipient-B" });
    createSubscription(db, { accountId: "ACC-PIPE-B", recipientId: recB });

    app.register(healthRoute);
    app.register(signalEventsRoute, { db, apiKey: SECRET, lineConfig });
    await app.ready();

    await app.inject({
      method: "POST",
      url: "/signal-events",
      headers: { "x-api-key": SECRET, "x-account-id": "ACC-PIPE-A" },
      payload: makeEvent({}, 1, "SIGNAL_CREATED", "SIG-PIPE-A"),
    });
    await app.inject({
      method: "POST",
      url: "/signal-events",
      headers: { "x-api-key": SECRET, "x-account-id": "ACC-PIPE-B" },
      payload: makeEvent({}, 1, "SIGNAL_CREATED", "SIG-PIPE-B"),
    });

    check("account A's event -> sent to recipient A's real LINE user id", sentTo.includes("U-real-recipient-A"));
    check("account B's event -> sent to recipient B's real LINE user id", sentTo.includes("U-real-recipient-B"));
    check("exactly two LINE calls total (one per account)", sentTo.length === 2);

    await app.close();
  }

  // =====================================================================
  // Section 4: unknown account / disabled subscription -> zero LINE send,
  // via the full HTTP pipeline (not just the resolver in isolation)
  // =====================================================================
  {
    const app = Fastify({ logger: false });
    const db = openDatabase(":memory:");
    const calls: string[] = [];
    const lineConfig = mockLineConfig((r) => calls.push(r));

    const rec = createRecipient(db, { lineUserId: "U-disabled-sub-recipient" });
    createSubscription(db, { accountId: "ACC-DISABLED-SUB", recipientId: rec, enabled: false });

    app.register(healthRoute);
    app.register(signalEventsRoute, { db, apiKey: SECRET, lineConfig });
    await app.ready();

    const r1 = await app.inject({
      method: "POST",
      url: "/signal-events",
      headers: { "x-api-key": SECRET, "x-account-id": "ACC-NEVER-SUBSCRIBED" },
      payload: makeEvent({}, 1, "SIGNAL_CREATED", "SIG-UNKNOWN"),
    });
    check("unknown account, full pipeline -> ingest 200", r1.statusCode === 200);

    const r2 = await app.inject({
      method: "POST",
      url: "/signal-events",
      headers: { "x-api-key": SECRET, "x-account-id": "ACC-DISABLED-SUB" },
      payload: makeEvent({}, 1, "SIGNAL_CREATED", "SIG-DISABLED"),
    });
    check("disabled subscription, full pipeline -> ingest 200", r2.statusCode === 200);

    check("neither unknown account nor disabled subscription produced any LINE call", calls.length === 0, `got ${calls.length}`);

    await app.close();
  }

  // =====================================================================
  // Section 5: ENTRY_RETEST suppression and duplicate-event zero-resend
  // still hold under the L4 resolver path (not just the L3 hardcoded path)
  // =====================================================================
  {
    const app = Fastify({ logger: false });
    const db = openDatabase(":memory:");
    const calls: string[] = [];
    const lineConfig = mockLineConfig((r) => calls.push(r));
    const rec = createRecipient(db, { lineUserId: "U-subscribed-recipient" });
    createSubscription(db, { accountId: "ACC-SUB", recipientId: rec });

    app.register(healthRoute);
    app.register(signalEventsRoute, { db, apiKey: SECRET, lineConfig });
    await app.ready();

    const retestRes = await app.inject({
      method: "POST",
      url: "/signal-events",
      headers: { "x-api-key": SECRET, "x-account-id": "ACC-SUB" },
      payload: makeEvent({}, 1, "ENTRY_RETEST", "SIG-RETEST"),
    });
    check("ENTRY_RETEST with a fully subscribed account -> ingest 200", retestRes.statusCode === 200);
    check("ENTRY_RETEST with a fully subscribed account -> still ZERO LINE calls (suppression wins over subscription)", calls.length === 0);

    const dupEvent = makeEvent({}, 1, "TP1_HIT", "SIG-DUP");
    await app.inject({ method: "POST", url: "/signal-events", headers: { "x-api-key": SECRET, "x-account-id": "ACC-SUB" }, payload: dupEvent });
    const afterFirst = calls.length;
    await app.inject({ method: "POST", url: "/signal-events", headers: { "x-api-key": SECRET, "x-account-id": "ACC-SUB" }, payload: dupEvent });
    check("duplicate event under L4 resolver path -> no additional LINE call on retry", calls.length === afterFirst, `first=${afterFirst}, after retry=${calls.length}`);

    await app.close();
  }

  // =====================================================================
  // Section 6: /line/test remains fully isolated from the L4 resolver --
  // still uses LINE_TEST_RECIPIENT_ID exclusively, never touches
  // line_recipients/alert_subscriptions at all.
  // =====================================================================
  {
    const app = Fastify({ logger: false });

    // Deliberately no DB, no recipients/subscriptions seeded anywhere --
    // /line/test doesn't even take a `db` option (confirmed by its own
    // route signature), so there is structurally nothing for it to query.
    app.register(healthRoute);
    app.register(lineTestRoute, { apiKey: SECRET });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/line/test",
      headers: { "x-api-key": SECRET },
      payload: {},
    });
    // No real LINE_CHANNEL_ACCESS_TOKEN is configured in this test process,
    // so the real sendLineText() call inside /line/test will fail closed
    // with CONFIG_MISSING_TOKEN (502) or, if LINE_TEST_RECIPIENT_ID is also
    // unset, 503 -- either is fine; this section asserts ISOLATION (no
    // resolver/DB involvement possible), not delivery success (L3/L3B's
    // job, already proven).
    check("/line/test responds without any DB-seeded recipient/subscription (isolation, not delivery)", [200, 502, 503].includes(res.statusCode));

    // Real, executed structural isolation check (not a hardcoded true):
    // read line-test.ts's actual source and confirm it never imports the
    // L4 resolver module at all -- so it CANNOT be routing through
    // line_recipients/alert_subscriptions, regardless of what env vars or
    // DB state exist.
    const fs = await import("node:fs");
    const lineTestSource = fs.readFileSync(new URL("../routes/line-test.ts", import.meta.url), "utf8");
    check("/line/test source never imports the L4 recipient resolver (structural isolation, verified by reading the actual file)", !lineTestSource.includes("recipients.js") && !lineTestSource.includes("resolveRecipients"));

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
