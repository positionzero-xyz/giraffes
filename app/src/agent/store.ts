/**
 * Every method is synchronous: SQLite calls in a Durable Object don't await, so a method body is
 * atomic with respect to other requests.
 */
import type { BoxHostKind } from "../box/host";
import { dueAt, isBoxCommand, type Box, type BoxState } from "../box/machine";
import type { BoxName } from "../box/names";
import {
  assertNever,
  eventKey,
  type AgentEvent,
  type AgentEventKind,
  type AgentKey,
  type ChannelId,
  type EpochMs,
  type EventKey,
  type Identity,
  type InboundEnvelope,
  type Intent,
  type LocalDate,
  type MicroUsd,
  type OutboundMessage,
  type OutboxId,
  type PersonStatus,
  type TimeOfDay,
  type TimeZone,
  type UtcMonth,
  type WakeupId,
  type WakeupKey,
  type WakeupOrigin,
} from "../domain";
import { modelCallRow, type LogRow } from "../ledger/ledger";
import type { ModelId, Purpose } from "../model/model";
import type { Firing, NewWakeup, PendingWakeup } from "../policy/schedule";
import type { MonthSpend } from "../policy/spend";
import { COMPACTION, compactionDue, type CompactionCommit, type CompactionInput } from "./compaction";
import { TURN, type Batch, type InboxItem, type Outbound, type TurnCommit, type TurnRow } from "./turn";

export type AgentRow = {
  readonly key: AgentKey;
  readonly identity: Identity;
  readonly tz: TimeZone;
  readonly checkinLocal: TimeOfDay;
  readonly status: PersonStatus;
  readonly statusAt: EpochMs;
};

export type OutboxRow = OutboundMessage & {
  readonly eventKey: EventKey;
  readonly triggerKind: AgentEventKind;
  readonly admittedDay: LocalDate | null;
  readonly attempts: number;
};

export type Reservation = {
  readonly id: string;
  readonly month: UtcMonth;
  readonly purpose: Purpose;
  readonly model: ModelId;
  readonly estimate: MicroUsd;
};

export type Settlement = { readonly reservation: Reservation; readonly cost: MicroUsd };

export type OutboxView = {
  readonly id: OutboxId;
  readonly intent: Intent;
  readonly texts: readonly string[];
  readonly status: "pending" | "sending" | "sent" | "dropped";
  readonly via: "reply" | "push" | null;
};

type AgentCols = {
  agent_key: AgentKey;
  channel: ChannelId;
  channel_user_id: string;
  tz: TimeZone;
  checkin_local: TimeOfDay;
  status: PersonStatus;
  status_at: EpochMs;
};
type InboxCols = { event_key: EventKey; payload: string; attempts: number; received_at: EpochMs };
type WakeupCols = { id: WakeupId; key: WakeupKey; kind: PendingWakeup["kind"]; origin: WakeupOrigin; note: string; due_at: EpochMs };
type OutboxCols = {
  id: OutboxId;
  event_key: EventKey;
  trigger_kind: AgentEventKind;
  intent: Intent;
  texts: string;
  reply_token: string | null;
  reply_expires: EpochMs | null;
  admitted_day: LocalDate | null;
  in_doubt: number;
  attempts: number;
};
type ReservationCols = { id: string; month: UtcMonth; purpose: Purpose; model: ModelId; estimate_micro: MicroUsd };
type BoxCols = {
  name: BoxName;
  host: BoxHostKind;
  url: string;
  state: BoxState;
  state_at: EpochMs;
  link_sent_at: EpochMs | null;
  signin_poll_until: EpochMs | null;
  error: string | null;
  attempts: number;
  next_at: EpochMs | null;
};

export type BoxMessage = { readonly texts: readonly [string, ...string[]]; readonly note: string };

const DAY_MS = 24 * 60 * 60 * 1000;
const DEDUPE_WINDOW_MS = 14 * DAY_MS;
const OUTBOX_KEEP_MS = 30 * DAY_MS;
const LOG_RETRY_BASE_MS = 10_000;
const LOG_RETRY_MAX_MS = 60 * 60 * 1000;
const COMPACTION_RETRY_BASE_MS = 5 * 60 * 1000;
const COMPACTION_RETRY_MAX_MS = DAY_MS;

function fromJson<T>(text: string): T {
  return JSON.parse(text);
}

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");

