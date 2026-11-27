import { env, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { logSchema } from "../src/ledger/ledger";
import { erasePersonLedger, personLedgerTables } from "../src/ledger/erase";
import { personAgentKey } from "../src/domain";
import type { AgentEvent, TaskFact } from "../src/domain";
import type { BoxReplyBackfill } from "../src/agent/turn";

type Classification = {
  saved?: string;
  chat?: string;
  secret?: string;
  privateConfig?: string;
  identity?: string;
  operational?: string;
  empty?: string;
};

const durable = {
  admission: { secret: "code", identity: "inviter", operational: "one state reason cohort half state_at told_on" },
  agent: { saved: "tz checkin_local language", identity: "agent_key channel_user_id", operational: "one channel status status_at created_at claude_plan_at" },
  billing_alert: { identity: "subscription_ids delivery_id operator_route telegram_redirect", operational: "ready_at notified attempts closed_as destination_wait" },
  billing_event: { identity: "id", operational: "at" },
  box: { identity: "name url volume", operational: "one host state state_at link_sent_at signin_poll_until attempts next_at poll_at reclaim_at reclaim_reason retire_at image ensure_at" },
  box_session: { chat: "memory reply_backfill", identity: "id", operational: "one seen_seq" },
  checkout_session: { identity: "id event_key", operational: "created_at closed" },
  forget: { identity: "op", operational: "one epoch opened_at cutoff_at cutoff_seq" },
  inbox: { chat: "payload", identity: "event_key", operational: "seq kind received_at ready_at status attempts outcome finished_at catch_up catch_up_budget" },
  key_revision: { operational: "one revision" },
  key_ticket: { secret: "nonce_hash", operational: "expires_at revision status outcome created_at" },
  log_flush: { operational: "one failures retry_at" },
  log_outbox: { identity: "id", operational: "stream row created_at" },
  memory: { chat: "summary", operational: "one through_turn_seq updated_at compaction_failures compaction_retry_at" },
  memory_note: { saved: "text", identity: "id event_key", operational: "created_at" },
  meta: { operational: "k v" },
  model_key: {
    secret: "iv ciphertext hint", privateConfig: "provider base_url model auth mode cap_micro backup",
    operational: "one kid backup_asked_at revision connected_at fault failures rest_until told_on unreadable_under",
  },
  outbox: {
    chat: "texts", secret: "reply_token reply_expires", identity: "id event_key task_id saved_snapshot",
    operational: "trigger_kind intent ready_at status admitted_day in_doubt attempts via drop_reason created_at closed_at purpose choice reply_only saved_item saved_offset",
  },
  owned_group: { identity: "group_key", operational: "version" },
  plan: { identity: "own_subscription seat_subscription seat_owner", operational: "one trial_ends_at own_plan updated_at" },
  proposal: { chat: "text", identity: "id task_id outbox_id", operational: "version kind status created_at decided_at" },
  reservation: { privateConfig: "model", identity: "id instance", operational: "month scope purpose backend estimate_micro created_at" },
  saved_item: { identity: "source_id", operational: "ordinal kind" },
  saved_items: { identity: "snapshot", operational: "one revision snapshot_revision cursor_item cursor_offset" },
  spend_month: { operational: "scope month spent_micro" },
  task: { saved: "ref kind title status opened_at touched_at closed_at", identity: "id cause_key" },
  task_fact: { saved: "kind ref detail completes person_decision cause_kind cause_at at", identity: "id task_id cause_key" },
  turn: { chat: "text", identity: "event_key", operational: "seq role at" },
  wakeup: { saved: "key note due_at status repeat repeat_anchor", identity: "id task_id created_by", operational: "kind origin created_at closed_at bookkeeping" },
} satisfies Record<string, Classification>;

const d1 = {
  action_rejection: { empty: "action", identity: "id agent_key turn_id", operational: "reason at" },
  admission_log: { identity: "id agent_key", operational: "change reason channel at" },
  agent: { identity: "id agent_key", operational: "channel first_seen_at" },
  beta: { operational: "one starts_at" },
  billing_duplicate: { identity: "owner_key subscription_ids", operational: "found_at" },
  billing_invite: { secret: "code", identity: "subscription_id used_by", operational: "created_at expires_at used_at" },
  billing_seat: { identity: "agent_key subscription_id", operational: "joined_at left_at" },
  billing_subscription: { identity: "id owner_key customer_id", operational: "plan status seats past_due_since updated_at" },
  boxes: { identity: "agent_key name", operational: "host created_at deleted_at" },
  enrollment: { secret: "code", identity: "agent_key inviter", operational: "cohort half channel seated_at" },
  feedback: { empty: "text", identity: "id agent_key", operational: "channel at cohort" },
  invite_code: { secret: "code", identity: "issuer", operational: "cohort half created_at" },
  lifecycle: { identity: "id agent_key", operational: "change source at" },
  line_quota: { operational: "at month quota used" },
  line_quota_alert: { operational: "month percent via at" },
  model_call: { empty: "model", identity: "id agent_key", operational: "purpose backend status estimate_micro cost_micro input_tokens output_tokens cache_read_tokens cache_write_tokens at" },
  safety_incident: { empty: "detail", identity: "id agent_key", operational: "kind at" },
  survey_response: { identity: "agent_key", operational: "answered_at answer" },
  task: { empty: "ref title", identity: "id agent_key", operational: "kind cause_kind opened_at" },
  task_fact: { empty: "ref detail", identity: "id agent_key task_id", operational: "kind completes person_decision cause_kind cause_at at" },
  turn_log: { identity: "id agent_key", operational: "event_kind batch_size outcome refused_for_budget cost_micro attempts started_at finished_at history_trimmed" },
  unasked_message: { empty: "text", identity: "id agent_key task_id", operational: "trigger_kind status day at purpose" },
} satisfies Record<string, Classification>;

function classifiedColumns(tables: Record<string, Classification>) {
  return Object.entries(tables).flatMap(([table, groups]) =>
    Object.values(groups).flatMap((columns) => columns.split(" ").map((name) => `${table}.${name}`)),
  ).sort();
}

const columns = `SELECT m.name || '.' || p.name AS name
  FROM sqlite_master m JOIN pragma_table_xinfo(m.name) p
  WHERE m.type = 'table' AND m.name NOT GLOB 'sqlite_*' AND m.name NOT GLOB '_cf_*'`;

test("every Durable Object and D1 column has a data classification, including integers", async () => {
  const stub = env.AGENT.get(env.AGENT.idFromName("data-inventory"));
  await runInDurableObject(stub, (_, { storage: { sql } }) => {
    expect(sql.exec<{ name: string }>(columns).toArray().map((c) => c.name).sort()).toEqual(classifiedColumns(durable));
  });
  const { results: tables } = await env.LEDGER.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name != 'd1_migrations'",
  ).all<{ name: string }>();
  const names = await Promise.all(tables.map(async ({ name }) => {
    const quoted = name.replaceAll('"', '""');
    const [header] = await env.LEDGER.prepare(`SELECT * FROM "${quoted}" LIMIT 0`).raw<string[]>({ columnNames: true });
    return header.map((column) => `${name}.${column}`);
  }));
  expect(names.flat().sort()).toEqual(classifiedColumns(d1));
});

