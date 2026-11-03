import type { AgentKey, EpochMs } from "../domain";
import { isPaying, PAST_DUE_GRACE_MS, TERMINAL, type PaidPlan, type Standing, type Subscription, type SubscriptionId, type SubscriptionStatus } from "./plan";

type InviteResult = { readonly kind: "created" } | { readonly kind: "not_owner" } | { readonly kind: "full"; readonly seats: number };
export type JoinResult = "joined" | "bad_code" | "own" | "seated" | "ended" | "full";
export type Places = { readonly taken: number; readonly seats: number };

export interface BillingStore {
  /** `s` is the state just fetched from Stripe, so it replaces the stored row unless that row is terminal. */
  applySubscription(s: Subscription, now: EpochMs): Promise<void>;
  standing(agent: AgentKey, now: EpochMs): Promise<Standing>;
  members(id: SubscriptionId): Promise<readonly AgentKey[]>;
  places(owner: AgentKey, now: EpochMs): Promise<Places | null>;
  invite(owner: AgentKey, code: string, now: EpochMs, expiresAt: EpochMs): Promise<InviteResult>;
  join(code: string, member: AgentKey, now: EpochMs): Promise<JoinResult>;
  leave(member: AgentKey, now: EpochMs): Promise<boolean>;
}

const list = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(", ");
const TERMINAL_SQL = list(TERMINAL);
const members = (sub: string) => `(SELECT COUNT(*) FROM billing_seat WHERE subscription_id = ${sub} AND left_at IS NULL)`;
/** `isPaying` in SQL, for the subscription row `b` at the instant bound to `now`. */
const paying = (b: string, now: string) =>
  `(${b}.status IN ('active', 'trialing') OR (${b}.status = 'past_due' AND ${b}.past_due_since > ${now} - ${PAST_DUE_GRACE_MS}))`;
const payingPlus = (b: string, now: string) => `${b}.plan = 'plus' AND ${paying(b, now)}`;
/** The one test of whether seat row `s` holds a place: a paying Plus with fewer than `seats - 1` open seats joined before it. */
const countingSeat = (s: string, now: string) =>
  `${s}.left_at IS NULL AND EXISTS (SELECT 1 FROM billing_subscription cb WHERE cb.id = ${s}.subscription_id AND ${payingPlus("cb", now)}
     AND (SELECT COUNT(*) FROM billing_seat o WHERE o.subscription_id = ${s}.subscription_id AND o.left_at IS NULL
          AND (o.joined_at < ${s}.joined_at OR (o.joined_at = ${s}.joined_at AND o.agent_key < ${s}.agent_key))) < cb.seats - 1)`;

type JoinRow = {
  used_by: AgentKey | null;
  expires_at: EpochMs;
  subscription_id: SubscriptionId;
  owner_key: AgentKey;
  status: SubscriptionStatus;
  past_due_since: EpochMs | null;
  seats: number;
  members: number;
  seated_on: SubscriptionId | null;
};

function classify(row: JoinRow | undefined, member: AgentKey, now: EpochMs): JoinResult {
  if (!row) return "bad_code";
  if (row.used_by === member && row.seated_on === row.subscription_id) return "joined";
  if (row.used_by !== null || row.expires_at <= now) return "bad_code";
  if (row.owner_key === member) return "own";
  if (row.seated_on !== null) return "seated";
  if (!isPaying(row.status, row.past_due_since, now)) return "ended";
  return "full";
}

