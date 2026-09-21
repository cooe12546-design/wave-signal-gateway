/**
 * LINE Sender self-test: real, executed assertions against sendLineText(),
 * using a CONTROLLED MOCKED fetch (brief §24) -- no real network call is
 * ever made by this file. Covers every case the L3 brief's §24 lists.
 *
 * Run with: npm run test:line
 */
import { sendLineText } from "./line-sender.js";
import type { LineSenderConfig } from "./types.js";

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

function baseConfig(overrides: Partial<LineSenderConfig> = {}): LineSenderConfig {
  return {
    channelAccessToken: "test-channel-token",
    maxAttempts: 3,
    retryDelayMs: 5, // kept tiny so the self-test runs fast; policy correctness doesn't depend on the actual duration
    timeoutMs: 2000,
    ...overrides,
  };
}

function mockResponse(status: number, headers: Record<string, string> = {}, body = "{}"): Response {
  return new Response(body, { status, headers });
}

/** Builds a mock fetch that returns a fixed sequence of responses/errors, one per call, and records every call's headers. */
function sequenceFetch(results: Array<Response | Error>, calls: Array<{ headers: Record<string, string> }>): typeof fetch {
  let i = 0;
  const impl = (async (_url: any, init?: any) => {
    const headerObj: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) headerObj[k] = v;
    }
    calls.push({ headers: headerObj });
    const result = results[Math.min(i, results.length - 1)];
    i++;
    if (result instanceof Error) throw result;
    return result;
  }) as unknown as typeof fetch;
  return impl;
}