test("ledger erase covers every person table and removes indirect enrollment and billing links", async () => {
  const person = personAgentKey({ channel: "telegram", channelUserId: "100" });
  const remaining = personAgentKey({ channel: "telegram", channelUserId: "200" });
  const shared = ["beta", "line_quota", "line_quota_alert"];
  const indirect = ["billing_duplicate", "billing_invite", "billing_seat", "billing_subscription", "enrollment", "invite_code"];
  expect([...personLedgerTables, ...indirect, ...shared].sort()).toEqual(Object.keys(d1).sort());

  const db = env.LEDGER;
  await db.batch([
    db.prepare("INSERT INTO agent VALUES ('a', ?, 'telegram', 1), ('b', ?, 'telegram', 2)").bind(person, remaining),
    ...[
      "INSERT INTO action_rejection (id, agent_key, turn_id, action, reason, at) VALUES ('a', ?, 'turn-a', '', 'limit', 1)",
      "INSERT INTO admission_log (id, agent_key, change, channel, at) VALUES ('a', ?, 'consented', 'telegram', 1)",
      "INSERT INTO boxes (agent_key, name, host, created_at) VALUES (?, 'fixture', 'fly', 1)",
      "INSERT INTO feedback (id, agent_key, channel, at, text) VALUES ('a', ?, 'telegram', 1, '')",
      "INSERT INTO lifecycle (id, agent_key, change, source, at) VALUES ('a', ?, 'follow', 'channel', 1)",
      "INSERT INTO model_call (id, agent_key, purpose, model, status, estimate_micro, cost_micro, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, at) VALUES ('a', ?, 'turn', '', 'settled', 1, 1, 1, 1, 0, 0, 1)",
      "INSERT INTO safety_incident (id, agent_key, kind, detail, at) VALUES ('a', ?, 'privacy', '', 1)",
      "INSERT INTO survey_response (agent_key, answered_at, answer) VALUES (?, 1, 'very')",
      "INSERT INTO task (id, agent_key, ref, kind, title, cause_kind, opened_at) VALUES ('task-a', ?, '', 'plan', '', 'message', 1)",
      "INSERT INTO task_fact (id, agent_key, task_id, kind, ref, detail, completes, person_decision, cause_kind, cause_at, at) VALUES ('fact-a', ?, 'task-a', 'closed', '', '{}', 1, 1, 'message', 1, 1)",
      "INSERT INTO turn_log (id, agent_key, event_kind, batch_size, outcome, refused_for_budget, cost_micro, attempts, started_at, finished_at) VALUES ('turn-a', ?, 'message', 1, 'quiet', 0, 0, 1, 1, 1)",
      "INSERT INTO unasked_message (id, agent_key, trigger_kind, text, status, at, purpose) VALUES ('a', ?, 'wakeup', '', 'sent', 1, 'unlinked')",
    ].map((sql) => db.prepare(sql).bind(person)),
    db.prepare("INSERT INTO invite_code VALUES ('OWNER1', 'recruit', 'intl_telegram', 'operator', 1), ('JOINER', 'joiner', NULL, ?, 2)").bind(person),
    db.prepare("INSERT INTO enrollment VALUES (?, 'OWNER1', 'recruit', 'intl_telegram', NULL, 'telegram', 1), (?, 'JOINER', 'joiner', 'intl_telegram', ?, 'telegram', 2)").bind(person, remaining, person),
    db.prepare("INSERT INTO billing_subscription (id, owner_key, plan, status, seats, updated_at) VALUES ('sub_owner', ?, 'plus', 'canceled', 2, 1)").bind(person),
    db.prepare("INSERT INTO billing_subscription (id, owner_key, plan, status, seats, updated_at) VALUES ('sub_other', ?, 'plus', 'active', 2, 1)").bind(remaining),
    db.prepare("INSERT INTO billing_duplicate VALUES (?, 'sub_owner', 1)").bind(person),
    db.prepare("INSERT INTO billing_seat VALUES (?, 'sub_owner', 1, NULL)").bind(remaining),
    db.prepare("INSERT INTO billing_invite VALUES ('PAID01', 'sub_owner', 1, 100, ?, 2), ('PAID02', 'sub_other', 1, 100, ?, 2)").bind(remaining, person),
  ]);

  await erasePersonLedger(db, person);
  await erasePersonLedger(db, person);

  for (const table of personLedgerTables) {
    expect((await db.prepare(`SELECT * FROM ${table} WHERE agent_key = ?`).bind(person).all()).results, table).toEqual([]);
  }
  expect((await db.prepare("SELECT agent_key FROM agent").all()).results).toEqual([{ agent_key: remaining }]);
  expect((await db.prepare("SELECT agent_key, inviter, code FROM enrollment").all()).results).toEqual([
    { agent_key: remaining, inviter: null, code: expect.stringMatching(/^retired:/) },
  ]);
  for (const table of ["invite_code", "billing_duplicate", "billing_seat", "billing_invite"]) {
    expect((await db.prepare(`SELECT * FROM ${table}`).all()).results).toEqual([]);
  }
  expect((await db.prepare("SELECT id FROM billing_subscription").all()).results).toEqual([{ id: "sub_other" }]);
});