function toWakeup(r: WakeupCols): PendingWakeup {
  const base = { id: r.id, key: r.key, note: r.note, dueAt: r.due_at };
  if (r.kind === "checkin") return { ...base, kind: "checkin", origin: "system" };
  return { ...base, kind: "reminder", origin: r.origin === "person" ? "person" : "agent" };
}

function toInboxItem(r: InboxCols): InboxItem {
  return { key: r.event_key, event: fromJson<AgentEvent>(r.payload), attempts: r.attempts, receivedAt: r.received_at };
}

function toBox(r: BoxCols): Box {
  const base = { name: r.name, host: r.host, url: r.url, stateAt: r.state_at };
  switch (r.state) {
    case "provisioning":
      return { ...base, state: r.state, attempts: r.attempts, retryAt: r.next_at ?? r.state_at };
    case "signed_out":
      return { ...base, state: r.state, linkSentAt: r.link_sent_at, pollAt: r.next_at, pollUntil: r.signin_poll_until };
    case "signed_in":
      return { ...base, state: r.state };
    case "failed":
      return { ...base, state: r.state, error: r.error ?? "" };
    default:
      return assertNever(r.state);
  }
}

function toBatch(items: readonly InboxItem[]): Batch | null {
  const [first, ...rest] = items;
  return first === undefined ? null : { items: [first, ...rest] };
}