async function main() {
  console.log("=== wave-signal-gateway LINE Sender self-test (mocked HTTP) ===\n");

  // ---- boundary checks: never call fetch at all ----
  {
    let fetchCalled = false;
    const fetchImpl = (async () => {
      fetchCalled = true;
      return mockResponse(200);
    }) as unknown as typeof fetch;

    const r1 = await sendLineText({ recipientId: "U123", messageText: "hi" }, baseConfig({ channelAccessToken: undefined, fetchImpl }));
    check("missing channel token -> CONFIG_MISSING_TOKEN, no fetch call", r1.errorCode === "CONFIG_MISSING_TOKEN" && !fetchCalled);

    fetchCalled = false;
    const r2 = await sendLineText({ recipientId: "", messageText: "hi" }, baseConfig({ fetchImpl }));
    check("empty recipientId -> RECIPIENT_MISSING, no fetch call", r2.errorCode === "RECIPIENT_MISSING" && !fetchCalled);

    fetchCalled = false;
    const r3 = await sendLineText({ recipientId: "U123", messageText: "" }, baseConfig({ fetchImpl }));
    check("empty messageText -> MESSAGE_EMPTY, no fetch call", r3.errorCode === "MESSAGE_EMPTY" && !fetchCalled);
  }

  // ---- 200 -> success, no retry ----
  {
    const calls: Array<{ headers: Record<string, string> }> = [];
    const fetchImpl = sequenceFetch([mockResponse(200, { "x-line-request-id": "req-abc" })], calls);
    const r = await sendLineText({ recipientId: "U123", messageText: "hi" }, baseConfig({ fetchImpl }));
    check("200 -> success=true", r.success === true);
    check("200 -> httpStatus=200", r.httpStatus === 200);
    check("200 -> requestId captured", r.requestId === "req-abc");
    check("200 -> attempts=1 (no retry)", r.attempts === 1);
    check("200 -> exactly one fetch call", calls.length === 1);
  }

  // ---- 400/401/403 -> no retry ----
  for (const status of [400, 401, 403]) {
    const calls: Array<{ headers: Record<string, string> }> = [];
    const fetchImpl = sequenceFetch([mockResponse(status)], calls);
    const r = await sendLineText({ recipientId: "U123", messageText: "hi" }, baseConfig({ fetchImpl, maxAttempts: 3 }));
    check(`${status} -> success=false`, r.success === false);
    check(`${status} -> exactly one fetch call (never retried)`, calls.length === 1, `got ${calls.length}`);
  }

  // ---- 500 -> retried, bounded ----
  {
    const calls: Array<{ headers: Record<string, string> }> = [];
    const fetchImpl = sequenceFetch([mockResponse(500), mockResponse(500), mockResponse(500)], calls);
    const r = await sendLineText({ recipientId: "U123", messageText: "hi" }, baseConfig({ fetchImpl, maxAttempts: 3 }));
    check("500 x3 -> success=false after exhausting attempts", r.success === false);
    check("500 -> retried up to maxAttempts (3 calls, bounded)", calls.length === 3);
    check("500 -> attempts field = 3", r.attempts === 3);
  }
  {
    // eventual success after transient 500s
    const calls: Array<{ headers: Record<string, string> }> = [];
    const fetchImpl = sequenceFetch([mockResponse(500), mockResponse(200)], calls);
    const r = await sendLineText({ recipientId: "U123", messageText: "hi" }, baseConfig({ fetchImpl, maxAttempts: 3 }));
    check("500 then 200 -> success=true, stops retrying once successful", r.success === true && calls.length === 2);
  }

  // ---- network error -> retried, bounded ----
  {
    const calls: Array<{ headers: Record<string, string> }> = [];
    const fetchImpl = sequenceFetch([new TypeError("fetch failed"), new TypeError("fetch failed"), mockResponse(200)], calls);
    const r = await sendLineText({ recipientId: "U123", messageText: "hi" }, baseConfig({ fetchImpl, maxAttempts: 3 }));
    check("network error x2 then success -> success=true, 3 calls", r.success === true && calls.length === 3);
  }
  {
    const calls: Array<{ headers: Record<string, string> }> = [];
    const fetchImpl = sequenceFetch([new TypeError("fetch failed"), new TypeError("fetch failed"), new TypeError("fetch failed")], calls);
    const r = await sendLineText({ recipientId: "U123", messageText: "hi" }, baseConfig({ fetchImpl, maxAttempts: 3 }));
    check("network error x3 -> success=false, errorCode=NETWORK_ERROR, bounded at 3 calls", r.success === false && r.errorCode === "NETWORK_ERROR" && calls.length === 3);
  }

  // ---- 429 -> deterministic bounded handling, honors Retry-After ----
  {
    const calls: Array<{ headers: Record<string, string> }> = [];
    const fetchImpl = sequenceFetch([mockResponse(429, { "retry-after": "0" }), mockResponse(200)], calls);
    const r = await sendLineText({ recipientId: "U123", messageText: "hi" }, baseConfig({ fetchImpl, maxAttempts: 3 }));
    check("429 then 200 -> success=true, retried", r.success === true && calls.length === 2);
  }
  {
    const calls: Array<{ headers: Record<string, string> }> = [];
    const fetchImpl = sequenceFetch([mockResponse(429), mockResponse(429), mockResponse(429)], calls);
    const r = await sendLineText({ recipientId: "U123", messageText: "hi" }, baseConfig({ fetchImpl, maxAttempts: 3 }));
    check("429 x3 -> success=false, bounded at 3 calls (no unbounded retry)", r.success === false && calls.length === 3);
  }

  // ---- X-Line-Retry-Key: stable within one invocation, new key for a new invocation ----
  {
    const calls: Array<{ headers: Record<string, string> }> = [];
    const fetchImpl = sequenceFetch([mockResponse(500), mockResponse(500), mockResponse(200)], calls);
    const r = await sendLineText({ recipientId: "U123", messageText: "hi" }, baseConfig({ fetchImpl, maxAttempts: 3 }));
    const keys = calls.map((c) => c.headers["X-Line-Retry-Key"]);
    check("same invocation: X-Line-Retry-Key identical across all 3 attempts", keys.length === 3 && keys[0] === keys[1] && keys[1] === keys[2]);
    check("X-Line-Retry-Key is a valid hex UUID format", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(keys[0] ?? ""));
    check("returned retryKey matches the header actually sent", r.retryKey === keys[0]);

    const calls2: Array<{ headers: Record<string, string> }> = [];
    const fetchImpl2 = sequenceFetch([mockResponse(200)], calls2);
    const r2 = await sendLineText({ recipientId: "U123", messageText: "hi" }, baseConfig({ fetchImpl: fetchImpl2 }));
    check("separate invocation -> a DIFFERENT retry key", r2.retryKey !== r.retryKey);
  }

  // ---- Authorization header never leaks into the result ----
  {
    const fetchImpl = sequenceFetch([mockResponse(200)], []);
    const r = await sendLineText({ recipientId: "U123", messageText: "hi" }, baseConfig({ fetchImpl, channelAccessToken: "super-secret-token-value" }));
    const serialized = JSON.stringify(r);
    check("result object never contains the channel access token", !serialized.includes("super-secret-token-value"));
  }

  // ---- Authorization header IS sent correctly to LINE (verifying the real send shape) ----
  {
    const calls: Array<{ headers: Record<string, string> }> = [];
    const fetchImpl = sequenceFetch([mockResponse(200)], calls);
    await sendLineText({ recipientId: "U123", messageText: "hi" }, baseConfig({ fetchImpl, channelAccessToken: "abc123" }));
    check("Authorization header sent as 'Bearer <token>'", calls[0].headers["Authorization"] === "Bearer abc123");
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