type Fields<T> = { [K in keyof T]-?: keyof Classification };
const inbox = {
  message: { kind: "operational", text: "chat", reply: "secret", redacted: "operational" },
  lifecycle: { kind: "operational", change: "operational", at: "operational", reply: "secret", code: "secret" },
  choice: { kind: "operational", choice: "identity", at: "operational", reply: "secret", epoch: "operational" },
  wakeup: { kind: "operational", wakeupId: "identity", key: "saved", origin: "operational", note: "saved", dueAt: "saved",
    firedAt: "operational", task: "identity", bookkeeping: "operational", repeat: "saved" },
  checkin: { kind: "operational", day: "operational", dueAt: "operational", firedAt: "operational" },
} satisfies { [K in AgentEvent["kind"]]: Fields<Extract<AgentEvent, { kind: K }>> };
const fact = { kind: "saved", ref: "saved", detail: "saved", cause: "saved" } satisfies Fields<TaskFact>;
const backfill = { seq: "identity", notice: "chat" } satisfies Fields<BoxReplyBackfill>;

test("diagnostic payload fields are explicitly classified and stored chat payloads have classified members", () => {
  const common = "agent id stream";
  const fields: Record<string, string> = {
    feedback: "at channel cohort",
    agent: "channel firstSeenAt",
    turn: "attempts batchSize costMicro eventKind finishedAt historyTrimmed outcome refusedForBudget startedAt",
    model_call: "at backend cacheReadTokens cacheWriteTokens costMicro estimateMicro inputTokens outputTokens purpose status",
    unasked: "at day purpose status taskId triggerKind",
    task: "causeKind kind openedAt",
    task_fact: "at causeAt causeKind completes kind personDecision taskId",
    admission: "at change channel reason",
    lifecycle: "at change source",
    rejection: "at reason turnId",
  };
  expect(Object.fromEntries(logSchema.options.map((v) => [v.shape.stream.value, Object.keys(v.shape).sort()]))).toEqual(
    Object.fromEntries(Object.entries(fields).map(([stream, extra]) => [stream, `${common} ${extra}`.split(" ").sort()])),
  );
  expect([inbox.message.text, fact.detail, backfill.notice]).toEqual(["chat", "saved", "chat"]);
});
