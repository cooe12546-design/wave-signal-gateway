#!/usr/bin/env node
/**
 * L6 operational script: creates the ONE real test account binding L6
 * needs (L6-OWNER-TEST-001 -> Owner's real LINE recipient, all 3 alert
 * types enabled), directly against the PRODUCTION SQLite database.
 *
 * This is NOT a new product feature or a new architecture -- it calls the
 * exact same createRecipient()/createSubscription() functions already
 * shipped in src/lib/recipients.ts (built for L4, used by every test
 * suite since), against the real DATABASE_PATH the production process
 * itself uses. No new endpoint, no new table, no new code path.
 *
 * WHY A SCRIPT INSTEAD OF AN HTTP CALL: L4/L6 deliberately did not build
 * an admin HTTP endpoint for creating bindings (out of scope both times).
 * The only two ways to write this row are (a) direct SQLite access to the
 * production file, or (b) building new product surface -- L6 explicitly
 * forbids the latter ("Do NOT add new product features"), so this script
 * is the (a) path: run it once, in the same environment as the
 * production process, against the same DATABASE_PATH.
 *
 * USAGE (via Railway, which already has SIGNAL_EVENT_API_KEY etc. wired
 * as env vars, so DATABASE_PATH is already correct there too). Run via
 * tsx (matching this project's own convention for every script/test --
 * plain `node` cannot resolve the .ts source this imports):
 *
 *   railway run npx tsx scripts/create-l6-binding.mjs <line_user_id>
 *
 * or, once package.json's script alias is used:
 *
 *   railway run npm run l6:bind -- <line_user_id>
 *
 * <line_user_id> is Owner's own real LINE userId (e.g. from the L3A
 * webhook capture) -- passed as a command-line argument, never hardcoded
 * here, never seen or guessed by anyone else.
 *
 * Safe to run more than once: createRecipient()/createSubscription() are
 * plain inserts (a second run creates a second, harmless recipient row
 * bound to the same account -- if you need to re-point the SAME binding
 * at a different LINE id, delete the old one first via a direct SQL
 * statement, since no update/admin path exists here by design).
 */
import { openDatabase } from "../src/lib/db.js";
import { createRecipient, createSubscription, resolveRecipients } from "../src/lib/recipients.js";

const ACCOUNT_ID = "L6-OWNER-TEST-001"; // must exactly match the EA's SignalAccountID input, per the L6 brief

const lineUserId = process.argv[2];
if (!lineUserId) {
  console.error("Usage: node scripts/create-l6-binding.mjs <line_user_id>");
  console.error("  <line_user_id> is your own real LINE userId (e.g. from the /line/webhook capture in L3A).");
  process.exit(1);
}

const dbPath = process.env.DATABASE_PATH ?? "./data/wave-signal-gateway.db";
console.log(`Opening database at: ${dbPath}`);
const db = openDatabase(dbPath);

const recipientId = createRecipient(db, { lineUserId, recipientType: "user", enabled: true });
console.log(`Created line_recipients row: id=${recipientId}, line_user_id=${lineUserId}`);

const subscriptionId = createSubscription(db, {
  accountId: ACCOUNT_ID,
  recipientId,
  enabled: true,
  alertAEnabled: true,
  alertBEnabled: true,
  alertCEnabled: true,
});
console.log(`Created alert_subscriptions row: id=${subscriptionId}, account_id=${ACCOUNT_ID}`);

// Immediate self-check, using the SAME resolver the production route uses --
// proves the binding actually resolves for all three alert types before
// any real EA event is ever sent.
for (const alertType of ["A", "B", "C"]) {
  const resolved = resolveRecipients(db, ACCOUNT_ID, alertType);
  const ok = resolved.length === 1 && resolved[0].recipientId === lineUserId;
  console.log(`resolveRecipients(${ACCOUNT_ID}, "${alertType}") -> ${JSON.stringify(resolved)}  [${ok ? "OK" : "UNEXPECTED"}]`);
}

console.log("\nDone. This account id must now be set as the EA's SignalAccountID input:");
console.log(`  SignalAccountID = ${ACCOUNT_ID}`);
