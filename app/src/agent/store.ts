/**
 * Every method is synchronous: SQLite calls in a Durable Object don't await, so a method body is
 * atomic with respect to other requests.
 */
import type { PaidPlan, PlanRow, Standing, SubscriptionId } from "../billing/plan";
import type { CheckoutId } from "../billing/stripe";
import type { BoxHostKind } from "../box/host";
import { dueAt, type Box, type BoxState, type ReclaimReason } from "../box/machine";
import { commandOf } from "./commands";
import type { BoxName } from "../box/names";
import {
  assertNever,
  choiceToken,
  type Admission,
  type Cohort,
  type Half,
  type InviteCode,
  type Seat,
  type WaitlistReason,
  eventKey,
  parseChoice,
  personDecision,
  proposalId,
  type AgentEvent,
  type AgentEventKind,
  type AgentKey,
  type ChannelId,
  type EpochMs,
  type EventKey,
  type FactCause,
  type FactKind,
  type Identity,
  type InboundEnvelope,
  type Intent,
  type Language,
  type LocalDate,
  type MicroUsd,
  type OutboundMessage,
  type OutboxId,
  type PersonStatus,
  type ProposalId,
  type TaskFact,
  type TaskId,
  type TaskKind,
  type TaskRef,
  type TaskStatus,
  type TimeOfDay,
  type TimeZone,
  type UtcMonth,
  type WakeupId,
  type WakeupKey,
  type WakeupOrigin,
} from "../domain";
import { modelCallRow, type Backend, type LogRow } from "../ledger/ledger";
import { NOTICES } from "../notices";
import type { KeyFault, SchemaMode } from "../model/client";
import type { Auth, ModelRef, ProviderId } from "../model/providers";
import type { CallPurpose } from "../model/routes";
import { SCHEDULE, type Firing, type NewWakeup, type PendingWakeup } from "../policy/schedule";
import type { MonthSpend, SpendScope } from "../policy/spend";
import type { Sealed, StoredKey } from "../access/key";
import { COMPACTION, compactionDue, type CompactionCommit, type CompactionInput } from "./compaction";
import {
  nextStatus,
  type AcceptableProposal,
  type OpenTask,
  type ProposalStatus,
  type TappedProposal,
  type TaskCommit,
  type TaskTarget,
  type UnaskedPurpose,
} from "./tasks";
import type { AdmissionChange, AdmissionCommit } from "./admission";
import { TURN, type Asked, type Batch, type InboxItem, type Outbound, type TurnCommit, type TurnRow } from "./turn";

export type AgentRow = {
  readonly key: AgentKey;
  readonly identity: Identity;
  readonly tz: TimeZone;
  readonly language: Language;
  readonly checkinLocal: TimeOfDay;
  readonly status: PersonStatus;
  readonly statusAt: EpochMs;
};

export type OutboxRow = OutboundMessage & {
  readonly eventKey: EventKey;
  readonly triggerKind: AgentEventKind;
  readonly admittedDay: LocalDate | null;
  readonly attempts: number;
  readonly taskId: TaskId | null;
  readonly purpose: UnaskedPurpose | null;
};

export type Reservation = {
  readonly id: string;
  readonly month: UtcMonth;
  readonly scope: SpendScope;
  readonly purpose: CallPurpose;
  readonly model: ModelRef;
  readonly backend: Extract<Backend, "api" | "key" | "included">;
  readonly estimate: MicroUsd;
  /** The DO instance that made it; recovery settles only another instance's. */
  readonly instance: string;
};

export type OutboxView = {
  readonly id: OutboxId;
  readonly intent: Intent;
  readonly texts: readonly string[];
  readonly status: "pending" | "sending" | "sent" | "dropped";
  readonly via: "reply" | "push" | null;
  readonly taskId: TaskId | null;
  readonly purpose: UnaskedPurpose | null;
  /** The button's data, such as "a:1.1". */
  readonly choice: string | null;
  readonly replyOnly: boolean;
};

export type TaskSnapshot = {
  readonly id: TaskId;
  readonly ref: TaskRef;
  readonly kind: TaskKind;
  readonly title: string;
  readonly status: TaskStatus;
  readonly facts: readonly {
    readonly kind: FactKind;
    readonly ref: string;
    readonly detail: Readonly<Record<string, string | number | boolean>>;
    readonly completes: boolean;
    readonly personDecision: boolean;
    readonly causeKind: FactCause["kind"];
  }[];
};

type AgentCols = {
  agent_key: AgentKey;
  channel: ChannelId;
  channel_user_id: string;
  tz: TimeZone;
  language: Language;
  checkin_local: TimeOfDay;
  status: PersonStatus;
  status_at: EpochMs;
};
type AdmissionCols = {
  state: Exclude<Admission["state"], "stranger">;
  reason: WaitlistReason | null;
  cohort: Cohort | null;
  half: Half | null;
  code: InviteCode | null;
  inviter: AgentKey | null;
  state_at: EpochMs;
  told_on: LocalDate | null;
};
type InboxCols = { event_key: EventKey; payload: string; attempts: number; received_at: EpochMs };
type WakeupCols = {
  id: WakeupId;
  key: WakeupKey;
  kind: PendingWakeup["kind"];
  origin: WakeupOrigin;
  note: string;
  due_at: EpochMs;
  task_id: TaskId | null;
  bookkeeping: number;
};
const WAKEUP_COLS = "id, key, kind, origin, note, due_at, task_id, bookkeeping";
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
  task_id: TaskId | null;
  purpose: UnaskedPurpose | null;
  choice: string | null;
  reply_only: number;
};
type ReservationCols = {
  id: string;
  month: UtcMonth;
  scope: SpendScope;
  purpose: CallPurpose;
  model: ModelRef;
  backend: Reservation["backend"];
  estimate_micro: MicroUsd;
  instance: string;
};
type KeyCols = {
  provider: ProviderId;
  base_url: string;
  model: string;
  auth: Auth;
  mode: SchemaMode;
  kid: string;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
  hint: string;
  cap_micro: MicroUsd;
  backup: number;
  backup_asked_at: EpochMs | null;
  revision: number;
  connected_at: EpochMs;
  fault: KeyFault | null;
  failures: number;
  rest_until: EpochMs | null;
  told_on: LocalDate | null;
  unreadable_under: string | null;
};
const KEY_COLS =
  "provider, base_url, model, auth, mode, kid, iv, ciphertext, hint, cap_micro, backup, backup_asked_at, revision, connected_at, fault, failures, rest_until, told_on, unreadable_under";

function toKey(r: KeyCols): StoredKey {
  return {
    provider: r.provider,
    baseUrl: r.base_url,
    model: r.model,
    auth: r.auth,
    mode: r.mode,
    sealed: { kid: r.kid, iv: new Uint8Array(r.iv), ciphertext: new Uint8Array(r.ciphertext) },
    hint: r.hint,
    capMicro: r.cap_micro,
    backup: r.backup === 1,
    backupAskedAt: r.backup_asked_at,
    revision: r.revision,
    connectedAt: r.connected_at,
    health: r.fault === null ? { kind: "ok" } : { kind: "resting", fault: r.fault, until: r.rest_until, failures: r.failures, toldOn: r.told_on, under: r.unreadable_under },
  };
}

