import type { AgentKey } from "../domain";
import type { SubscriptionId } from "../billing/plan";

export const personLedgerTables = [
  "action_rejection", "admission_log", "agent", "boxes", "feedback", "lifecycle", "model_call",
  "safety_incident", "survey_response", "task", "task_fact", "turn_log", "unasked_message",
] as const;

const ownedSubscriptions = "SELECT id FROM billing_subscription WHERE owner_key = ?1";

type EraseLink =
  | { readonly kind: "invitee" | "member"; readonly id: AgentKey }
  | { readonly kind: "subscription"; readonly id: SubscriptionId };

export async function prepareLedgerErasure(db: D1Database, person: AgentKey) {
  const [, , links] = await db.batch<EraseLink>([
    db.prepare("DELETE FROM invite_code WHERE issuer = ?1").bind(person),
    db.prepare(`DELETE FROM billing_invite WHERE subscription_id IN (${ownedSubscriptions})`).bind(person),
    db.prepare(
      `SELECT 'invitee' AS kind, agent_key AS id FROM enrollment WHERE inviter = ?1
       UNION ALL SELECT 'member', agent_key FROM billing_seat WHERE subscription_id IN (${ownedSubscriptions})
       UNION ALL SELECT 'subscription', id FROM billing_subscription WHERE owner_key = ?1`,
    ).bind(person),
  ]);
  const invitees: AgentKey[] = [];
  const members: AgentKey[] = [];
  const subscriptions: SubscriptionId[] = [];
  for (const link of links.results) {
    if (link.kind === "subscription") subscriptions.push(link.id);
    else if (link.kind === "invitee") invitees.push(link.id);
    else members.push(link.id);
  }
  return { invitees, members, subscriptions };
}

export async function erasePersonLedger(db: D1Database, person: AgentKey): Promise<void> {
  const query = (sql: string): D1PreparedStatement => db.prepare(sql).bind(person);
  await db.batch([
    ...personLedgerTables.map((table) => query(`DELETE FROM ${table} WHERE agent_key = ?1`)),
    query(`DELETE FROM invite_code WHERE issuer = ?1 OR code IN (SELECT code FROM enrollment WHERE agent_key = ?1)`),
    query("UPDATE enrollment SET inviter = NULL, code = 'retired:' || hex(randomblob(16)) WHERE inviter = ?1"),
    query("DELETE FROM enrollment WHERE agent_key = ?1"),
    query(`DELETE FROM billing_invite WHERE subscription_id IN (${ownedSubscriptions}) OR used_by = ?1`),
    query(`DELETE FROM billing_seat WHERE agent_key = ?1 OR subscription_id IN (${ownedSubscriptions})`),
    query("DELETE FROM billing_duplicate WHERE owner_key = ?1"),
    query("DELETE FROM billing_subscription WHERE owner_key = ?1"),
  ]);
}
