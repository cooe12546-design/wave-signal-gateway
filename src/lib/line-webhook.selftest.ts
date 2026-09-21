/**
 * LINE Webhook self-test: real, executed assertions against the actual
 * POST /line/webhook route, using REAL computed HMAC-SHA256 signatures
 * (brief §16's explicit requirement -- "not a fake bypass"). No mocking of
 * the signature verification itself; only LINE_CHANNEL_SECRET is a known
 * test value.
 *
 * Run with: npm run test:webhook
 */
import { createHmac } from "node:crypto";
import Fastify from "fastify";
import { lineWebhookRoute } from "../routes/line-webhook.js";

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

const TEST_SECRET = "test-channel-secret-value";

function realSignature(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
}

async function buildTestApp(channelSecret: string | undefined) {
  const app = Fastify({ logger: false });
  app.register(lineWebhookRoute, { channelSecret });
  await app.ready();
  return app;
}

/** Captures logger.info/warn/error output during one async operation. */
async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[] }> {
  const logs: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  try {
    const result = await fn();
    return { result, logs };
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  }
}

async function main() {
  console.log("=== wave-signal-gateway LINE Webhook self-test (real HMAC) ===\n");

  // ---- missing LINE_CHANNEL_SECRET -> safe failure ----
  {
    const app = await buildTestApp(undefined);
    const rawBody = JSON.stringify({ events: [] });
    const res = await app.inject({
      method: "POST",
      url: "/line/webhook",
      headers: { "content-type": "application/json", "x-line-signature": "anything" },
      payload: rawBody,
    });
    check("missing LINE_CHANNEL_SECRET -> 503, safe failure", res.statusCode === 503);
    await app.close();
  }

  // ---- missing x-line-signature header -> rejected ----
  {
    const app = await buildTestApp(TEST_SECRET);
    const rawBody = JSON.stringify({ events: [] });
    const res = await app.inject({
      method: "POST",
      url: "/line/webhook",
      headers: { "content-type": "application/json" },
      payload: rawBody,
    });
    check("missing x-line-signature -> rejected (401)", res.statusCode === 401);
    await app.close();
  }

  // ---- invalid signature -> 401 ----
  {
    const app = await buildTestApp(TEST_SECRET);
    const rawBody = JSON.stringify({ events: [] });
    const wrongSignature = realSignature("a-completely-different-secret", rawBody);
    const res = await app.inject({
      method: "POST",
      url: "/line/webhook",
      headers: { "content-type": "application/json", "x-line-signature": wrongSignature },
      payload: rawBody,
    });
    check("invalid signature (real HMAC, wrong secret) -> 401", res.statusCode === 401);

    const garbageRes = await app.inject({
      method: "POST",
      url: "/line/webhook",
      headers: { "content-type": "application/json", "x-line-signature": "not-even-base64-shaped!!" },
      payload: rawBody,
    });
    check("garbage/malformed signature -> 401, no crash", garbageRes.statusCode === 401);
    await app.close();
  }

  // ---- valid signature + events: [] (LINE verify request) -> 200 ----
  {
    const app = await buildTestApp(TEST_SECRET);
    const rawBody = JSON.stringify({ events: [] });
    const signature = realSignature(TEST_SECRET, rawBody);
    const res = await app.inject({
      method: "POST",
      url: "/line/webhook",
      headers: { "content-type": "application/json", "x-line-signature": signature },
      payload: rawBody,
    });
    check("valid signature + events:[] (LINE verify request) -> 200", res.statusCode === 200);
    check("response body { ok: true }", res.json().ok === true);
    await app.close();
  }

  // ---- valid signature + real user message event -> 200, userId extracted/logged ----
  {
    const app = await buildTestApp(TEST_SECRET);
    const eventPayload = {
      events: [
        {
          type: "message",
          source: { type: "user", userId: "U1234567890abcdef1234567890abcdef" },
          message: { type: "text", text: "hello" },
        },
      ],
    };
    const rawBody = JSON.stringify(eventPayload);
    const signature = realSignature(TEST_SECRET, rawBody);

    const { result: res, logs } = await captureLogs(() =>
      app.inject({
        method: "POST",
        url: "/line/webhook",
        headers: { "content-type": "application/json", "x-line-signature": signature },
        payload: rawBody,
      }),
    );

    check("valid signature + user event -> 200", res.statusCode === 200);
    const userIdLogged = logs.some((l) => l.includes("LINE_WEBHOOK_USER_ID") && l.includes("U1234567890abcdef1234567890abcdef"));
    check("userId appears in a log line for Owner to copy", userIdLogged);
    await app.close();
  }

  // ---- multiple events (user + group), all handled ----
  {
    const app = await buildTestApp(TEST_SECRET);
    const eventPayload = {
      events: [
        { type: "message", source: { type: "user", userId: "U-first-user-id" }, message: { type: "text", text: "hi" } },
        { type: "follow", source: { type: "user", userId: "U-second-user-id" } },
        { type: "message", source: { type: "group", groupId: "G-some-group-id" }, message: { type: "text", text: "hi group" } },
      ],
    };
    const rawBody = JSON.stringify(eventPayload);
    const signature = realSignature(TEST_SECRET, rawBody);

    const { result: res, logs } = await captureLogs(() =>
      app.inject({
        method: "POST",
        url: "/line/webhook",
        headers: { "content-type": "application/json", "x-line-signature": signature },
        payload: rawBody,
      }),
    );

    check("multi-event payload -> 200", res.statusCode === 200);
    check("both user IDs logged", logs.some((l) => l.includes("U-first-user-id")) && logs.some((l) => l.includes("U-second-user-id")));
    check("group event logged without inventing a user identity", logs.some((l) => l.includes("group_or_room_event") && l.includes("G-some-group-id")));
    await app.close();
  }

  // ---- security: secret/signature values never logged ----
  {
    const app = await buildTestApp(TEST_SECRET);
    const rawBody = JSON.stringify({ events: [] });
    const signature = realSignature(TEST_SECRET, rawBody);

    const { logs } = await captureLogs(() =>
      app.inject({
        method: "POST",
        url: "/line/webhook",
        headers: { "content-type": "application/json", "x-line-signature": signature },
        payload: rawBody,
      }),
    );
    const allLogs = logs.join("\n");
    check("LINE_CHANNEL_SECRET value never appears in logs", !allLogs.includes(TEST_SECRET));
    check("x-line-signature value never appears in logs", !allLogs.includes(signature));
    await app.close();
  }

  // ---- raw-body correctness: differently-formatted-but-equivalent JSON must NOT verify ----
  // (proves the route is truly using raw bytes, not re-serialized JSON --
  // brief §3's exact concern: "parse JSON first then JSON.stringify it
  // again... can change whitespace/order and invalidate the signature")
  {
    const app = await buildTestApp(TEST_SECRET);
    const originalRawBody = '{"events":[]}'; // no spaces
    const signature = realSignature(TEST_SECRET, originalRawBody);
    const reformattedBody = '{ "events": [] }'; // semantically identical, different bytes

    const res = await app.inject({
      method: "POST",
      url: "/line/webhook",
      headers: { "content-type": "application/json", "x-line-signature": signature },
      payload: reformattedBody, // signature was computed for the ORIGINAL bytes, not these
    });
    check("signature computed for different (but JSON-equivalent) bytes -> 401, proving raw-byte fidelity", res.statusCode === 401);
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
