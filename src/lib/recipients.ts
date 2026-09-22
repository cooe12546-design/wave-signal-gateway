import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { AlertType } from "../router/types.js";

/**
 * L4 Recipient Binding.
 *
 * account_id throughout this module is the OPAQUE EXTERNAL ID received via
 * the X-Account-Id header (brief's own explicit semantics) -- this gateway
 * never validates it against Trading Insight Pro/Supabase, only ever
 * compares it for equality against alert_subscriptions.account_id.
 */

export interface ResolvedRecipient {
  subscriptionId: string;
  recipientId: string; // the LINE user/group/room id to pass to sendLineText()
}

const ALERT_COLUMN: Record<AlertType, "alert_a_enabled" | "alert_b_enabled" | "alert_c_enabled"> = {
  A: "alert_a_enabled",
  B: "alert_b_enabled",
  C: "alert_c_enabled",
};

/**
 * Resolves every enabled LINE recipient for one account_id + alert type.
 *
 * Returns an EMPTY array (never throws, never guesses) for: an account_id
 * with no subscriptions at all (unknown account), a disabled subscription,
 * a disabled recipient, or a subscription whose specific alert-type
 * preference is off -- all four are the same "zero LINE sends" outcome
 * from the caller's point of view, enforced here by the SQL WHERE clause
 * itself rather than by separate post-hoc filtering, so there is exactly
 * one place this logic lives.
 *
 * ALERT_COLUMN's three values are a fixed, hardcoded internal map (never
 * derived from request input), so building the column name into the SQL
 * text here is safe -- there is no injection surface, unlike interpolating
 * a request-supplied value would be.
 */
export function resolveRecipients(db: Database.Database, accountId: string, alertType: AlertType): ResolvedRecipient[] {
  const column = ALERT_COLUMN[alertType];
  const rows = db
    .prepare(
      `SELECT s.id AS subscription_id, r.line_user_id AS recipient_id
       FROM alert_subscriptions s
       JOIN line_recipients r ON r.id = s.recipient_id
       WHERE s.account_id = ?
         AND s.enabled = 1
         AND r.enabled = 1
         AND s.${column} = 1`,
    )
    .all(accountId) as Array<{ subscription_id: string; recipient_id: string }>;

  return rows.map((r) => ({ subscriptionId: r.subscription_id, recipientId: r.recipient_id }));
}

// --- Seeding helpers (used by tests and, later, an admin surface if one is
// ever added -- none exists yet, deliberately out of this task's scope). ---

export interface CreateRecipientInput {
  lineUserId: string;
  recipientType?: "user" | "group" | "room";
  enabled?: boolean;
}

export function createRecipient(db: Database.Database, input: CreateRecipientInput): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO line_recipients (id, line_user_id, recipient_type, enabled, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, input.lineUserId, input.recipientType ?? "user", input.enabled === false ? 0 : 1, new Date().toISOString());
  return id;
}

export interface CreateSubscriptionInput {
  accountId: string;
  recipientId: string;
  enabled?: boolean;
  alertAEnabled?: boolean;
  alertBEnabled?: boolean;
  alertCEnabled?: boolean;
}

export function createSubscription(db: Database.Database, input: CreateSubscriptionInput): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO alert_subscriptions
       (id, account_id, recipient_id, enabled, alert_a_enabled, alert_b_enabled, alert_c_enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.accountId,
    input.recipientId,
    input.enabled === false ? 0 : 1,
    input.alertAEnabled === false ? 0 : 1,
    input.alertBEnabled === false ? 0 : 1,
    input.alertCEnabled === false ? 0 : 1,
    new Date().toISOString(),
  );
  return id;
}