export function d1Billing(db: D1Database): BillingStore {
  return {
    async applySubscription(s, now) {
      await db
        .prepare(
          `INSERT INTO billing_subscription (id, owner_key, customer_id, plan, status, seats, past_due_since, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, CASE WHEN ?5 = 'past_due' THEN ?7 END, ?7)
           ON CONFLICT (id) DO UPDATE SET owner_key = excluded.owner_key, customer_id = excluded.customer_id, plan = excluded.plan,
             status = excluded.status, seats = excluded.seats, updated_at = excluded.updated_at,
             past_due_since = CASE WHEN excluded.status = 'past_due' THEN COALESCE(billing_subscription.past_due_since, excluded.past_due_since) END
           WHERE billing_subscription.status NOT IN (${TERMINAL_SQL})`,
        )
        .bind(s.id, s.owner, s.customer, s.plan, s.status, s.seats, now)
        .run();
    },

    async standing(agent, now) {
      const [own, seat] = await db.batch<Record<string, unknown>>([
        db
          .prepare(
            `SELECT id, plan FROM billing_subscription b WHERE owner_key = ?1 AND ${paying("b", "?2")}
             ORDER BY CASE plan WHEN 'plus' THEN 0 WHEN 'standard' THEN 1 ELSE 2 END, id LIMIT 1`,
          )
          .bind(agent, now),
        db
          .prepare(
            `SELECT s.subscription_id AS id, b.owner_key AS owner FROM billing_seat s JOIN billing_subscription b ON b.id = s.subscription_id
             WHERE s.agent_key = ?1 AND ${countingSeat("s", "?2")}`,
          )
          .bind(agent, now),
      ]);
      const o = own?.results[0] as { id: SubscriptionId; plan: PaidPlan } | undefined;
      const m = seat?.results[0] as { id: SubscriptionId; owner: AgentKey } | undefined;
      return { own: o ? { id: o.id, plan: o.plan } : null, seat: m ? { id: m.id, owner: m.owner } : null };
    },

    async members(id) {
      const rows = await db.prepare("SELECT agent_key FROM billing_seat WHERE subscription_id = ? AND left_at IS NULL").bind(id).all<{ agent_key: AgentKey }>();
      return rows.results.map((r) => r.agent_key);
    },

    async places(owner, now) {
      const row = await db
        .prepare(`SELECT seats, ${members("b.id")} AS members FROM billing_subscription b WHERE owner_key = ?1 AND ${payingPlus("b", "?2")} ORDER BY id LIMIT 1`)
        .bind(owner, now)
        .first<{ seats: number; members: number }>();
      return row ? { taken: Math.min(1 + row.members, row.seats), seats: row.seats } : null;
    },

    async invite(owner, code, now, expiresAt) {
      const [, created, plus] = await db.batch<Record<string, unknown>>([
        db
          .prepare(
            `INSERT INTO billing_invite (code, subscription_id, created_at, expires_at)
             SELECT ?1, b.id, ?2, ?3 FROM billing_subscription b
             WHERE b.owner_key = ?4 AND ${payingPlus("b", "?2")} AND ${members("b.id")} < b.seats - 1
             ORDER BY b.id LIMIT 1`,
          )
          .bind(code, now, expiresAt, owner),
        db.prepare("SELECT 1 AS one FROM billing_invite WHERE code = ? AND created_at = ?").bind(code, now),
        db.prepare(`SELECT seats FROM billing_subscription b WHERE owner_key = ?1 AND ${payingPlus("b", "?2")} ORDER BY id LIMIT 1`).bind(owner, now),
      ]);
      if (created?.results.length) return { kind: "created" };
      const p = plus?.results[0] as { seats: number } | undefined;
      return p ? { kind: "full", seats: p.seats } : { kind: "not_owner" };
    },

    async join(code, member, now) {
      const seatedOn = `SELECT s.subscription_id FROM billing_seat s WHERE s.agent_key = ?2 AND ${countingSeat("s", "?3")}`;
      const [, , found] = await db.batch<Record<string, unknown>>([
        db
          .prepare(
            `UPDATE billing_invite SET used_by = ?2, used_at = ?3
             WHERE code = ?1 AND used_by IS NULL AND expires_at > ?3
               AND subscription_id IN (SELECT b.id FROM billing_subscription b
                                       WHERE ${payingPlus("b", "?3")} AND b.owner_key != ?2 AND ${members("b.id")} < b.seats - 1)
               AND NOT EXISTS (${seatedOn})`,
          )
          .bind(code, member, now),
        db
          .prepare(
            `INSERT INTO billing_seat (agent_key, subscription_id, joined_at)
             SELECT ?2, subscription_id, ?3 FROM billing_invite WHERE code = ?1 AND used_by = ?2 AND used_at = ?3
             ON CONFLICT (agent_key) DO UPDATE SET subscription_id = excluded.subscription_id, joined_at = excluded.joined_at, left_at = NULL`,
          )
          .bind(code, member, now),
        db
          .prepare(
            `SELECT i.used_by, i.expires_at, i.subscription_id, b.owner_key, b.status, b.past_due_since, b.seats,
                    ${members("i.subscription_id")} AS members, (${seatedOn}) AS seated_on
             FROM billing_invite i JOIN billing_subscription b ON b.id = i.subscription_id WHERE i.code = ?1`,
          )
          .bind(code, member, now),
      ]);
      return classify(found?.results[0] as JoinRow | undefined, member, now);
    },

    async leave(member, now) {
      const r = await db.prepare("UPDATE billing_seat SET left_at = ? WHERE agent_key = ? AND left_at IS NULL").bind(now, member).run();
      return r.meta.changes > 0;
    },
  };
}