export type KeyTicket = {
  readonly expiresAt: EpochMs;
  /** The access revision when the link was issued; a save from it is refused once the revision moved. */
  readonly revision: number;
  readonly status: "issued" | "validating" | "saved" | "failed";
  /** What a repeat submission is told: "saved", or the error the first one got. */
  readonly outcome: string | null;
};

export type NewKey = Omit<StoredKey, "backup" | "backupAskedAt" | "revision" | "health">;

type BoxCols = {
  name: BoxName;
  host: BoxHostKind;
  url: string;
  state: BoxState;
  state_at: EpochMs;
  link_sent_at: EpochMs | null;
  signin_poll_until: EpochMs | null;
  attempts: number;
  next_at: EpochMs | null;
  poll_at: EpochMs | null;
  reclaim_at: EpochMs | null;
  reclaim_reason: ReclaimReason | null;
  retire_at: EpochMs | null;
  image: string | null;
  ensure_at: EpochMs | null;
};

type PlanCols = {
  trial_ends_at: EpochMs | null;
  own_subscription: SubscriptionId | null;
  own_plan: PaidPlan | null;
  seat_subscription: SubscriptionId | null;
  seat_owner: AgentKey | null;
};

export type NoteMessage = { readonly texts: readonly [string, ...string[]]; readonly note: string };

const DAY_MS = 24 * 60 * 60 * 1000;
const DEDUPE_WINDOW_MS = 14 * DAY_MS;
const OUTBOX_KEEP_MS = 30 * DAY_MS;
const LOG_RETRY_BASE_MS = 10_000;
const LOG_RETRY_MAX_MS = 60 * 60 * 1000;
const COMPACTION_RETRY_BASE_MS = 5 * 60 * 1000;
const COMPACTION_RETRY_MAX_MS = DAY_MS;
const TASK_IDLE_MS = 30 * DAY_MS;
const KEY_MAX_FAILURES = 20;

const toReservation = (r: ReservationCols): Reservation => ({
  id: r.id,
  month: r.month,
  scope: r.scope,
  purpose: r.purpose,
  model: r.model,
  backend: r.backend,
  estimate: r.estimate_micro,
  instance: r.instance,
});

function fromJson<T>(text: string): T {
  return JSON.parse(text);
}

function queuedLog(row: LogRow): LogRow {
  if (row.stream === "model_call" && row.backend === undefined) return { ...row, backend: "api" };
  if (row.stream === "unasked" && (row as { purpose?: unknown }).purpose === undefined) return { ...row, taskId: null, purpose: "unlinked" };
  return row;
}

/** The id D1 knows a task by, unique across people. */
export const globalTaskId = (agent: AgentKey, task: TaskId): string => `${agent}|t${task}`;

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");

function toWakeup(r: WakeupCols): PendingWakeup {
  const base = { id: r.id, key: r.key, note: r.note, dueAt: r.due_at };
  if (r.kind === "checkin") return { ...base, kind: "checkin", origin: "system" };
  return { ...base, kind: "reminder", origin: r.origin === "person" ? "person" : "agent", task: r.task_id, bookkeeping: r.bookkeeping === 1 };
}

function toInboxItem(r: InboxCols): InboxItem {
  return { key: r.event_key, event: fromJson<AgentEvent>(r.payload), attempts: r.attempts, receivedAt: r.received_at };
}

function toBox(r: BoxCols): Box {
  const base = { name: r.name, host: r.host, url: r.url, stateAt: r.state_at, retireAt: r.retire_at, image: r.image, ensureAt: r.ensure_at };
  switch (r.state) {
    case "provisioning":
      return { ...base, state: r.state, attempts: r.attempts, retryAt: r.next_at ?? r.state_at };
    case "signed_out":
      return {
        ...base,
        state: r.state,
        linkSentAt: r.link_sent_at,
        pollAt: r.poll_at,
        pollUntil: r.signin_poll_until,
        reclaimAt: r.reclaim_at,
      };
    case "signed_in":
      return { ...base, state: r.state };
    case "reclaiming":
      return { ...base, state: r.state, reason: r.reclaim_reason ?? "unused", attempts: r.attempts, retryAt: r.next_at ?? r.state_at };
    default:
      return assertNever(r.state);
  }
}

function button(choice: string | null, language: Language): Pick<OutboundMessage, "button"> {
  const c = choice === null ? null : parseChoice(choice);
  if (c === null || choice === null) return {};
  const t = NOTICES[language];
  return { button: { label: c.kind === "accept" ? t.acceptButton : c.kind === "consent" ? t.consentButton : t.backupButton, data: choice } };
}