export class AgentStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  private get sql(): SqlStorage {
    return this.storage.sql;
  }

  private tx<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }

  agent(): AgentRow | null {
    const r = this.sql
      .exec<AgentCols>("SELECT agent_key, channel, channel_user_id, tz, checkin_local, status, status_at FROM agent")
      .toArray()[0];
    if (!r) return null;
    return {
      key: r.agent_key,
      identity: { channel: r.channel, channelUserId: r.channel_user_id },
      tz: r.tz,
      checkinLocal: r.checkin_local,
      status: r.status,
      statusAt: r.status_at,
    };
  }

  enqueue(
    envelope: InboundEnvelope,
    first: { readonly tz: TimeZone; readonly checkinLocal: TimeOfDay; readonly checkin: NewWakeup },
    now: EpochMs,
  ): "inserted" | "duplicate" {
    return this.tx(() => {
      const created = this.sql.exec(
        `INSERT OR IGNORE INTO agent (one, agent_key, channel, channel_user_id, tz, checkin_local, created_at)
         VALUES (1, ?, ?, ?, ?, ?, ?)`,
        envelope.agent,
        envelope.identity.channel,
        envelope.identity.channelUserId,
        first.tz,
        first.checkinLocal,
        now,
      ).rowsWritten;
      if (created > 0) {
        this.insertWakeup(first.checkin, "system", now);
        this.insertLogs(
          [{ stream: "agent", id: `agent:${envelope.agent}`, agent: envelope.agent, channel: envelope.identity.channel, firstSeenAt: now }],
          now,
        );
      }
      return this.insertInbox(envelope.key, envelope.event, envelope.receivedAt, now);
    });
  }

  private insertInbox(key: EventKey, event: AgentEvent, receivedAt: EpochMs, readyAt: EpochMs): "inserted" | "duplicate" {
    const written = this.sql.exec(
      "INSERT OR IGNORE INTO inbox (event_key, kind, payload, received_at, ready_at) VALUES (?, ?, ?, ?, ?)",
      key,
      event.kind,
      JSON.stringify(event),
      receivedAt,
      readyAt,
    ).rowsWritten;
    return written > 0 ? "inserted" : "duplicate";
  }

  recover(now: EpochMs): Batch | null {
    const agent = this.agent();
    if (!agent) return null;
    return this.tx(() => {
      const inFlight = this.sql
        .exec<InboxCols>("SELECT event_key, payload, attempts, received_at FROM inbox WHERE status = 'processing' ORDER BY seq")
        .toArray()
        .map(toInboxItem);
      const batch = toBatch(inFlight);
      const poisoned = batch && Math.max(...batch.items.map((i) => i.attempts)) >= TURN.maxClaimAttempts ? batch : null;
      if (!poisoned) this.sql.exec("UPDATE inbox SET status = 'pending' WHERE status = 'processing'");
      this.sql.exec("UPDATE outbox SET status = 'pending', in_doubt = 1 WHERE status = 'sending'");
      const open = this.sql
        .exec<ReservationCols>("SELECT id, month, purpose, model, estimate_micro FROM reservation")
        .toArray()
        .map((r): Reservation => ({ id: r.id, month: r.month, purpose: r.purpose, model: r.model, estimate: r.estimate_micro }));
      for (const r of open) {
        this.settleRow({ reservation: r, cost: r.estimate });
        this.insertLogs(
          [
            modelCallRow({
              id: r.id,
              agent: agent.key,
              purpose: r.purpose,
              model: r.model,
              backend: "api",
              status: "recovered_after_crash",
              estimate: r.estimate,
              cost: r.estimate,
              usage: null,
              at: now,
            }),
          ],
          now,
        );
      }
      return poisoned;
    });
  }

  claimBatch(now: EpochMs): Batch | null {
    return this.tx(() => {
      const ready = this.sql
        .exec<InboxCols & { kind: AgentEventKind }>(
          `SELECT event_key, kind, payload, attempts, received_at FROM inbox
           WHERE status = 'pending' AND ready_at <= ? ORDER BY seq LIMIT ?`,
          now,
          TURN.maxBatchMessages,
        )
        .toArray();
      const [head] = ready;
      if (!head) return null;
      const command = (r: (typeof ready)[number]) => r.kind === "message" && isBoxCommand(fromJson<AgentEvent>(r.payload));
      const end = head.kind === "message" && !command(head) ? ready.findIndex((r) => r.kind !== "message" || command(r)) : 1;
      const rows = end === -1 ? ready : ready.slice(0, end);
      const keys = rows.map((r) => r.event_key);
      this.sql.exec(
        `UPDATE inbox SET status = 'processing', attempts = attempts + 1 WHERE event_key IN (${placeholders(keys.length)})`,
        ...keys,
      );
      return toBatch(rows.map((r) => toInboxItem({ ...r, attempts: r.attempts + 1 })));
    });
  }

  releaseBatch(keys: readonly EventKey[], readyAt: EpochMs, settle: Settlement | null, logs: readonly LogRow[], now: EpochMs): void {
    this.tx(() => {
      this.sql.exec(
        `UPDATE inbox SET status = 'pending', ready_at = ? WHERE status = 'processing' AND event_key IN (${placeholders(keys.length)})`,
        readyAt,
        ...keys,
      );
      if (settle) this.settleRow(settle);
      this.insertLogs(logs, now);
    });
  }

  refusedToday(dayStart: EpochMs): boolean {
    return (
      this.sql
        .exec("SELECT 1 FROM inbox WHERE outcome = 'refused_budget' AND finished_at >= ? AND kind = 'message' LIMIT 1", dayStart)
        .toArray().length > 0
    );
  }

  turnContext(limitTurns: number, limitNotes: number): {
    readonly summary: string;
    readonly notes: readonly string[];
    readonly recent: readonly TurnRow[];
    readonly pending: readonly PendingWakeup[];
  } {
    const summary = this.sql.exec<{ summary: string }>("SELECT summary FROM memory").one().summary;
    const notes = this.sql
      .exec<{ text: string }>("SELECT text FROM memory_note ORDER BY id DESC LIMIT ?", limitNotes)
      .toArray()
      .reverse()
      .map((n) => n.text);
    return { summary, notes, recent: this.recentTurns(limitTurns), pending: this.pendingWakeups() };
  }

  recentTurns(limit: number): readonly TurnRow[] {
    return this.sql
      .exec<{ role: TurnRow["role"]; text: string; at: EpochMs }>("SELECT role, text, at FROM turn ORDER BY seq DESC LIMIT ?", limit)
      .toArray()
      .reverse();
  }

  pendingWakeups(): readonly PendingWakeup[] {
    return this.sql
      .exec<WakeupCols>("SELECT id, key, kind, origin, note, due_at FROM wakeup WHERE status = 'pending' ORDER BY due_at, id")
      .toArray()
      .map(toWakeup);
  }

  commitTurn(commit: TurnCommit, settle: Settlement | null, logs: readonly LogRow[], now: EpochMs, box: Box | null = null): void {
    const [firstKey] = commit.batchKeys;
    this.tx(() => {
      if (box) this.writeBox(box);
      for (const t of commit.turns) {
        this.sql.exec("INSERT INTO turn (role, text, at, event_key) VALUES (?, ?, ?, ?)", t.role, t.text, t.at, t.eventKey);
      }
      for (const key of commit.wakeupsCancel) {
        this.sql.exec(
          "UPDATE wakeup SET status = 'cancelled', closed_at = ? WHERE key = ? AND status = 'pending' AND kind = 'reminder'",
          now,
          key,
        );
      }
      for (const w of commit.wakeupsAdd) this.insertWakeup(w, firstKey, now);
      if (commit.ensureCheckin) this.insertWakeup(commit.ensureCheckin, "system", now);
      for (const text of commit.notes) {
        this.sql.exec("INSERT INTO memory_note (text, created_at, event_key) VALUES (?, ?, ?)", text, now, firstKey);
      }
      if (commit.reachability) {
        this.sql.exec("UPDATE agent SET status = ?, status_at = ?", commit.reachability.status, commit.reachability.at);
      }
      if (commit.outbound) this.insertOutbox(firstKey, commit.outbound, now);
      this.sql.exec(
        `UPDATE inbox SET status = 'done', outcome = ?, finished_at = ? WHERE event_key IN (${placeholders(commit.batchKeys.length)})`,
        commit.outcome,
        now,
        ...commit.batchKeys,
      );
      if (settle) this.settleRow(settle);
      this.insertLogs(logs, now);
    });
  }

  private insertOutbox(key: EventKey, out: Outbound, now: EpochMs): void {
    this.sql.exec(
      `INSERT INTO outbox (id, event_key, trigger_kind, intent, texts, reply_token, reply_expires, ready_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      key,
      out.triggerKind,
      out.intent,
      JSON.stringify(out.texts),
      out.reply?.token ?? null,
      out.reply?.expiresAt ?? null,
      now,
      now,
    );
  }

  box(): Box | null {
    const r = this.sql
      .exec<BoxCols>("SELECT name, host, url, state, state_at, link_sent_at, signin_poll_until, error, attempts, next_at FROM box")
      .toArray()[0];
    return r ? toBox(r) : null;
  }

  private writeBox(b: Box): void {
    this.sql.exec(
      `INSERT INTO box (one, name, host, url, state, state_at, link_sent_at, signin_poll_until, error, attempts, next_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (one) DO UPDATE SET name = excluded.name, host = excluded.host, url = excluded.url, state = excluded.state,
         state_at = excluded.state_at, link_sent_at = excluded.link_sent_at, signin_poll_until = excluded.signin_poll_until,
         error = excluded.error, attempts = excluded.attempts, next_at = excluded.next_at`,
      b.name,
      b.host,
      b.url,
      b.state,
      b.stateAt,
      b.state === "signed_out" ? b.linkSentAt : null,
      b.state === "signed_out" ? b.pollUntil : null,
      b.state === "failed" ? b.error : null,
      b.state === "provisioning" ? b.attempts : 0,
      dueAt(b),
    );
  }

  /** A box change and the message it owes the person land together, so a crash can't send one without the other. */
  applyBox(b: Box, message: BoxMessage | null, logs: readonly LogRow[], now: EpochMs): void {
    this.tx(() => {
      this.writeBox(b);
      if (message) {
        const key = eventKey.box(b.name);
        this.sql.exec("INSERT INTO turn (role, text, at, event_key) VALUES ('note', ?, ?, ?)", message.note, now, key);
        this.insertOutbox(key, { texts: message.texts, intent: "requested", triggerKind: "message" }, now);
      }
      this.insertLogs(logs, now);
    });
  }

  appendLogs(logs: readonly LogRow[], now: EpochMs): void {
    this.tx(() => this.insertLogs(logs, now));
  }

  private insertWakeup(w: NewWakeup, createdBy: string, now: EpochMs): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO wakeup (key, kind, origin, note, due_at, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      w.key,
      w.kind,
      w.origin,
      w.note,
      w.dueAt,
      now,
      createdBy,
    );
  }

  dueWakeups(now: EpochMs): readonly PendingWakeup[] {
    return this.sql
      .exec<WakeupCols>(
        "SELECT id, key, kind, origin, note, due_at FROM wakeup WHERE status = 'pending' AND due_at <= ? ORDER BY due_at, id",
        now,
      )
      .toArray()
      .map(toWakeup);
  }

  applyFiring(firing: Firing, now: EpochMs): void {
    this.tx(() => {
      switch (firing.kind) {
        case "fire":
          this.insertInbox(firing.key, firing.event, now, now);
          this.sql.exec("UPDATE wakeup SET status = 'fired', closed_at = ? WHERE id = ? AND status = 'pending'", now, firing.wakeup.id);
          if (firing.next) this.insertWakeup(firing.next, "system", now);
          break;
        case "skip":
          this.sql.exec("UPDATE wakeup SET status = 'skipped', closed_at = ? WHERE id = ? AND status = 'pending'", now, firing.wakeup.id);
          break;
        default:
          assertNever(firing);
      }
    });
  }

  readyOutbox(now: EpochMs, limit: number): readonly OutboxRow[] {
    const agent = this.agent();
    if (!agent) return [];
    return this.sql
      .exec<OutboxCols>(
        `SELECT id, event_key, trigger_kind, intent, texts, reply_token, reply_expires, admitted_day, in_doubt, attempts
         FROM outbox WHERE status = 'pending' AND ready_at <= ? ORDER BY created_at, rowid LIMIT ?`,
        now,
        limit,
      )
      .toArray()
      .map((r): OutboxRow => {
        const base = {
          id: r.id,
          to: agent.identity,
          texts: fromJson<readonly [string, ...string[]]>(r.texts),
          intent: r.intent,
          eventKey: r.event_key,
          triggerKind: r.trigger_kind,
          admittedDay: r.admitted_day,
          attempts: r.attempts,
        };
        return r.in_doubt === 0 && r.reply_token !== null && r.reply_expires !== null
          ? { ...base, reply: { token: r.reply_token, expiresAt: r.reply_expires } }
          : base;
      });
  }

  unaskedAdmitted(day: LocalDate): number {
    return this.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM outbox WHERE intent = 'unasked' AND admitted_day = ?", day)
      .one().n;
  }

  markSending(id: OutboxId, admittedDay: LocalDate | null): void {
    this.sql.exec(
      "UPDATE outbox SET status = 'sending', admitted_day = ?, attempts = attempts + 1 WHERE id = ?",
      admittedDay,
      id,
    );
  }

  markSent(id: OutboxId, via: "reply" | "push", now: EpochMs, logs: readonly LogRow[]): void {
    this.tx(() => {
      this.sql.exec("UPDATE outbox SET status = 'sent', via = ?, closed_at = ? WHERE id = ?", via, now, id);
      this.insertLogs(logs, now);
    });
  }

  reschedule(id: OutboxId, readyAt: EpochMs): void {
    this.sql.exec("UPDATE outbox SET status = 'pending', ready_at = ? WHERE id = ?", readyAt, id);
  }

  rescheduleInDoubt(id: OutboxId, readyAt: EpochMs): void {
    this.sql.exec("UPDATE outbox SET status = 'pending', ready_at = ?, in_doubt = 1 WHERE id = ?", readyAt, id);
  }

  drop(id: OutboxId, reason: "budget" | "blocked" | "failed", now: EpochMs, logs: readonly LogRow[]): void {
    this.tx(() => {
      this.sql.exec("UPDATE outbox SET status = 'dropped', drop_reason = ?, closed_at = ? WHERE id = ?", reason, now, id);
      this.insertLogs(logs, now);
    });
  }

  recipientGone(id: OutboxId, now: EpochMs, logs: readonly LogRow[]): void {
    this.tx(() => {
      this.sql.exec("UPDATE outbox SET status = 'dropped', drop_reason = 'gone', closed_at = ? WHERE id = ?", now, id);
      this.sql.exec("UPDATE agent SET status = 'blocked'");
      this.insertLogs(logs, now);
    });
  }

  recentOutbox(limit: number): readonly OutboxView[] {
    return this.sql
      .exec<{ id: OutboxId; intent: Intent; texts: string; status: OutboxView["status"]; via: OutboxView["via"] }>(
        "SELECT id, intent, texts, status, via FROM outbox ORDER BY rowid DESC LIMIT ?",
        limit,
      )
      .toArray()
      .reverse()
      .map((r) => ({ ...r, texts: fromJson<string[]>(r.texts) }));
  }

  monthSpend(month: UtcMonth): MonthSpend {
    const row = this.sql
      .exec<{ spent_micro: MicroUsd; leased_micro: MicroUsd }>("SELECT spent_micro, leased_micro FROM spend_month WHERE month = ?", month)
      .toArray()[0];
    const reserved = this.sql
      .exec<{ micro: MicroUsd }>("SELECT COALESCE(SUM(estimate_micro), 0) AS micro FROM reservation WHERE month = ?", month)
      .one().micro;
    const none = 0 as MicroUsd;
    return { spent: row?.spent_micro ?? none, leased: row?.leased_micro ?? none, reserved };
  }

  reserve(r: Reservation, eventKey: EventKey | null, now: EpochMs): void {
    this.sql.exec(
      "INSERT INTO reservation (id, month, purpose, model, estimate_micro, event_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      r.id,
      r.month,
      r.purpose,
      r.model,
      r.estimate,
      eventKey,
      now,
    );
  }

  settle(s: Settlement, logs: readonly LogRow[], now: EpochMs): void {
    this.tx(() => {
      this.settleRow(s);
      this.insertLogs(logs, now);
    });
  }

  private settleRow(s: Settlement): void {
    this.ensureMonth(s.reservation.month);
    this.sql.exec("UPDATE spend_month SET spent_micro = spent_micro + ? WHERE month = ?", s.cost, s.reservation.month);
    this.sql.exec("DELETE FROM reservation WHERE id = ?", s.reservation.id);
  }

  private ensureMonth(month: UtcMonth): void {
    this.sql.exec("INSERT INTO spend_month (month) VALUES (?) ON CONFLICT (month) DO NOTHING", month);
  }

  beginLease(month: UtcMonth): number {
    return this.tx(() => {
      this.ensureMonth(month);
      this.sql.exec("UPDATE spend_month SET lease_pending = COALESCE(lease_pending, lease_seq + 1) WHERE month = ?", month);
      return this.sql.exec<{ seq: number }>("SELECT lease_pending AS seq FROM spend_month WHERE month = ?", month).one().seq;
    });
  }

  grantLease(month: UtcMonth, seq: number, micro: MicroUsd): void {
    this.sql.exec(
      "UPDATE spend_month SET leased_micro = leased_micro + ?, lease_seq = ?, lease_pending = NULL WHERE month = ? AND lease_pending = ?",
      micro,
      seq,
      month,
      seq,
    );
  }

  denyLease(month: UtcMonth, seq: number): void {
    this.sql.exec("UPDATE spend_month SET lease_pending = NULL WHERE month = ? AND lease_pending = ?", month, seq);
  }

  compactionInput(): CompactionInput {
    const memory = this.sql.exec<{ summary: string; through_turn_seq: number }>("SELECT summary, through_turn_seq FROM memory").one();
    const count = (table: "turn" | "memory_note") => this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n;
    return {
      summary: memory.summary,
      throughSeq: memory.through_turn_seq,
      turnCount: count("turn"),
      oldestTurns: this.sql
        .exec<{ seq: number; role: TurnRow["role"]; text: string; at: EpochMs }>(
          "SELECT seq, role, text, at FROM turn ORDER BY seq LIMIT ?",
          COMPACTION.foldTurns,
        )
        .toArray(),
      noteCount: count("memory_note"),
      oldestNotes: this.sql
        .exec<{ id: number; text: string }>("SELECT id, text FROM memory_note ORDER BY id LIMIT ?", COMPACTION.foldNotes)
        .toArray(),
    };
  }

  commitCompaction(c: CompactionCommit, settle: Settlement, logs: readonly LogRow[], now: EpochMs): boolean {
    return this.tx(() => {
      this.settleRow(settle);
      this.insertLogs(logs, now);
      const swapped = this.sql.exec(
        `UPDATE memory SET summary = ?, through_turn_seq = ?, updated_at = ?, compaction_failures = 0, compaction_retry_at = 0
         WHERE through_turn_seq = ?`,
        c.summary,
        c.throughSeq,
        now,
        c.expectThroughSeq,
      ).rowsWritten;
      if (swapped === 0) return false;
      this.sql.exec("DELETE FROM turn WHERE seq <= ?", c.throughSeq);
      if (c.deleteNoteIds.length > 0) {
        this.sql.exec(`DELETE FROM memory_note WHERE id IN (${placeholders(c.deleteNoteIds.length)})`, ...c.deleteNoteIds);
      }
      return true;
    });
  }

  compactionRetryAt(): EpochMs {
    return this.sql.exec<{ t: EpochMs }>("SELECT compaction_retry_at AS t FROM memory").one().t;
  }

  compactionFailed(now: EpochMs, settle: Settlement | null, logs: readonly LogRow[]): void {
    this.tx(() => {
      const { failures } = this.sql.exec<{ failures: number }>("SELECT compaction_failures AS failures FROM memory").one();
      const backoff = Math.min(COMPACTION_RETRY_BASE_MS * 2 ** failures, COMPACTION_RETRY_MAX_MS);
      this.sql.exec("UPDATE memory SET compaction_failures = compaction_failures + 1, compaction_retry_at = ?", now + backoff);
      if (settle) this.settleRow(settle);
      this.insertLogs(logs, now);
    });
  }

  private insertLogs(rows: readonly LogRow[], now: EpochMs): void {
    for (const row of rows) {
      this.sql.exec(
        "INSERT OR IGNORE INTO log_outbox (id, stream, row, created_at) VALUES (?, ?, ?, ?)",
        `${row.stream}:${row.id}`,
        row.stream,
        JSON.stringify(row),
        now,
      );
    }
  }

  pendingLogs(now: EpochMs, limit: number): readonly LogRow[] {
    const { retry_at } = this.sql.exec<{ retry_at: EpochMs }>("SELECT retry_at FROM log_flush").one();
    if (retry_at > now) return [];
    return this.sql
      .exec<{ row: string }>("SELECT row FROM log_outbox ORDER BY created_at, rowid LIMIT ?", limit)
      .toArray()
      .map((r) => fromJson<LogRow>(r.row));
  }

  logsShipped(rows: readonly LogRow[]): void {
    this.tx(() => {
      const ids = rows.map((r) => `${r.stream}:${r.id}`);
      this.sql.exec(`DELETE FROM log_outbox WHERE id IN (${placeholders(ids.length)})`, ...ids);
      this.sql.exec("UPDATE log_flush SET failures = 0, retry_at = 0");
    });
  }

  logsFailed(now: EpochMs): void {
    const { failures } = this.sql.exec<{ failures: number }>("SELECT failures FROM log_flush").one();
    const backoff = Math.min(LOG_RETRY_BASE_MS * 2 ** failures, LOG_RETRY_MAX_MS);
    this.sql.exec("UPDATE log_flush SET failures = failures + 1, retry_at = ?", now + backoff);
  }

  readiness(now: EpochMs): {
    readonly inboxReadyAt: EpochMs | null;
    readonly earliestWakeups: readonly { readonly origin: WakeupOrigin; readonly dueAt: EpochMs }[];
    readonly outboxReadyAt: EpochMs | null;
    readonly logsReadyAt: EpochMs | null;
    readonly compactionRetryAt: EpochMs | null;
    readonly boxAt: EpochMs | null;
  } {
    const min = (query: string) => this.sql.exec<{ t: EpochMs | null }>(query).one().t;
    const compaction = this.sql
      .exec<{ retry_at: EpochMs; turns: number; notes: number }>(
        `SELECT compaction_retry_at AS retry_at, (SELECT COUNT(*) FROM turn) AS turns, (SELECT COUNT(*) FROM memory_note) AS notes
         FROM memory`,
      )
      .one();
    return {
      inboxReadyAt: min("SELECT MIN(ready_at) AS t FROM inbox WHERE status IN ('pending', 'processing')"),
      earliestWakeups: this.sql
        .exec<{ origin: WakeupOrigin; due_at: EpochMs }>(
          "SELECT origin, MIN(due_at) AS due_at FROM wakeup WHERE status = 'pending' GROUP BY origin",
        )
        .toArray()
        .map((r) => ({ origin: r.origin, dueAt: r.due_at })),
      outboxReadyAt: min("SELECT MIN(ready_at) AS t FROM outbox WHERE status IN ('pending', 'sending')"),
      logsReadyAt: min("SELECT CASE WHEN EXISTS (SELECT 1 FROM log_outbox) THEN retry_at END AS t FROM log_flush"),
      compactionRetryAt: compaction.retry_at > now && compactionDue(compaction.turns, compaction.notes) ? compaction.retry_at : null,
      boxAt: min("SELECT MIN(next_at) AS t FROM box"),
    };
  }

  prune(now: EpochMs): void {
    this.sql.exec("DELETE FROM inbox WHERE status IN ('done', 'failed') AND finished_at < ?", now - DEDUPE_WINDOW_MS);
    this.sql.exec("DELETE FROM outbox WHERE status IN ('sent', 'dropped') AND closed_at < ?", now - OUTBOX_KEEP_MS);
  }
}
