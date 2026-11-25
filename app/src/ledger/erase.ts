import type { AgentKey } from "../domain";

export const personLedgerTables = [
  "action_rejection", "admission_log", "agent", "boxes", "feedback", "lifecycle", "model_call",
  "safety_incident", "survey_response", "task", "task_fact", "turn_log", "unasked_message",
] as const;

export async function erasePersonLedger(db: D1Database, person: AgentKey): Promise<void> {
  const query = (sql: string): D1PreparedStatement => db.prepare(sql).bind(person);
  const owned = "SELECT id FROM billing_subscription WHERE owner_key = ?1";
  await db.batch([
    ...personLedgerTables.map((table) => query(`DELETE FROM ${table} WHERE agent_key = ?1`)),
    query(`DELETE FROM invite_code WHERE issuer = ?1 OR code IN (SELECT code FROM enrollment WHERE agent_key = ?1)`),
    query("UPDATE enrollment SET inviter = NULL, code = 'retired:' || hex(randomblob(16)) WHERE inviter = ?1"),
    query("DELETE FROM enrollment WHERE agent_key = ?1"),
    query(`DELETE FROM billing_invite WHERE subscription_id IN (${owned}) OR used_by = ?1`),
    query(`DELETE FROM billing_seat WHERE agent_key = ?1 OR subscription_id IN (${owned})`),
    query("DELETE FROM billing_duplicate WHERE owner_key = ?1"),
    query("DELETE FROM billing_subscription WHERE owner_key = ?1"),
  ]);
}