function toAdmission(r: AdmissionCols | undefined): Admission {
  if (!r) return { state: "stranger" };
  switch (r.state) {
    case "waitlisted":
      return { state: r.state, reason: r.reason ?? "no_code", toldOn: r.told_on };
    case "consenting":
      return { state: r.state, code: r.code ?? ("" as InviteCode), at: r.state_at };
    case "admitted":
      return { state: r.state, seat: { cohort: r.cohort ?? "staff", half: r.half, code: r.code, inviter: r.inviter }, at: r.state_at };
    case "removed":
      return { state: r.state, at: r.state_at };
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
      .exec<AgentCols>("SELECT agent_key, channel, channel_user_id, tz, language, checkin_local, status, status_at FROM agent")
      .toArray()[0];
    if (!r) return null;
    return {
      key: r.agent_key,
      identity: { channel: r.channel, channelUserId: r.channel_user_id },
      tz: r.tz,
      language: r.language,
      checkinLocal: r.checkin_local,
      status: r.status,
      statusAt: r.status_at,
    };
  }

  enqueue(
    envelope: InboundEnvelope,
    first: {
      readonly tz: TimeZone;
      readonly language: Language;
      readonly checkinLocal: TimeOfDay;
      readonly checkin: NewWakeup;
      readonly trialEndsAt: EpochMs | null;
      /** Set when this person is admitted on first contact: a dev identity, or anyone while admission is open. */
      readonly admit: Seat | null;
    },
    now: EpochMs,
  ): "inserted" | "duplicate" {
    return this.tx(() => {
      if (envelope.event.kind === "message") {
        this.sql.exec(
          `INSERT INTO plan (one, trial_ends_at, updated_at) VALUES (1, ?, ?)
           ON CONFLICT (one) DO UPDATE SET trial_ends_at = COALESCE(plan.trial_ends_at, excluded.trial_ends_at)`,
          first.trialEndsAt,
          now,
        );
      }
      const created = this.sql.exec(
        `INSERT OR IGNORE INTO agent (one, agent_key, channel, channel_user_id, tz, language, checkin_local, created_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
        envelope.agent,
        envelope.identity.channel,
        envelope.identity.channelUserId,
        first.tz,
        first.language,
        first.checkinLocal,
        now,
      ).rowsWritten;
      if (created > 0) {
        this.insertLogs(
          [{ stream: "agent", id: `agent:${envelope.agent}`, agent: envelope.agent, channel: envelope.identity.channel, firstSeenAt: now }],
          now,
        );
        if (first.admit) {
          this.writeAdmission({ next: { state: "admitted", seat: first.admit, at: now }, change: "consented", ensureCheckin: first.checkin }, now);
        }
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

  recover(now: EpochMs, instance: string): Batch | null {
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
        .exec<ReservationCols>(
          "SELECT id, month, scope, purpose, model, backend, estimate_micro, instance FROM reservation WHERE instance != ?",
          instance,
        )
        .toArray()
        .map(toReservation);
      for (const r of open) {
        this.settleRow(r, r.estimate);
        this.insertLogs(
          [
            modelCallRow({
              id: r.id,
              agent: agent.key,
              purpose: r.purpose,
              model: r.model,
              backend: r.backend,
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
        .exec<InboxCols & { kind: AgentEventKind; ready_at: EpochMs }>(
          `SELECT event_key, kind, payload, attempts, received_at, ready_at FROM inbox
           WHERE status = 'pending' ORDER BY seq LIMIT ?`,
          TURN.maxBatchMessages,
        )
        .toArray();
      const [head] = ready;
      if (!head || head.ready_at > now) return null;
      const joins = (r: (typeof ready)[number]) => r.kind === "message" && r.ready_at <= now && commandOf(fromJson<AgentEvent>(r.payload)) === null;
      const end = joins(head) ? ready.findIndex((r) => !joins(r)) : 1;
      const rows = end === -1 ? ready : ready.slice(0, end);
      const keys = rows.map((r) => r.event_key);
      this.sql.exec(
        `UPDATE inbox SET status = 'processing', attempts = attempts + 1 WHERE event_key IN (${placeholders(keys.length)})`,
        ...keys,
      );
      return toBatch(rows.map((r) => toInboxItem({ ...r, attempts: r.attempts + 1 })));
    });
  }

  releaseBatch(keys: readonly EventKey[], readyAt: EpochMs, logs: readonly LogRow[], now: EpochMs): void {
    this.tx(() => {
      this.sql.exec(
        `UPDATE inbox SET status = 'pending', ready_at = ? WHERE status = 'processing' AND event_key IN (${placeholders(keys.length)})`,
        readyAt,
        ...keys,
      );
      this.insertLogs(logs, now);
    });
  }

  toldToday(outcome: "refused_budget" | "lapsed" | "no_access", dayStart: EpochMs): boolean {
    return (
      this.sql.exec("SELECT 1 FROM inbox WHERE outcome = ? AND finished_at >= ? AND kind = 'message' LIMIT 1", outcome, dayStart).toArray()
        .length > 0
    );
  }

  admission(): Admission {
    return toAdmission(
      this.sql.exec<AdmissionCols>("SELECT state, reason, cohort, half, code, inviter, state_at, told_on FROM admission").toArray()[0],
    );
  }

  private writeAdmission(c: AdmissionCommit, now: EpochMs): void {
    const a = c.next;
    if (a.state === "stranger") return;
    const seat = a.state === "admitted" ? a.seat : null;
    this.sql.exec(
      `INSERT INTO admission (one, state, reason, cohort, half, code, inviter, state_at, told_on) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (one) DO UPDATE SET state = excluded.state, reason = excluded.reason, cohort = excluded.cohort, half = excluded.half,
         code = excluded.code, inviter = excluded.inviter, state_at = excluded.state_at, told_on = excluded.told_on`,
      a.state,
      a.state === "waitlisted" ? a.reason : null,
      seat?.cohort ?? null,
      seat?.half ?? null,
      seat?.code ?? (a.state === "consenting" ? a.code : null),
      seat?.inviter ?? null,
      c.change === null ? (this.admissionAt() ?? now) : now,
      a.state === "waitlisted" ? a.toldOn : null,
    );
    if (c.ensureCheckin) this.insertWakeup(c.ensureCheckin, "system", now);
    if (c.change !== null) this.logAdmission(c.change, a.state === "waitlisted" ? a.reason : (seat?.cohort ?? null), now);
  }

  private admissionAt(): EpochMs | null {
    return this.sql.exec<{ state_at: EpochMs }>("SELECT state_at FROM admission").toArray()[0]?.state_at ?? null;
  }

  private logAdmission(change: AdmissionChange, reason: string | null, now: EpochMs): void {
    const a = this.agent();
    if (!a) return;
    const id = `${a.key}|a${change}|${now}`;
    this.insertLogs([{ stream: "admission", id, agent: a.key, change, reason, channel: a.identity.channel, at: now }], now);
  }

  /**
   * The operator takes a person out of the beta. Their seat stays used, their key links stop working, and every
   * pending push is dropped with reason removed.
   */
  remove(now: EpochMs): void {
    this.tx(() => {
      if (this.admission().state === "removed") return;
      this.writeAdmission({ next: { state: "removed", at: now }, change: "removed", ensureCheckin: null }, now);
      this.sql.exec("DELETE FROM key_ticket");
      const agent = this.agent()?.key;
      const unasked = this.sql
        .exec<{ id: OutboxId; trigger_kind: AgentEventKind; texts: string; task_id: TaskId | null; purpose: UnaskedPurpose | null }>(
          "SELECT id, trigger_kind, texts, task_id, purpose FROM outbox WHERE status = 'pending' AND intent = 'unasked'",
        )
        .toArray();
      this.sql.exec("UPDATE outbox SET status = 'dropped', drop_reason = 'removed', closed_at = ? WHERE status = 'pending'", now);
      if (!agent) return;
      this.insertLogs(
        unasked.map(
          (r): LogRow => ({
            stream: "unasked",
            id: r.id,
            agent,
            triggerKind: r.trigger_kind,
            text: fromJson<string[]>(r.texts).join("\n"),
            status: "dropped_removed",
            day: null,
            at: now,
            taskId: r.task_id === null ? null : globalTaskId(agent, r.task_id),
            purpose: r.purpose ?? "unlinked",
          }),
        ),
        now,
      );
    });
  }

  turnContext(
    limitTurns: number,
    limitNotes: number,
    batch: Batch,
  ): {
    readonly summary: string;
    readonly notes: readonly string[];
    readonly recent: readonly TurnRow[];
    readonly historyLeftOut: number;
    readonly pending: readonly PendingWakeup[];
    readonly openTasks: readonly OpenTask[];
    readonly acceptable: AcceptableProposal | null;
    readonly tapped: readonly TappedProposal[];
  } {
    const memory = this.sql.exec<{ summary: string; through: number }>("SELECT summary, through_turn_seq AS through FROM memory").one();
    const notes = this.sql
      .exec<{ text: string }>("SELECT text FROM memory_note ORDER BY id DESC LIMIT ?", limitNotes)
      .toArray()
      .reverse()
      .map((n) => n.text);
    const recent = this.sql
      .exec<{ role: TurnRow["role"]; text: string; at: EpochMs }>("SELECT role, text, at FROM turn WHERE seq > ? ORDER BY seq DESC LIMIT ?", memory.through, limitTurns)
      .toArray()
      .reverse();
    const unsummarized = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM turn WHERE seq > ?", memory.through).one().n;
    return {
      summary: memory.summary,
      notes,
      recent,
      historyLeftOut: unsummarized - recent.length,
      pending: this.pendingWakeups(),
      openTasks: this.openTasks(),
      acceptable: this.acceptable(),
      tapped: this.tapped(batch),
    };
  }

  private openTasks(): readonly OpenTask[] {
    return this.sql
      .exec<{ id: TaskId; ref: TaskRef; kind: TaskKind; title: string; proposal: ProposalId | null }>(
        `SELECT t.id, t.ref, t.kind, t.title, p.id AS proposal FROM task t
         LEFT JOIN proposal p ON p.task_id = t.id AND p.status = 'open'
         WHERE t.status = 'open' ORDER BY t.id`,
      )
      .toArray();
  }

  private acceptable(): AcceptableProposal | null {
    const r = this.sql
      .exec<{ id: ProposalId; task_id: TaskId; version: number; sent_at: EpochMs }>(
        `SELECT p.id, p.task_id, p.version, o.closed_at AS sent_at FROM proposal p
         JOIN outbox o ON o.id = p.outbox_id
         WHERE p.status = 'open'
           AND o.id = (SELECT id FROM outbox WHERE status = 'sent' ORDER BY closed_at DESC, rowid DESC LIMIT 1)`,
      )
      .toArray()[0];
    return r ? { id: r.id, task: r.task_id, version: r.version, sentAt: r.sent_at } : null;
  }

  private tapped(batch: Batch): readonly TappedProposal[] {
    const ids = batch.items.flatMap((i) => (i.event.kind === "choice" && i.event.choice.kind === "accept" ? [i.event.choice.proposal] : []));
    if (ids.length === 0) return [];
    return this.sql
      .exec<{ id: ProposalId; task_id: TaskId; version: number; status: ProposalStatus; task_status: TaskStatus }>(
        `SELECT p.id, p.task_id, p.version, p.status, t.status AS task_status FROM proposal p JOIN task t ON t.id = p.task_id
         WHERE p.id IN (${placeholders(ids.length)})`,
        ...ids,
      )
      .toArray()
      .map((r) => ({ id: r.id, task: r.task_id, version: r.version, status: r.status, taskStatus: r.task_status }));
  }

  tasks(): readonly TaskSnapshot[] {
    const facts = this.sql
      .exec<{ task_id: TaskId; kind: FactKind; ref: string; detail: string; completes: number; person_decision: number; cause_kind: FactCause["kind"] }>(
        "SELECT task_id, kind, ref, detail, completes, person_decision, cause_kind FROM task_fact ORDER BY id",
      )
      .toArray();
    return this.sql
      .exec<{ id: TaskId; ref: TaskRef; kind: TaskKind; title: string; status: TaskStatus }>("SELECT id, ref, kind, title, status FROM task ORDER BY id")
      .toArray()
      .map((t) => ({
        ...t,
        facts: facts
          .filter((f) => f.task_id === t.id)
          .map((f) => ({
            kind: f.kind,
            ref: f.ref,
            detail: fromJson<Record<string, string | number | boolean>>(f.detail),
            completes: f.completes === 1,
            personDecision: f.person_decision === 1,
            causeKind: f.cause_kind,
          })),
      }));
  }

  recentTurns(limit: number): readonly TurnRow[] {
    return this.sql
      .exec<{ role: TurnRow["role"]; text: string; at: EpochMs }>("SELECT role, text, at FROM turn ORDER BY seq DESC LIMIT ?", limit)
      .toArray()
      .reverse();
  }

  pendingWakeups(): readonly PendingWakeup[] {
    return this.sql
      .exec<WakeupCols>(`SELECT ${WAKEUP_COLS} FROM wakeup WHERE status = 'pending' ORDER BY due_at, id`)
      .toArray()
      .map(toWakeup);
  }

  commitTurn(commit: TurnCommit, logs: readonly LogRow[], now: EpochMs, box: Box | null = null): void {
    const [firstKey] = commit.batchKeys;
    this.tx(() => {
      if (box) this.writeBox(box);
      const outboxId = crypto.randomUUID() as OutboxId;
      const tasks = this.applyTasks(commit.tasks, commit.trigger, commit.outbound ? outboxId : null, now);
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
      if (commit.locale) this.sql.exec("UPDATE agent SET tz = ?, language = ?", commit.locale.tz, commit.locale.language);
      for (const r of commit.wakeupsRetime) {
        this.sql.exec("UPDATE wakeup SET due_at = ? WHERE key = ? AND status = 'pending'", r.dueAt, r.key);
      }
      if (commit.wakeupsAdd.length > 0 && this.pendingReminders() + commit.wakeupsAdd.length > SCHEDULE.maxPendingReminders) {
        throw new Error("a turn would leave more pending reminders than the cap");
      }
      for (const w of commit.wakeupsAdd) this.insertWakeup(w, firstKey, now, w.task && tasks.resolve(w.task));
      if (commit.ensureCheckin) this.insertWakeup(commit.ensureCheckin, "system", now);
      if (commit.admission) this.writeAdmission(commit.admission, now);
      for (const text of commit.notes) {
        this.sql.exec("INSERT INTO memory_note (text, created_at, event_key) VALUES (?, ?, ?)", text, now, firstKey);
      }
      if (commit.reachability) {
        this.sql.exec("UPDATE agent SET status = ?, status_at = ?", commit.reachability.status, commit.reachability.at);
      }
      if (commit.outbound) {
        const o = commit.outbound;
        const choice = o.choice === "accept_pending" ? tasks.proposal : o.choice === "consent" ? choiceToken({ kind: "consent" }) : null;
        this.insertOutbox(outboxId, firstKey, { ...o, taskId: o.link && tasks.resolve(o.link), choice }, now);
      }
      this.sql.exec(
        `UPDATE inbox SET status = 'done', outcome = ?, finished_at = ? WHERE event_key IN (${placeholders(commit.batchKeys.length)})`,
        commit.outcome,
        now,
        ...commit.batchKeys,
      );
      this.insertLogs(logs, now);
    });
  }

  private applyTasks(
    c: TaskCommit,
    cause: FactCause,
    outboxId: OutboxId | null,
    now: EpochMs,
  ): { readonly resolve: (t: TaskTarget) => TaskId | null; readonly proposal: string | null } {
    const open = new Map(this.sql.exec<{ id: TaskId; ref: TaskRef }>("SELECT id, ref FROM task WHERE status = 'open'").toArray().map((r) => [r.ref, r.id]));
    const resolve = (t: TaskTarget): TaskId | null => ("id" in t ? t.id : (open.get(t.ref) ?? null));
    const agent = this.agent()?.key;
    for (const t of c.open) {
      if (open.has(t.ref) || !agent) continue;
      const { id } = this.sql
        .exec<{ id: TaskId }>(
          "INSERT INTO task (ref, kind, title, opened_at, cause_key, touched_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
          t.ref,
          t.kind,
          t.title,
          now,
          cause.key,
          now,
        )
        .one();
      open.set(t.ref, id);
      this.insertLogs([{ stream: "task", id: globalTaskId(agent, id), agent, ref: t.ref, kind: t.kind, title: t.title, causeKind: cause.kind, openedAt: now }], now);
      this.recordFact(agent, id, { kind: "opened", ref: "", detail: {}, cause }, now);
    }
    for (const { target, fact } of c.facts) {
      const id = resolve(target);
      if (id !== null && agent) this.recordFact(agent, id, fact, now);
    }
    const proposed = c.propose && outboxId && agent ? this.propose(agent, resolve({ ref: c.propose.ref }), c.propose.text, outboxId, cause, now) : null;
    return { resolve, proposal: proposed && choiceToken({ kind: "accept", proposal: proposed }) };
  }

  private propose(agent: AgentKey, task: TaskId | null, text: string, outboxId: OutboxId, cause: FactCause, now: EpochMs): ProposalId | null {
    if (task === null) return null;
    const { version } = this.sql.exec<{ version: number }>("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM proposal WHERE task_id = ?", task).one();
    const id = proposalId(task, version);
    this.sql.exec("UPDATE proposal SET status = 'superseded', decided_at = ? WHERE task_id = ? AND status = 'open'", now, task);
    this.sql.exec(
      "INSERT INTO proposal (id, task_id, version, kind, text, outbox_id, created_at) VALUES (?, ?, ?, 'plan', ?, ?, ?)",
      id,
      task,
      version,
      text,
      outboxId,
      now,
    );
    this.recordFact(agent, task, { kind: "proposed", ref: id, detail: { version }, cause }, now);
    return id;
  }

  private recordFact(agent: AgentKey, task: TaskId, fact: TaskFact, now: EpochMs): void {
    const current = this.sql.exec<{ status: TaskStatus }>("SELECT status FROM task WHERE id = ?", task).toArray()[0]?.status;
    if (current === undefined) return;
    const next = nextStatus(current, fact.kind);
    const completes = current === "open" && next === "completed";
    const decision = personDecision(fact);
    const inserted = this.sql
      .exec<{ id: number }>(
        `INSERT INTO task_fact (task_id, kind, ref, detail, completes, person_decision, cause_key, cause_kind, cause_at, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (task_id, kind, ref) DO NOTHING RETURNING id`,
        task,
        fact.kind,
        fact.ref,
        JSON.stringify(fact.detail),
        completes ? 1 : 0,
        decision ? 1 : 0,
        fact.cause.key,
        fact.cause.kind,
        fact.cause.at,
        now,
      )
      .toArray()[0];
    if (!inserted) return;
    if (next !== current) {
      this.sql.exec("UPDATE task SET status = ?, closed_at = ?, touched_at = ? WHERE id = ?", next, now, now, task);
      if (fact.kind === "plan_accepted") {
        this.sql.exec("UPDATE proposal SET status = 'accepted', decided_at = ? WHERE id = ? AND status = 'open'", now, fact.ref);
      }
      this.sql.exec("UPDATE proposal SET status = 'closed', decided_at = ? WHERE task_id = ? AND status = 'open'", now, task);
    } else {
      this.sql.exec("UPDATE task SET touched_at = ? WHERE id = ?", now, task);
    }
    this.insertLogs(
      [
        {
          stream: "task_fact",
          id: `${agent}|f${inserted.id}`,
          agent,
          taskId: globalTaskId(agent, task),
          kind: fact.kind,
          ref: fact.ref,
          detail: JSON.stringify(fact.detail),
          completes,
          personDecision: decision,
          causeKind: fact.cause.kind,
          causeAt: fact.cause.at,
          at: now,
        },
      ],
      now,
    );
  }

  private insertOutbox(
    id: OutboxId,
    key: EventKey,
    out: Asked & Pick<Outbound, "texts" | "triggerKind" | "reply" | "replyOnly"> & { readonly taskId: TaskId | null; readonly choice: string | null },
    now: EpochMs,
  ): void {
    this.sql.exec(
      `INSERT INTO outbox (id, event_key, trigger_kind, intent, texts, reply_token, reply_expires, ready_at, created_at, task_id, purpose, choice, reply_only)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      key,
      out.triggerKind,
      out.intent,
      JSON.stringify(out.texts),
      out.reply?.token ?? null,
      out.reply?.expiresAt ?? null,
      now,
      now,
      out.taskId,
      out.intent === "unasked" ? out.purpose : null,
      out.choice,
      out.replyOnly ? 1 : 0,
    );
  }

  box(): Box | null {
    const r = this.sql
      .exec<BoxCols>(
        "SELECT name, host, url, state, state_at, link_sent_at, signin_poll_until, attempts, next_at, poll_at, reclaim_at, reclaim_reason, retire_at, image, ensure_at FROM box",
      )
      .toArray()[0];
    return r ? toBox(r) : null;
  }

  private writeBox(b: Box): void {
    const out = b.state === "signed_out" ? b : null;
    this.sql.exec("UPDATE agent SET claude_plan_at = COALESCE(claude_plan_at, ?) WHERE NOT EXISTS (SELECT 1 FROM box)", b.stateAt);
    this.sql.exec(
      `INSERT INTO box (one, name, host, url, state, state_at, link_sent_at, signin_poll_until, attempts, next_at, poll_at, reclaim_at,
         reclaim_reason, retire_at, image, ensure_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (one) DO UPDATE SET name = excluded.name, host = excluded.host, url = excluded.url, state = excluded.state,
         state_at = excluded.state_at, link_sent_at = excluded.link_sent_at, signin_poll_until = excluded.signin_poll_until,
         attempts = excluded.attempts, next_at = excluded.next_at, poll_at = excluded.poll_at, reclaim_at = excluded.reclaim_at,
         reclaim_reason = excluded.reclaim_reason, retire_at = excluded.retire_at, image = excluded.image, ensure_at = excluded.ensure_at`,
      b.name,
      b.host,
      b.url,
      b.state,
      b.stateAt,
      out?.linkSentAt ?? null,
      out?.pollUntil ?? null,
      b.state === "provisioning" || b.state === "reclaiming" ? b.attempts : 0,
      dueAt(b),
      out?.pollAt ?? null,
      out?.reclaimAt ?? null,
      b.state === "reclaiming" ? b.reason : null,
      b.retireAt,
      b.image,
      b.ensureAt,
    );
  }

  applyBox(b: Box, message: NoteMessage | null, logs: readonly LogRow[], now: EpochMs): void {
    this.tx(() => {
      this.writeBox(b);
      if (message) this.insertMessage(eventKey.box(b.name), message, now);
      this.insertLogs(logs, now);
    });
  }

  /**
   * The person has their Claude plan's box in any state, or had one and never removed it with /claude remove. Their
   * key then answers only if they said yes to it as a backup.
   */
  claudePlan(): boolean {
    return (
      this.sql
        .exec("SELECT 1 FROM agent WHERE claude_plan_at IS NOT NULL UNION ALL SELECT 1 FROM box WHERE reclaim_reason IS NOT 'removed'")
        .toArray().length > 0
    );
  }

  forgetClaudePlan(): void {
    this.sql.exec("UPDATE agent SET claude_plan_at = NULL");
  }

  removeBox(name: BoxName, message: NoteMessage, now: EpochMs): void {
    this.tx(() => {
      this.sql.exec("DELETE FROM box WHERE name = ?", name);
      this.insertMessage(eventKey.box(name), message, now);
    });
  }

  private insertMessage(key: EventKey, message: NoteMessage, now: EpochMs, choice: string | null = null): void {
    this.sql.exec("INSERT INTO turn (role, text, at, event_key) VALUES ('note', ?, ?, ?)", message.note, now, key);
    this.insertOutbox(
      crypto.randomUUID() as OutboxId,
      key,
      { texts: message.texts, intent: "requested", triggerKind: "message", replyOnly: false, taskId: null, choice },
      now,
    );
  }

  plan(): PlanRow | null {
    const r = this.sql
      .exec<PlanCols>("SELECT trial_ends_at, own_subscription, own_plan, seat_subscription, seat_owner FROM plan")
      .toArray()[0];
    if (!r) return null;
    return {
      trialEndsAt: r.trial_ends_at,
      own: r.own_subscription !== null && r.own_plan !== null ? { id: r.own_subscription, plan: r.own_plan } : null,
      seat: r.seat_subscription !== null && r.seat_owner !== null ? { id: r.seat_subscription, owner: r.seat_owner } : null,
    };
  }

  applyStanding(s: Standing, message: { readonly key: EventKey; readonly message: NoteMessage } | null, now: EpochMs): void {
    this.tx(() => {
      this.sql.exec(
        `INSERT INTO plan (one, own_subscription, own_plan, seat_subscription, seat_owner, updated_at)
         VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT (one) DO UPDATE SET own_subscription = excluded.own_subscription, own_plan = excluded.own_plan,
           seat_subscription = excluded.seat_subscription, seat_owner = excluded.seat_owner, updated_at = excluded.updated_at`,
        s.own?.id ?? null,
        s.own?.plan ?? null,
        s.seat?.id ?? null,
        s.seat?.owner ?? null,
        now,
      );
      if (message && this.agent()) this.insertMessage(message.key, message.message, now);
    });
  }

  /** Tells the person `message` unless `once` was already told, marking it like a handled Stripe event. */
  notifyOnce(once: string, key: EventKey, message: NoteMessage | null, now: EpochMs): void {
    this.tx(() => {
      if (this.billingEventSeen(once)) return;
      if (message && this.agent()) this.insertMessage(key, message, now);
      this.billingEventDone(once, now);
    });
  }

  openCheckouts(): readonly { readonly id: CheckoutId; readonly eventKey: EventKey }[] {
    return this.sql
      .exec<{ id: CheckoutId; event_key: EventKey }>("SELECT id, event_key FROM checkout_session ORDER BY created_at, id")
      .toArray()
      .map((r) => ({ id: r.id, eventKey: r.event_key }));
  }

  checkoutOpened(id: CheckoutId, key: EventKey, now: EpochMs): void {
    this.sql.exec("INSERT OR IGNORE INTO checkout_session (id, event_key, created_at) VALUES (?, ?, ?)", id, key, now);
  }

  checkoutClosed(id: CheckoutId): void {
    this.sql.exec("DELETE FROM checkout_session WHERE id = ?", id);
  }

  billingEventSeen(id: string): boolean {
    return this.sql.exec("SELECT 1 FROM billing_event WHERE id = ?", id).toArray().length > 0;
  }

  billingEventDone(id: string, now: EpochMs): void {
    this.sql.exec("INSERT OR IGNORE INTO billing_event (id, at) VALUES (?, ?)", id, now);
  }

  appendLogs(logs: readonly LogRow[], now: EpochMs): void {
    this.tx(() => this.insertLogs(logs, now));
  }

  private insertWakeup(w: NewWakeup, createdBy: string, now: EpochMs, task: TaskId | null = null): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO wakeup (key, kind, origin, note, due_at, created_at, created_by, task_id, bookkeeping) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      w.key,
      w.kind,
      w.origin,
      w.note,
      w.dueAt,
      now,
      createdBy,
      task,
      w.kind === "reminder" && w.bookkeeping ? 1 : 0,
    );
  }

  private pendingReminders(): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM wakeup WHERE status = 'pending' AND kind = 'reminder'").one().n;
  }

  /** A message, follow or block not yet handled; it may cancel or move a wake-up, or change whether one fires. */
  channelEventWaiting(): boolean {
    return (
      this.sql.exec("SELECT 1 FROM inbox WHERE status IN ('pending', 'processing') AND kind IN ('message', 'lifecycle') LIMIT 1").toArray()
        .length > 0
    );
  }

  dueWakeups(now: EpochMs): readonly PendingWakeup[] {
    return this.sql
      .exec<WakeupCols>(
        `SELECT ${WAKEUP_COLS} FROM wakeup WHERE status = 'pending' AND due_at <= ? ORDER BY due_at, id`,
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
        `SELECT id, event_key, trigger_kind, intent, texts, reply_token, reply_expires, admitted_day, in_doubt, attempts, task_id, purpose, choice, reply_only
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
          taskId: r.task_id,
          purpose: r.purpose,
          replyOnly: r.reply_only === 1,
          ...button(r.choice, agent.language),
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

  drop(id: OutboxId, reason: "budget" | "blocked" | "quota" | "failed" | "removed", now: EpochMs, logs: readonly LogRow[]): void {
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
      .exec<{
        id: OutboxId;
        intent: Intent;
        texts: string;
        status: OutboxView["status"];
        via: OutboxView["via"];
        task_id: TaskId | null;
        purpose: UnaskedPurpose | null;
        choice: string | null;
        reply_only: number;
      }>("SELECT id, intent, texts, status, via, task_id, purpose, choice, reply_only FROM outbox ORDER BY rowid DESC LIMIT ?", limit)
      .toArray()
      .reverse()
      .map(({ task_id, reply_only, ...r }) => ({ ...r, taskId: task_id, replyOnly: reply_only === 1, texts: fromJson<string[]>(r.texts) }));
  }

  spend(scope: SpendScope, month: UtcMonth): MonthSpend {
    const row = this.sql
      .exec<{ spent_micro: MicroUsd }>("SELECT spent_micro FROM spend_month WHERE scope = ? AND month = ?", scope, month)
      .toArray()[0];
    const reserved = this.sql
      .exec<{ micro: MicroUsd }>("SELECT COALESCE(SUM(estimate_micro), 0) AS micro FROM reservation WHERE scope = ? AND month = ?", scope, month)
      .one().micro;
    return { spent: row?.spent_micro ?? (0 as MicroUsd), reserved };
  }

  reserve(r: Reservation, now: EpochMs): void {
    this.sql.exec(
      "INSERT INTO reservation (id, month, scope, purpose, model, backend, estimate_micro, instance, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      r.id,
      r.month,
      r.scope,
      r.purpose,
      r.model,
      r.backend,
      r.estimate,
      r.instance,
      now,
    );
  }

  /** One attempt's charge and its log row, in one transaction, as soon as the attempt returns. */
  settle(r: Reservation, cost: MicroUsd, logs: readonly LogRow[], now: EpochMs): void {
    this.tx(() => {
      this.settleRow(r, cost);
      this.insertLogs(logs, now);
    });
  }

  private settleRow(r: Reservation, cost: MicroUsd): void {
    this.sql.exec(
      `INSERT INTO spend_month (scope, month, spent_micro) VALUES (?, ?, ?)
       ON CONFLICT (scope, month) DO UPDATE SET spent_micro = spent_micro + excluded.spent_micro`,
      r.scope,
      r.month,
      cost,
    );
    this.sql.exec("DELETE FROM reservation WHERE id = ?", r.id);
  }

  key(): StoredKey | null {
    const r = this.sql.exec<KeyCols>(`SELECT ${KEY_COLS} FROM model_key`).toArray()[0];
    return r ? toKey(r) : null;
  }

  /** Bumped by every save and removal, and never reset, so a ticket can tell that access changed after it was issued. */
  keyRevision(): number {
    return this.sql.exec<{ revision: number }>("SELECT revision FROM key_revision").one().revision;
  }

  /**
   * Saves a key unless the access revision moved since `expectRevision`, so a slow validation can't overwrite a newer
   * key or a removal. A replacement keeps the cap and the backup answer, and clears any fault.
   */
  saveKey(
    k: NewKey,
    expectRevision: number,
    message: { readonly key: EventKey; readonly message: NoteMessage } | null,
    logs: readonly LogRow[],
    now: EpochMs,
    ticket: string | null = null,
  ): boolean {
    return this.tx(() => {
      if (this.keyRevision() !== expectRevision) return false;
      if (ticket !== null) this.finishTicket(ticket, "saved", "saved");
      const revision = expectRevision + 1;
      this.sql.exec("UPDATE key_revision SET revision = ?", revision);
      this.sql.exec(
        `INSERT INTO model_key (one, provider, base_url, model, auth, mode, kid, iv, ciphertext, hint, cap_micro, revision, connected_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (one) DO UPDATE SET provider = excluded.provider, base_url = excluded.base_url, model = excluded.model,
           auth = excluded.auth, mode = excluded.mode, kid = excluded.kid, iv = excluded.iv, ciphertext = excluded.ciphertext,
           hint = excluded.hint, revision = excluded.revision, connected_at = excluded.connected_at,
           fault = NULL, failures = 0, rest_until = NULL, told_on = NULL, unreadable_under = NULL`,
        k.provider,
        k.baseUrl,
        k.model,
        k.auth,
        k.mode,
        k.sealed.kid,
        k.sealed.iv,
        k.sealed.ciphertext,
        k.hint,
        k.capMicro,
        revision,
        k.connectedAt,
      );
      if (message) this.insertMessage(message.key, message.message, now);
      this.insertLogs(logs, now);
      return true;
    });
  }

  /** Only the newest link works: issuing one drops every other unused ticket, and any that expired. */
  issueTicket(nonceHash: string, expiresAt: EpochMs, now: EpochMs): void {
    this.tx(() => {
      this.sql.exec("DELETE FROM key_ticket WHERE status = 'issued' OR expires_at <= ?", now);
      this.sql.exec(
        "INSERT INTO key_ticket (nonce_hash, expires_at, revision, created_at) VALUES (?, ?, ?, ?)",
        nonceHash,
        expiresAt,
        this.keyRevision(),
        now,
      );
    });
  }

  ticket(nonceHash: string): KeyTicket | null {
    const r = this.sql
      .exec<{ expires_at: EpochMs; revision: number; status: KeyTicket["status"]; outcome: string | null }>(
        "SELECT expires_at, revision, status, outcome FROM key_ticket WHERE nonce_hash = ?",
        nonceHash,
      )
      .toArray()[0];
    return r ? { expiresAt: r.expires_at, revision: r.revision, status: r.status, outcome: r.outcome } : null;
  }

  /** Moves a live ticket to validating before any provider call; false when it is used, in use or gone. */
  startValidating(nonceHash: string, now: EpochMs): boolean {
    return (
      this.sql.exec("UPDATE key_ticket SET status = 'validating' WHERE nonce_hash = ? AND status = 'issued' AND expires_at > ?", nonceHash, now)
        .rowsWritten > 0
    );
  }

  finishTicket(nonceHash: string, status: "saved" | "failed", outcome: string): void {
    this.sql.exec("UPDATE key_ticket SET status = ?, outcome = ? WHERE nonce_hash = ? AND status = 'validating'", status, outcome, nonceHash);
  }

  /**
   * Every write below names the key revision it was made for and does nothing once the key moved on, so a call that
   * started on one key can't change the key that replaced it.
   */
  removeKey(expectRevision: number | null): boolean {
    return this.tx(() => {
      const current = this.key();
      if (current !== null && current.revision !== expectRevision) return false;
      this.sql.exec("DELETE FROM model_key");
      this.sql.exec("UPDATE key_revision SET revision = revision + 1");
      return current !== null;
    });
  }

  setKeyCap(micro: MicroUsd, expectRevision: number): boolean {
    return this.sql.exec("UPDATE model_key SET cap_micro = ? WHERE revision = ?", micro, expectRevision).rowsWritten > 0;
  }

  setBackup(on: boolean, now: EpochMs, expectRevision: number | null): "set" | "no_key" | "stale" {
    const current = this.key();
    if (current === null) return "no_key";
    if (current.revision !== expectRevision) return "stale";
    this.sql.exec("UPDATE model_key SET backup = ?, backup_asked_at = COALESCE(backup_asked_at, ?) WHERE revision = ?", on ? 1 : 0, now, expectRevision);
    return "set";
  }

  /** Asks the backup question once per key, or `again` when the plan's box went away; true when this call asked. */
  askBackup(message: NoteMessage, choice: string, key: EventKey, now: EpochMs, expectRevision: number, again: boolean = false): boolean {
    return this.tx(() => {
      const asked =
        this.sql.exec(
          "UPDATE model_key SET backup_asked_at = ? WHERE revision = ? AND backup = 0 AND (backup_asked_at IS NULL OR ?)",
          now,
          expectRevision,
          again ? 1 : 0,
        ).rowsWritten > 0;
      if (asked) this.insertMessage(key, message, now, choice);
      return asked;
    });
  }

  reseal(again: Sealed, expectRevision: number): boolean {
    return this.sql.exec("UPDATE model_key SET kid = ?, iv = ?, ciphertext = ? WHERE revision = ?", again.kid, again.iv, again.ciphertext, expectRevision).rowsWritten > 0;
  }

  /** The key rests after a provider fault. The notice goes out at most once on the person's local date `today`. */
  restKey(
    fault: KeyFault,
    until: EpochMs | null,
    notice: { readonly key: EventKey; readonly message: NoteMessage },
    today: LocalDate,
    now: EpochMs,
    expectRevision: number,
    under: string | null = null,
  ): "stale" | "rested" | "told" {
    return this.tx(() => {
      const current = this.key();
      if (current === null || current.revision !== expectRevision) return "stale";
      const tell = current.health.kind === "ok" || current.health.toldOn !== today;
      this.sql.exec(
        "UPDATE model_key SET fault = ?, failures = MIN(failures + 1, ?), rest_until = ?, told_on = ?, unreadable_under = ? WHERE revision = ?",
        fault,
        KEY_MAX_FAILURES,
        until,
        today,
        under,
        expectRevision,
      );
      if (tell) this.insertMessage(notice.key, notice.message, now);
      return tell ? "told" : "rested";
    });
  }

  keyHealthy(expectRevision: number): void {
    this.sql.exec(
      "UPDATE model_key SET fault = NULL, failures = 0, rest_until = NULL, told_on = NULL, unreadable_under = NULL WHERE fault IS NOT NULL AND revision = ?",
      expectRevision,
    );
  }

  recordGroup(group: AgentKey, version: number): void {
    this.sql.exec(
      "INSERT INTO owned_group (group_key, version) VALUES (?, ?) ON CONFLICT (group_key) DO UPDATE SET version = excluded.version",
      group,
      version,
    );
  }

  ownsGroup(group: AgentKey, version: number): boolean {
    return this.sql.exec("SELECT 1 FROM owned_group WHERE group_key = ? AND version = ?", group, version).toArray().length > 0;
  }

  compactionInput(): CompactionInput {
    const memory = this.sql.exec<{ summary: string; through_turn_seq: number }>("SELECT summary, through_turn_seq FROM memory").one();
    const through = memory.through_turn_seq;
    const kept = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM turn WHERE seq <= ?", through).one().n;
    return {
      summary: memory.summary,
      throughSeq: through,
      turnCount: this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM turn WHERE seq > ?", through).one().n,
      oldestTurns: this.sql
        .exec<{ seq: number; role: TurnRow["role"]; text: string; at: EpochMs }>("SELECT seq, role, text, at FROM turn ORDER BY seq LIMIT ?", kept + COMPACTION.foldTurns)
        .toArray(),
      noteCount: this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM memory_note").one().n,
      oldestNotes: this.sql
        .exec<{ id: number; text: string }>("SELECT id, text FROM memory_note ORDER BY id LIMIT ?", COMPACTION.foldNotes)
        .toArray(),
    };
  }

  commitCompaction(c: CompactionCommit, now: EpochMs): boolean {
    return this.tx(() => {
      const swapped = this.sql.exec(
        `UPDATE memory SET summary = ?, through_turn_seq = ?, updated_at = ?, compaction_failures = 0, compaction_retry_at = 0
         WHERE through_turn_seq = ?`,
        c.summary,
        c.throughSeq,
        now,
        c.expectThroughSeq,
      ).rowsWritten;
      if (swapped === 0) return false;
      if (c.deleteSeqs.length > 0) this.sql.exec(`DELETE FROM turn WHERE seq IN (${placeholders(c.deleteSeqs.length)})`, ...c.deleteSeqs);
      if (c.deleteNoteIds.length > 0) {
        this.sql.exec(`DELETE FROM memory_note WHERE id IN (${placeholders(c.deleteNoteIds.length)})`, ...c.deleteNoteIds);
      }
      return true;
    });
  }

  compactionRetryAt(): EpochMs {
    return this.sql.exec<{ t: EpochMs }>("SELECT compaction_retry_at AS t FROM memory").one().t;
  }

  compactionFailed(now: EpochMs): void {
    const { failures } = this.sql.exec<{ failures: number }>("SELECT compaction_failures AS failures FROM memory").one();
    const backoff = Math.min(COMPACTION_RETRY_BASE_MS * 2 ** failures, COMPACTION_RETRY_MAX_MS);
    this.sql.exec("UPDATE memory SET compaction_failures = compaction_failures + 1, compaction_retry_at = ?", now + backoff);
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
      .map((r) => queuedLog(fromJson<LogRow>(r.row)));
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
    readonly channelEventWaiting: boolean;
    readonly earliestWakeups: readonly { readonly origin: WakeupOrigin; readonly dueAt: EpochMs }[];
    readonly outboxReadyAt: EpochMs | null;
    readonly logsReadyAt: EpochMs | null;
    readonly compactionRetryAt: EpochMs | null;
    readonly boxAt: EpochMs | null;
  } {
    const min = (query: string) => this.sql.exec<{ t: EpochMs | null }>(query).one().t;
    const compaction = this.sql
      .exec<{ retry_at: EpochMs; turns: number; notes: number }>(
        `SELECT compaction_retry_at AS retry_at, (SELECT COUNT(*) FROM turn WHERE seq > memory.through_turn_seq) AS turns,
           (SELECT COUNT(*) FROM memory_note) AS notes
         FROM memory`,
      )
      .one();
    return {
      inboxReadyAt: min("SELECT (SELECT ready_at FROM inbox WHERE status IN ('pending', 'processing') ORDER BY seq LIMIT 1) AS t"),
      channelEventWaiting: this.channelEventWaiting(),
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
    this.tx(() => {
      const agent = this.agent()?.key;
      if (!agent) return;
      const idle = this.sql.exec<{ id: TaskId }>("SELECT id FROM task WHERE status = 'open' AND touched_at < ?", now - TASK_IDLE_MS).toArray();
      for (const { id } of idle) {
        this.recordFact(agent, id, { kind: "expired", ref: "", detail: {}, cause: { key: eventKey.prune(now), kind: "prune", at: now } }, now);
      }
    });
    this.sql.exec("DELETE FROM inbox WHERE status IN ('done', 'failed') AND finished_at < ?", now - DEDUPE_WINDOW_MS);
    this.sql.exec("DELETE FROM outbox WHERE status IN ('sent', 'dropped') AND closed_at < ?", now - OUTBOX_KEEP_MS);
    this.sql.exec("DELETE FROM billing_event WHERE at < ?", now - DEDUPE_WINDOW_MS);
  }
}
