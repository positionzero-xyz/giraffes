/**
 * Every method is synchronous: SQLite calls in a Durable Object don't await, so a method body is
 * atomic with respect to other requests.
 */
import { createHash } from "node:crypto";
import { plainText } from "../channels/channel";
import type { PaidPlan, PlanRow, Standing, SubscriptionId } from "../billing/plan";
import type { CheckoutId } from "../billing/stripe";
import { canonicalJsonObject, parseJsonObject, type JsonObject } from "../action/json";
import type {
  ApprovalConsumption,
  ApprovalDecision,
  NewOutsideApproval,
  NewOutsideWrite,
  OutsideApproval,
  OutsideApprovalId,
  OutsideApprovalStatus,
  OutsideWrite,
  OutsideWriteId,
  OutsideWritePut,
  OutsideWriteStatus,
  WriteFinish,
  WriteReconciliation,
} from "../action/writes";
import type { BoxHostKind } from "../box/host";
import { dueAt, type Box, type BoxState, type ReclaimReason } from "../box/machine";
import { commandOf } from "./commands";
import { REMINDER_ITEM, renderSavedPage, snapshotSavedItems, savedPageNotice, type SavedCursor, type SavedPage } from "./saved-items";
import { FORGET_TEXT, type Backups, type Deleted, type Receipt } from "./forget-text";
import type { BoxName, BoxSetup } from "../box/names";
import {
  assertNever,
  buttonData,
  CHANNEL_LANGUAGE,
  mayspend,
  choiceToken,
  type Admission,
  type Cohort,
  type Half,
  type InviteCode,
  type Seat,
  type WaitlistReason,
  eventKey,
  parseChoice,
  parseWakeupKey,
  personDecision,
  proposalId,
  type AgentEvent,
  type MessageQuote,
  type AgentEventKind,
  type AgentKey,
  type ChannelId,
  type EpochMs,
  type EventKey,
  type FactCause,
  type ForgetEpoch,
  type FactKind,
  type Identity,
  type InboundEnvelope,
  type Intent,
  type Language,
  type LocalDate,
  type LocalDateTime,
  type MicroUsd,
  type OutboundMessage,
  type OutboxId,
  type PersonStatus,
  type ReplyHandle,
  type ProposalId,
  type ProviderMessageReference,
  type Repeat,
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
import { diagnosticRow, modelCallRow, type Backend, type LogRow } from "../ledger/ledger";
import { NOTICES } from "../notices";
import { bytesOf } from "../model/prompt";
import type { KeyFault, SchemaMode } from "../model/client";
import type { Auth, ModelRef, ProviderId } from "../model/providers";
import type { CallPurpose } from "../model/routes";
import { SCHEDULE, type Firing, type NewWakeup, type PendingWakeup } from "../policy/schedule";
import { quietUntil } from "../policy/outreach";
import { DEFAULT_TIME_ZONE, fromLocal, toLocal } from "../policy/time";
import type { MonthSpend, SpendScope } from "../policy/spend";
import type { Sealed, StoredKey } from "../access/key";
import { COMPACTION, compactionDue, type CompactionCommit, type CompactionInput } from "./compaction";
import {
  nextStatus,
  TASKS,
  type AcceptableProposal,
  type OpenTask,
  type ProposalStatus,
  type TappedProposal,
  type TaskCommit,
  type TaskTarget,
  type UnaskedPurpose,
} from "./tasks";
import type { AdmissionChange, AdmissionCommit } from "./admission";
import { coveredByForget, laterCutoff, newForgetCode, providerOrder, quoteAfterForget, type Claim, type ForgetCommand, type ForgetState, type ProviderOrder } from "./forget";
import { clipCorrectedCopy, correctSlug, correctText, correctTracked, jsonStrings, legacyAgentSpans, legacyNoteSpans, type Correction, type CorrectionSpan } from "./correct";
import { DROP_PRIVATE_INBOX_QUOTES, privateQuoteMatch, ROUTINE_OUTBOX } from "./schema";
import { TURN, type Asked, type Batch, type BoxReplyBackfill, type BoxSession, type BoxSessionSeen, type InboxItem, type Outbound, type SeqTurn, type TurnCommit, type TurnRow } from "./turn";

const REMINDER_WORDS = "kind = 'reminder' AND bookkeeping = 0";

const cappedWords = (limit: number, size: (text: string) => number = (text) => text.length, where = "1") =>
  ({ limit, size, where });

export const CAPPED_WORD_COLUMNS = {
  memory: { summary: cappedWords(COMPACTION.maxSummaryBytes, bytesOf) },
  memory_note: { text: cappedWords(TURN.maxNoteBytes, bytesOf) },
  proposal: { text: cappedWords(TASKS.maxPlanChars) },
  task: { title: cappedWords(TASKS.maxTitleBytes, bytesOf) },
  wakeup: { note: cappedWords(TURN.maxNoteBytes, bytesOf, REMINDER_WORDS) },
};

export type AgentRow = {
  readonly key: AgentKey;
  readonly identity: Identity;
  readonly tz: TimeZone;
  readonly language: Language;
  readonly checkinLocal: TimeOfDay;
  readonly status: PersonStatus;
  readonly statusAt: EpochMs;
};

export type RateEventKind = "feedback" | "invite";

/** `answer`: the notice answers the person's own action in this handling. `background`: an alarm or background job produced it. */
export type NoticeTrigger = "answer" | "background";
export type OutboxTriggerKind = AgentEventKind | "background";

type SavedReference = SavedCursor & { readonly snapshot: string | null };

export type OutboxRow = Omit<OutboundMessage, "texts"> & {
  readonly eventKey: EventKey;
  /** Set on the forget's own messages: its pages, notices and receipt, which may go out during its hold. */
  readonly privacy: Privacy | null;
  readonly epoch: ForgetEpoch | null;
  readonly inDoubt: boolean;
  readonly triggerKind: OutboxTriggerKind;
  readonly admittedDay: LocalDate | null;
  readonly routine: boolean;
  readonly attempts: number;
  readonly taskId: TaskId | null;
  readonly purpose: UnaskedPurpose | null;
} & (
  | { readonly saved: null; readonly texts: OutboundMessage["texts"] }
  | { readonly saved: SavedReference }
);

export type Privacy = "page" | "notice" | "receipt";

/** The person's open forget: where it is, and when it next retries its box erase. */
export type ForgetOp = {
  readonly op: string;
  readonly epoch: ForgetEpoch;
  readonly phase: "review" | "erase" | null;
  readonly code: string | null;
  readonly listed: boolean;
  readonly retryAt: EpochMs | null;
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
type InboxCols = { event_key: EventKey; payload: string; attempts: number; received_at: EpochMs; catch_up: NonNullable<InboxItem["catchUp"]> | null };
type QueuedInboxCols = InboxCols & { seq: number; kind: AgentEventKind; ready_at: EpochMs };
type BatchRowsPlan =
  | { readonly kind: "claim"; readonly rows: readonly QueuedInboxCols[]; readonly catchUp: boolean }
  | { readonly kind: "wait"; readonly at: EpochMs }
  | { readonly kind: "none" };

export const MESSAGE_QUIET_WINDOW_MS = 2_000;
export const MESSAGE_WAIT_CEILING_MS = 6_000;

type WaitingPlainMessage = { readonly receivedAt: EpochMs; readonly readyAt: EpochMs };
export type PlainMessageStart = { readonly kind: "start" } | { readonly kind: "wait"; readonly at: EpochMs };

export function plainMessageStart(messages: readonly WaitingPlainMessage[], now: EpochMs, canGrow = true): PlainMessageStart {
  if (messages.length === 0) return { kind: "start" };
  const first = messages[0];
  const newest = messages[messages.length - 1];
  const quietAt = newest.receivedAt + MESSAGE_QUIET_WINDOW_MS;
  const ceilingAt = first.receivedAt + MESSAGE_WAIT_CEILING_MS;
  const readyAt = Math.max(...messages.map((m) => m.readyAt));
  const startAt = Math.max(readyAt, canGrow ? Math.min(quietAt, ceilingAt) : 0) as EpochMs;
  return startAt <= now ? { kind: "start" } : { kind: "wait", at: startAt };
}

const CATCH_UP_WINDOW_MS = 24 * 60 * 60_000;
const WAITING_FOR_ACCESS = `status = 'done' AND catch_up = 'earlier' AND received_at >= ?
  AND (outcome = 'no_access' OR (outcome = 'refused_budget' AND catch_up_budget IS NOT NULL))`;
type WakeupCols = {
  id: WakeupId;
  key: WakeupKey;
  kind: PendingWakeup["kind"];
  origin: WakeupOrigin;
  note: string;
  due_at: EpochMs;
  task_id: TaskId | null;
  bookkeeping: number;
  repeat: Repeat["every"] | null;
  repeat_anchor: LocalDateTime | null;
};
const WAKEUP_COLS = "id, key, kind, origin, note, due_at, task_id, bookkeeping, repeat, repeat_anchor";
type OutboxCols = {
  id: OutboxId;
  event_key: EventKey;
  trigger_kind: OutboxTriggerKind;
  intent: Intent;
  texts: string;
  reply_token: string | null;
  reply_expires: EpochMs | null;
  admitted_day: LocalDate | null;
  routine: number;
  in_doubt: number;
  attempts: number;
  task_id: TaskId | null;
  purpose: UnaskedPurpose | null;
  choice: string | null;
  reply_only: number;
  saved_snapshot: string | null;
  saved_item: number | null;
  saved_offset: number | null;
  privacy: Privacy | null;
  epoch: ForgetEpoch | null;
};
type SavedState = { snapshot: string | null; snapshot_revision: number | null; revision: number; cursor_item: number; cursor_offset: number };
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

type OutsideWriteCols = {
  id: OutsideWriteId;
  intent: string;
  provider: string;
  action: string;
  operation_id: OutsideWrite["operationId"];
  args: string;
  epoch: ForgetEpoch;
  status: OutsideWriteStatus;
  attempt: number;
  in_doubt: number;
  lease_until: EpochMs | null;
  receipt: string | null;
  failure: string | null;
  created_at: EpochMs;
  updated_at: EpochMs;
};

type OutsideApprovalCols = {
  id: OutsideApprovalId;
  write_id: OutsideWriteId;
  owner_key: OutsideApproval["owner"];
  status: OutsideApprovalStatus;
  expires_at: EpochMs;
  created_at: EpochMs;
  decided_at: EpochMs | null;
  decided_by: OutsideApproval["owner"] | null;
  consumed_at: EpochMs | null;
};

type BoxCols = {
  name: BoxName;
  host: BoxHostKind;
  url: string;
  setup: BoxSetup | null;
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
export type BillingAlertSettlement = {
  readonly subscriptionIds: string;
  readonly text: string | undefined;
} & (
  | { readonly kind: "retry" | "unavailable"; readonly delayMs: number }
  | { readonly kind: "migrated"; readonly chatId: string }
  | { readonly kind: "sent" }
);

const DAY_MS = 24 * 60 * 60 * 1000;
const DEDUPE_WINDOW_MS = 14 * DAY_MS;
const OUTBOX_KEEP_MS = 30 * DAY_MS;
const LOG_RETRY_BASE_MS = 10_000;
const LOG_RETRY_MAX_MS = 60 * 60 * 1000;
const COMPACTION_RETRY_BASE_MS = 5 * 60 * 1000;
const COMPACTION_RETRY_MAX_MS = DAY_MS;
const TASK_IDLE_MS = 30 * DAY_MS;
const KEY_MAX_FAILURES = 20;
const ERASE_RETRY_BASE_MS = 30_000;
const ERASE_RETRY_MAX_MS = 60 * 60 * 1000;
/** A forget still erasing after this long tells the person it's pending. */
const ERASE_NOTICE_MS = 2 * 60 * 1000;
const FORGET_REMINDER_MS = DAY_MS;
const FORGET_REMINDERS = 3;
const HELD_NOTICE_MS = 60 * 60 * 1000;

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

function quoteDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function fromJson<T>(text: string): T {
  return JSON.parse(text);
}

function jsonObject(text: string): JsonObject {
  const parsed = parseJsonObject(JSON.parse(text));
  if (parsed === undefined) throw new Error("invalid JSON object in durable state");
  return parsed;
}

function toOutsideWrite(r: OutsideWriteCols): OutsideWrite {
  return {
    id: r.id,
    intent: r.intent,
    provider: r.provider,
    action: r.action,
    operationId: r.operation_id,
    args: jsonObject(r.args),
    epoch: r.epoch,
    status: r.status,
    attempt: r.attempt,
    inDoubt: r.in_doubt === 1,
    leaseUntil: r.lease_until,
    receipt: r.receipt === null ? null : jsonObject(r.receipt),
    failure: r.failure,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toOutsideApproval(r: OutsideApprovalCols): OutsideApproval {
  return {
    id: r.id,
    writeId: r.write_id,
    owner: r.owner_key,
    status: r.status,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    decidedBy: r.decided_by,
    consumedAt: r.consumed_at,
  };
}

/** The id D1 knows a task by, unique across people. */
export const globalTaskId = (agent: AgentKey, task: TaskId): string => `${agent}|t${task}`;

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");

function toWakeup(r: WakeupCols): PendingWakeup {
  const base = { id: r.id, key: r.key, note: r.note, dueAt: r.due_at };
  if (r.kind === "checkin") return { ...base, kind: "checkin", origin: "system" };
  const repeat = r.repeat && r.repeat_anchor ? { every: r.repeat, anchor: r.repeat_anchor } : null;
  return { ...base, kind: "reminder", origin: r.origin === "person" ? "person" : "agent", task: r.task_id, bookkeeping: r.bookkeeping === 1, repeat };
}

function toInboxItem(r: InboxCols): InboxItem {
  return { key: r.event_key, event: fromJson<AgentEvent>(r.payload), attempts: r.attempts, receivedAt: r.received_at, catchUp: r.catch_up ?? undefined };
}

function toBox(r: BoxCols): Box {
  const base = { name: r.name, host: r.host, url: r.url, setup: r.setup, stateAt: r.state_at, retireAt: r.retire_at, image: r.image, ensureAt: r.ensure_at };
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

function button(choice: string | null, language: Language, epoch: ForgetEpoch): Pick<OutboundMessage, "button"> {
  const c = choice === null ? null : parseChoice(choice);
  if (c === null || choice === null) return {};
  const t = NOTICES[language];
  return { button: { label: c.kind === "accept" ? t.acceptButton : c.kind === "consent" ? t.consentButton : t.backupButton, data: buttonData(choice, epoch) } };
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
      readonly startBoundary?: EpochMs;
    },
    now: EpochMs,
    privacy: ForgetCommand | null = null,
  ): "inserted" | "duplicate" | "stale" {
    return this.tx(() => {
      const forget = this.forget();
      if (coveredByForget(envelope, forget)) return "stale";
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
        if (first.startBoundary !== undefined) {
          this.sql.exec("UPDATE forget SET epoch = ?, cutoff_at = ?, cutoff_seq = NULL", first.startBoundary, first.startBoundary);
        }
        this.insertLogs(
          [{ stream: "agent", id: `agent:${envelope.agent}`, agent: envelope.agent, channel: envelope.identity.channel, firstSeenAt: now }],
          now,
        );
        if (first.admit) {
          this.writeAdmission({ next: { state: "admitted", seat: first.admit, at: now }, change: "consented", ensureCheckin: first.checkin }, now);
        }
      }
      if (privacy) return this.privacy(envelope, privacy, now);
      const event = envelope.event;
      const safe = event.kind === "message" && event.quote?.kind === "text"
        ? { ...event, quote: this.incomingQuote(event.quote, forget, now) } : event;
      const stored = this.insertInbox(envelope.key, safe, envelope.receivedAt, now);
      if (stored === "inserted" && event.kind === "message") this.tellHeld(event.reply, now);
      return stored;
    });
  }

  private privateQuote(id: string | undefined, at: EpochMs): boolean {
    return this.sql.exec(
      `SELECT 1 FROM (SELECT ? AS id, ? AS at) q WHERE ${privateQuoteMatch("q.id", "q.at")}`, id ?? null, at,
    ).toArray().length > 0;
  }

  private incomingQuote(quote: Extract<MessageQuote, { kind: "text" }>, forget: ForgetState, now: EpochMs): MessageQuote | undefined {
    if (!quoteAfterForget(quote.at, forget) || this.privateQuote(quote.id, quote.at)) return undefined;
    if (quote.at <= now && this.sql.exec(
      "SELECT 1 FROM outbox WHERE status = 'sending' AND transient = 1 AND created_at <= ? LIMIT 1", quote.at + 999,
    ).toArray().length > 0) return undefined;
    const cutoff = this.sql.exec<{ quote_rewrites_before: number | null }>("SELECT quote_rewrites_before FROM forget").one().quote_rewrites_before;
    if (cutoff === null) return quote;

    if (quote.id !== undefined) {
      const sent = this.sql.exec<{ texts: string }>(
        "SELECT texts FROM outbox WHERE telegram_message_id = ? AND status = 'sent' AND transient = 0 ORDER BY created_at DESC LIMIT 1", quote.id,
      ).toArray()[0];
      if (sent) {
        const text = plainText(fromJson<string[]>(sent.texts).join("\n\n"));
        return text ? { ...quote, text } : undefined;
      }
    }
    if (quote.at > cutoff) return quote;
    const rewrite = this.sql.exec<{ text: string }>(
      "SELECT text FROM quote_rewrite WHERE digest = ? AND text IS NOT NULL", quoteDigest(quote.text),
    ).toArray()[0];
    if (rewrite) return { ...quote, text: rewrite.text };

    const copies = this.sql.exec<{ texts: string }>(
      `SELECT texts FROM outbox WHERE status = 'sent' AND transient = 0
       AND closed_at >= ? AND created_at <= ?`, quote.at, quote.at + 999,
    );
    for (const { texts } of copies) {
      if (plainText(fromJson<string[]>(texts).join("\n\n")) === quote.text) return quote;
    }
    const personCopy = this.sql.exec(
      "SELECT 1 FROM turn WHERE role = 'person' AND transient = 0 AND at = ? AND text = ? LIMIT 1", quote.at, quote.text,
    ).toArray().length > 0;
    return personCopy ? quote : undefined;
  }

  private insertInbox(key: EventKey, event: AgentEvent, receivedAt: EpochMs, readyAt: EpochMs): "inserted" | "duplicate" {
    // An ignored insert still reports rows written here, so only a returned row proves the insert.
    const inserted = this.sql.exec(
      "INSERT OR IGNORE INTO inbox (event_key, kind, payload, received_at, ready_at) VALUES (?, ?, ?, ?, ?) RETURNING seq",
      key,
      event.kind,
      JSON.stringify(event),
      receivedAt,
      readyAt,
    ).toArray();
    return inserted.length > 0 ? "inserted" : "duplicate";
  }

  recover(now: EpochMs, instance: string): Batch | null {
    const agent = this.agent();
    if (!agent) return null;
    return this.tx(() => {
      this.expireCatchUp("processing", now);
      const interrupted = this.sql.exec(
        `INSERT OR IGNORE INTO private_quote_window (start_at, end_at, id_missing)
         SELECT created_at, MAX(created_at, ?), 1 FROM outbox WHERE status = 'sending' AND transient = 1`, now,
      ).rowsWritten;
      if (interrupted > 0) this.sql.exec(DROP_PRIVATE_INBOX_QUOTES);
      const inFlight = this.sql
        .exec<InboxCols>("SELECT event_key, payload, attempts, received_at, catch_up FROM inbox WHERE status = 'processing' ORDER BY seq")
        .toArray()
        .map((r) => this.inboxItem(r));
      const batch = toBatch(inFlight);
      const poisoned = batch && Math.max(...batch.items.map((i) => i.attempts)) >= TURN.maxClaimAttempts ? batch : null;
      if (!poisoned) this.sql.exec("UPDATE inbox SET status = 'pending' WHERE status = 'processing'");
      this.sql.exec("UPDATE outbox SET status = 'pending', in_doubt = 1 WHERE status = 'sending'");
      // An interrupted request might have reached the channel before the result was saved.
      this.sql.exec("UPDATE routine_delivery SET at = ?, sending_id = NULL WHERE sending_id IS NOT NULL", now);
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

  hasWaitingRequests(now: EpochMs, budget: string | null = null): boolean {
    return this.sql.exec(
      `SELECT 1 FROM inbox WHERE ${WAITING_FOR_ACCESS} AND (? IS NULL OR catch_up_budget IS NOT ?) LIMIT 1`,
      now - CATCH_UP_WINDOW_MS,
      budget,
      budget,
    ).toArray().length > 0;
  }

  private expireCatchUp(status: "pending" | "processing", now: EpochMs): void {
    this.sql.exec(
      `UPDATE inbox SET status = 'failed', catch_up = NULL, catch_up_budget = NULL, finished_at = COALESCE(finished_at, ?)
       WHERE status = ? AND catch_up IS NOT NULL AND received_at < ?`,
      now,
      status,
      now - CATCH_UP_WINDOW_MS,
    );
  }

  /** The next batch and the claim it was taken under; none while a forget is open. */
  claimBatch(now: EpochMs, catchUpBudget: string | null): { readonly batch: Batch; readonly claim: Claim } | null {
    return this.tx(() => {
      const claim = this.claim();
      const batch = claim && this.nextBatch(now, catchUpBudget);
      return claim && batch ? { batch, claim } : null;
    });
  }

  private nextBatch(now: EpochMs, catchUpBudget: string | null): Batch | null {
    this.expireCatchUp("pending", now);
    const plan = this.planBatchRows(now, catchUpBudget);
    return plan.kind === "claim" ? this.claimRows(plan.rows, plan.catchUp) : null;
  }

  private planBatchRows(now: EpochMs, catchUpBudget: string | null): BatchRowsPlan {
    const retry = this.sql.exec<QueuedInboxCols>(
      "SELECT seq, event_key, kind, payload, attempts, received_at, ready_at, catch_up FROM inbox WHERE status = 'pending' AND catch_up IS NOT NULL ORDER BY seq",
    ).toArray();
    if (retry.length > 0) {
      return retry[0].ready_at <= now ? { kind: "claim", rows: retry, catchUp: true } : { kind: "wait", at: retry[0].ready_at };
    }

    const ready = this.sql
      .exec<QueuedInboxCols>(
        `SELECT seq, event_key, kind, payload, attempts, received_at, ready_at, catch_up FROM inbox
         WHERE status = 'pending' ORDER BY seq LIMIT ?`,
        catchUpBudget === null ? TURN.maxBatchMessages : -1,
      )
      .toArray();
    const [head] = ready;
    const earlier = catchUpBudget !== null
      ? this.sql.exec<QueuedInboxCols>(
        `SELECT seq, event_key, kind, payload, attempts, received_at, ready_at, catch_up FROM inbox
         WHERE ${WAITING_FOR_ACCESS} AND catch_up_budget IS NOT ? ORDER BY seq`,
        now - CATCH_UP_WINDOW_MS,
        catchUpBudget,
      ).toArray()
      : [];
    if (!head) return earlier.length > 0 ? { kind: "claim", rows: earlier, catchUp: true } : { kind: "none" };
    const joins = (r: QueuedInboxCols) => {
      if (r.kind !== "message" || r.ready_at > now) return false;
      const event = fromJson<AgentEvent>(r.payload);
      return commandOf(event) === null && !(event.kind === "message" && event.text.trimStart().startsWith("/"));
    };
    if (head.ready_at > now) return { kind: "wait", at: head.ready_at };
    if (!joins(head)) return { kind: "claim", rows: [head], catchUp: false };
    const end = ready.findIndex((r) => !joins(r));
    const messages = end === -1 ? ready : ready.slice(0, end);
    const rows = earlier.length > 0
      ? [...earlier, ...messages].sort((a, b) => a.seq - b.seq)
      : messages.slice(0, TURN.maxBatchMessages);
    const canGrow = earlier.length === 0 && end === -1 && messages.length < TURN.maxBatchMessages;
    const start = plainMessageStart(rows.map((r) => ({ receivedAt: r.received_at, readyAt: r.ready_at })), now, canGrow);
    return start.kind === "wait" ? start : { kind: "claim", rows, catchUp: earlier.length > 0 };
  }

  private claimRows(rows: readonly QueuedInboxCols[], catchUp: boolean): Batch | null {
    if (rows.length === 0) return null;
    this.sql.exec(
      `UPDATE inbox SET status = 'processing', attempts = attempts + 1,
         catch_up = CASE WHEN ? THEN COALESCE(catch_up, 'joined') ELSE NULL END
       WHERE event_key IN (SELECT value FROM json_each(?))`,
      catchUp ? 1 : 0,
      JSON.stringify(rows.map((r) => r.event_key)),
    );
    return toBatch(rows.map((r) => this.inboxItem({ ...r, attempts: r.attempts + 1, catch_up: catchUp ? r.catch_up ?? "joined" : null })));
  }

  private inboxItem(r: InboxCols): InboxItem {
    const item = toInboxItem(r);
    const e = item.event;
    if (e.kind !== "message" || e.quote === undefined) return item;
    const quote = e.quote.kind === "text" ? e.quote : this.lineMessageQuote(e.quote.id);
    return { ...item, event: { ...e, quote: quote && quoteAfterForget(quote.at, this.forget()) ? quote : undefined } };
  }

  private lineMessageQuote(id: string) {
    const r = this.sql
      .exec<{ texts: string; position: number; created_at: EpochMs }>(
        `SELECT o.texts, l.position, l.created_at FROM line_message l JOIN outbox o ON o.id = l.outbox_id WHERE l.id = ? AND o.transient = 0
         AND NOT EXISTS (SELECT 1 FROM private_quote_id WHERE id = l.id)`,
        id,
      )
      .toArray()[0];
    const text = r && fromJson<string[]>(r.texts)[r.position];
    return text === undefined ? undefined : { kind: "text" as const, text, at: r.created_at };
  }

  releaseBatch(keys: readonly EventKey[], readyAt: EpochMs, logs: readonly LogRow[], now: EpochMs): void {
    this.tx(() => {
      this.sql.exec(
        "UPDATE inbox SET status = 'pending', ready_at = ? WHERE status = 'processing' AND event_key IN (SELECT value FROM json_each(?))",
        readyAt,
        JSON.stringify(keys),
      );
      this.insertLogs(logs, now);
    });
  }

  toldToday(outcome: "refused_budget" | "lapsed" | "no_access", dayStart: EpochMs): boolean {
    return (
      this.sql.exec("SELECT 1 FROM inbox WHERE outcome = ? AND finished_at >= ? AND kind IN ('message', 'lifecycle') LIMIT 1", outcome, dayStart).toArray()
        .length > 0
    );
  }

  /** Records one event and answers whether the rolling window was already full. */
  rateLimited(kind: RateEventKind, now: EpochMs, windowMs: number, limit: number): boolean {
    return this.tx(() => {
      this.sql.exec("DELETE FROM rate_event WHERE kind = ? AND at <= ?", kind, now - windowMs);
      const count = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM rate_event WHERE kind = ?", kind).one().n;
      if (count >= limit) return true;
      this.sql.exec("INSERT INTO rate_event (kind, at) VALUES (?, ?)", kind, now);
      return false;
    });
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

  private logAdmission(change: AdmissionChange, reason: Cohort | WaitlistReason | null, now: EpochMs): void {
    const a = this.agent();
    if (!a) return;
    const id = `${a.key}|a${change}|${now}`;
    this.insertLogs([{ stream: "admission", id, agent: a.key, change, reason, channel: a.identity.channel, at: now }], now);
  }

  /**
   * The operator takes a person out of the beta. Their seat stays used, their saved key is deleted, their key links
   * stop working, and every pending push is dropped with reason removed.
   */
  remove(now: EpochMs): void {
    this.tx(() => {
      this.deleteKey();
      if (this.admission().state === "removed") return;
      this.writeAdmission({ next: { state: "removed", at: now }, change: "removed", ensureCheckin: null }, now);
      this.sql.exec("DELETE FROM key_ticket");
      const agent = this.agent()?.key;
      const unasked = this.sql
        .exec<{ id: OutboxId; trigger_kind: AgentEventKind; task_id: TaskId | null; purpose: UnaskedPurpose | null }>(
          "SELECT id, trigger_kind, task_id, purpose FROM outbox WHERE status = 'pending' AND intent = 'unasked'",
        )
        .toArray();
      this.sql.exec("UPDATE outbox SET status = 'dropped', drop_reason = 'removed', closed_at = ? WHERE status = 'pending' AND privacy IS NULL", now);
      if (!agent) return;
      this.insertLogs(
        unasked.map(
          (r): LogRow => ({
            stream: "unasked",
            id: r.id,
            agent,
            triggerKind: r.trigger_kind,
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
    readonly recent: readonly SeqTurn[];
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
      .exec<SeqTurn>("SELECT seq, role, text, at FROM turn WHERE seq > ? ORDER BY seq DESC LIMIT ?", memory.through, limitTurns)
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
           AND o.id = (SELECT id FROM outbox WHERE status = 'sent' AND saved_item IS NULL ORDER BY closed_at DESC, rowid DESC LIMIT 1)`,
      )
      .toArray()[0];
    return r ? { id: r.id, task: r.task_id, version: r.version, sentAt: r.sent_at } : null;
  }

  private tapped(batch: Batch): readonly TappedProposal[] {
    const ids = batch.items.flatMap((i) => (i.event.kind === "choice" && i.event.choice.kind === "accept" ? [i.event.choice.proposal] : []));
    if (ids.length === 0) return [];
    return this.sql
      .exec<{ id: ProposalId; task_id: TaskId; version: number; status: ProposalStatus; task_status: TaskStatus; sent_at: EpochMs | null }>(
        `SELECT p.id, p.task_id, p.version, p.status, t.status AS task_status,
                CASE WHEN o.status = 'sent' THEN o.closed_at ELSE NULL END AS sent_at
         FROM proposal p JOIN task t ON t.id = p.task_id LEFT JOIN outbox o ON o.id = p.outbox_id
         WHERE p.id IN (${placeholders(ids.length)})`,
        ...ids,
      )
      .toArray()
      .map((r) => ({ id: r.id, task: r.task_id, version: r.version, status: r.status, taskStatus: r.task_status, sentAt: r.sent_at }));
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

  boxSession(): BoxSession | null {
    const r = this.sql.exec<{ id: string | null; seen_seq: number; memory: string; reply_backfill: string }>("SELECT id, seen_seq, memory, reply_backfill FROM box_session").toArray()[0];
    return r ? { id: r.id, seenSeq: r.seen_seq, memory: r.memory, replyBackfill: fromJson(r.reply_backfill) } : null;
  }

  oldestBoxHistory(after: number): readonly SeqTurn[] {
    return this.sql.exec<SeqTurn>(
      "SELECT seq, role, text, at FROM turn WHERE seq > MAX(?, (SELECT through_turn_seq FROM memory)) ORDER BY seq LIMIT ?",
      after,
      COMPACTION.promptTurns,
    ).toArray();
  }

  /**
   * Saves a turn only while its batch is still claimed: a forget that began during the turn closed the batch's rows, so
   * the turn's result is dropped whole. False when it was.
   */
  commitTurn(commit: TurnCommit, logs: readonly LogRow[], now: EpochMs, box: Box | null = null, seen: BoxSessionSeen | null = null): boolean {
    const [firstKey] = commit.batchKeys;
    return this.tx(() => {
      if (!this.stillClaimed(commit.batchKeys)) return false;
      if (box) this.writeBox(box);
      const outboxId = crypto.randomUUID() as OutboxId;
      const tasks = this.applyTasks(commit.tasks, commit.trigger, commit.outbound ? outboxId : null, now);
      let seenSeq = seen?.sentThrough ?? 0;
      let gap = seen !== null && this.sql.exec("SELECT seq FROM turn WHERE seq > ? LIMIT 1", seenSeq).toArray().length > 0;
      const previous = seen ? this.boxSession() : null;
      const replyBackfill: BoxReplyBackfill[] = previous && previous.id === seen?.id ? previous.replyBackfill.filter((r) => r.seq > seenSeq) : [];
      for (const t of commit.turns) {
        const { seq } = this.sql
          .exec<{ seq: number }>(
            "INSERT INTO turn (role, text, at, event_key, transient, correction_spans) VALUES (?, ?, ?, ?, ?, ?) RETURNING seq",
            t.role, t.text, t.at, t.eventKey, commit.transient ? 1 : 0, JSON.stringify(t.spans ?? []),
          )
          .one();
        if (!seen) continue;
        const view = t.boxView;
        gap ||= !view || (view.kind === "reply" && view.notice !== null);
        if (!gap) seenSeq = seq;
        else if (view) replyBackfill.push({ seq, notice: view.kind === "reply" ? view.notice : null });
      }
      if (seen) {
        this.sql.exec(
          `INSERT INTO box_session (one, id, seen_seq, memory, reply_backfill) VALUES (1, ?, ?, ?, ?)
           ON CONFLICT (one) DO UPDATE SET id = excluded.id, seen_seq = excluded.seen_seq, memory = excluded.memory, reply_backfill = excluded.reply_backfill`,
          seen.id,
          seenSeq,
          seen.memory,
          JSON.stringify(replyBackfill),
        );
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
      if (commit.transient) {
        const messages = this.sql.exec<{ at: number; id: string | null }>(
          `SELECT received_at AS at, json_extract(payload, '$.messageId') AS id FROM inbox
           WHERE kind = 'message' AND event_key IN (SELECT value FROM json_each(?))`, JSON.stringify(commit.batchKeys),
        );
        for (const { at, id } of messages) this.blockQuoteWindow(Math.min(at, now), Math.max(at, now), id === null ? [] : [id]);
        this.sql.exec(DROP_PRIVATE_INBOX_QUOTES);
      }
      if (commit.outbound) {
        const o = commit.outbound;
        const choice = o.choice === "accept_pending" ? tasks.proposal : o.choice === "consent" ? choiceToken({ kind: "consent" }) : null;
        this.insertOutbox(outboxId, firstKey, { ...o, taskId: o.link && tasks.resolve(o.link), choice }, now, { transient: commit.transient });
      }
      this.sql.exec(
        `UPDATE inbox SET status = 'done', outcome = ?, finished_at = ?, catch_up = ?, catch_up_budget = ?,
           attempts = CASE WHEN ? THEN 0 ELSE attempts END,
           payload = CASE WHEN ? AND kind = 'message' THEN '{}' ELSE payload END
         WHERE event_key IN (SELECT value FROM json_each(?))`,
        commit.outcome,
        now,
        commit.waitForAccess ? "earlier" : null,
        commit.waitForAccess?.kind === "budget" ? commit.waitForAccess.budget : null,
        commit.waitForAccess ? 1 : 0,
        commit.transient ? 1 : 0,
        JSON.stringify(commit.batchKeys),
      );
      const correctionLogs: LogRow[] = [];
      const turnLog = logs.find((row) => row.stream === "turn");
      for (const [i, c] of commit.corrections.entries()) {
        if (!this.correct(c, now) && turnLog) {
          correctionLogs.push({
            stream: "rejection", id: `${turnLog.id}|correction:${i}`, agent: turnLog.agent, turnId: turnLog.id, reason: "too_long", at: now,
          });
        }
      }
      this.insertLogs(logs.concat(correctionLogs), now);
      return true;
    });
  }

  private blockQuoteWindow(start: number, end: number, ids: readonly string[]): void {
    for (const id of ids) this.sql.exec("INSERT OR IGNORE INTO private_quote_id (id) VALUES (?)", id);
    this.sql.exec(
      "INSERT OR IGNORE INTO private_quote_window (start_at, end_at, id_missing) VALUES (?, ?, ?)",
      start, end, ids.length === 0 ? 1 : 0,
    );
  }

  private correct(c: Correction, now: EpochMs): boolean {
    const keys = this.slugRenames("SELECT DISTINCT key AS v FROM wakeup", `SELECT DISTINCT key AS v FROM wakeup WHERE ${REMINDER_WORDS}`, c, "reminder");
    const refs = this.slugRenames("SELECT DISTINCT ref AS v FROM task", "SELECT DISTINCT ref AS v FROM task", c, "task");
    if (keys === null || refs === null) return false;

    let fits = true;
    const replace = (text: string, limit: number, size: (text: string) => number = (s) => s.length): string => {
      const next = correctText(text, c);
      if (next !== text && size(next) > limit) fits = false;
      return next;
    };
    const spans = {
      person: Infinity, send: TURN.maxTextChars, late: TURN.maxLateNoticeChars, plan: TASKS.maxPlanChars, erase: Infinity,
    } satisfies Record<CorrectionSpan["kind"], number>;
    const rewrite = (record: boolean) => (text: string, kind: CorrectionSpan["kind"]): string => {
      if (!record) return replace(text, spans[kind]);
      const next = correctText(text, c);
      return next !== text && next.length > spans[kind] ? clipCorrectedCopy(next, spans[kind]) : next;
    };

    const updates: (() => void)[] = [];
    const quoteRewrites = new Map<string, string>();
    const rewriteQuote = (before: string, after: string) => {
      if (before !== after) quoteRewrites.set(quoteDigest(before), after);
    };
    const column = (table: string, name: string, edit: (v: string) => string, where = "1") => {
      for (const { id, v } of this.sql.exec<{ id: number; v: string }>(`SELECT rowid AS id, ${name} AS v FROM ${table} WHERE ${where}`)) {
        const next = edit(v);
        if (next !== v) updates.push(() => this.sql.exec(`UPDATE ${table} SET ${name} = ? WHERE rowid = ?`, next, id));
      }
    };
    for (const [table, columns] of Object.entries(CAPPED_WORD_COLUMNS)) {
      for (const [name, { limit, size, where }] of Object.entries(columns)) {
        column(table, name, (v) => replace(v, limit, size), where);
      }
    }
    column("task", "ref", (v) => refs.get(v) ?? v);
    column("wakeup", "key", (v) => keys.get(v) ?? v, REMINDER_WORDS);
    column("quote_rewrite", "text", (text) => {
      const corrected = replace(text, Infinity);
      rewriteQuote(text, corrected);
      return corrected;
    }, "text IS NOT NULL");
    column("inbox", "payload", (v) => {
      const e = fromJson<Partial<AgentEvent>>(v);
      if (e.kind === "message") {
        const text = !e.redacted && typeof e.text === "string" ? replace(e.text, Infinity) : e.text;
        if (e.quote?.kind === "text") {
          const corrected = replace(e.quote.text, Infinity);
          rewriteQuote(e.quote.text, corrected);
          return JSON.stringify({ ...e, text, quote: { ...e.quote, text: corrected } });
        }
        return text === e.text ? v : JSON.stringify({ ...e, text });
      }
      if (e.kind === "wakeup" && !e.bookkeeping && e.key !== undefined && e.note !== undefined) {
        return JSON.stringify({ ...e, key: keys.get(e.key) ?? e.key, note: replace(e.note, TURN.maxNoteBytes, bytesOf) });
      }
      return v;
    });

    const legacyParts = new Map<string, readonly CorrectionSpan[]>();
    const partKey = (eventKey: string, text: string) => JSON.stringify([eventKey, text]);
    const turns = this.sql.exec<{
      seq: number; role: TurnRow["role"]; text: string; event_key: string; transient: number;
      correction_spans: string | null; legacy_plan: number; pending: number;
    }>(
      `SELECT t.seq, t.role, t.text, t.event_key, t.transient, t.correction_spans,
         CASE WHEN t.correction_spans IS NULL AND t.role = 'agent' THEN EXISTS (
           SELECT 1 FROM proposal p JOIN outbox o ON o.id = p.outbox_id
           WHERE o.event_key = t.event_key AND p.text = t.text
         ) ELSE 0 END AS legacy_plan,
         EXISTS (SELECT 1 FROM outbox o WHERE o.event_key = t.event_key AND o.status IN ('pending', 'sending')) AS pending
       FROM turn t LEFT JOIN inbox i ON i.event_key = t.event_key
       WHERE t.correction_spans IS NOT NULL OR t.role IN ('agent', 'note') OR (
         t.role = 'person' AND (
           (i.kind = 'message' AND json_extract(i.payload, '$.redacted') IS NULL) OR
           (i.event_key IS NULL AND t.text NOT GLOB '[[]tapped Accept on plan *]' AND
             t.text NOT IN ('[agreed to the privacy notice]', '[chose to use their key as a backup]'))
         )
       ) ORDER BY t.seq`,
    );
    for (const row of turns) {
      let parts: readonly CorrectionSpan[];
      if (row.correction_spans !== null) {
        parts = fromJson<CorrectionSpan[]>(row.correction_spans);
      } else if (row.role === "person") {
        parts = [{ kind: "person", start: 0, length: row.text.length }];
      } else {
        parts = row.role === "note" ? legacyNoteSpans(row.text, row.event_key) : legacyAgentSpans(row.text, row.event_key, row.legacy_plan !== 0);
        legacyParts.set(partKey(row.event_key, row.text), parts);
      }
      const next = correctTracked(row.text, parts, rewrite(row.pending === 0));
      if (next === null) updates.push(() => this.sql.exec("DELETE FROM turn WHERE seq = ?", row.seq));
      else if (next.text !== row.text) {
        if (!row.transient && row.role === "person") rewriteQuote(row.text, next.text);
        updates.push(() => this.sql.exec(
          "UPDATE turn SET text = ?, correction_spans = ? WHERE seq = ?", next.text, JSON.stringify(next.spans), row.seq,
        ));
      }
    }

    for (const row of this.sql.exec<{
      id: string; texts: string; transient: number; correction_spans: string | null; event_key: string; status: OutboxView["status"];
    }>(
      `SELECT id, texts, transient, correction_spans, event_key, status FROM outbox
       WHERE correction_spans IS NOT NULL OR (privacy IS NULL AND trigger_kind IN ('message', 'choice', 'wakeup', 'checkin', 'lifecycle'))`,
    )) {
      const original = fromJson<string[]>(row.texts);
      const parts = row.correction_spans === null ? null : fromJson<CorrectionSpan[][]>(row.correction_spans);
      const edit = rewrite(row.status === "sent" || row.status === "dropped");
      const revised = original.map((text, i) => {
        if (parts !== null) return correctTracked(text, parts[i], edit);
        if (correctText(text, c) === text) return { text, spans: [] };
        const legacy = legacyParts.get(partKey(row.event_key, text));
        if (legacy !== undefined) return correctTracked(text, legacy, edit);
        const lead = Object.values(NOTICES).find((n) => text.startsWith(n.catchUp + "\n"));
        if (lead) {
          const start = lead.catchUp.length + 1;
          const rest = legacyParts.get(partKey(row.event_key, text.slice(start)));
          if (rest) return correctTracked(text, rest.map((span) => ({ ...span, start: span.start + start })), edit);
        }
        return null;
      });
      const next = revised.filter((part) => part !== null);
      const texts = JSON.stringify(next.map((part) => part.text));
      if (texts === row.texts) continue;
      if (!row.transient && next.length > 0) {
        rewriteQuote(plainText(original.join("\n\n")), plainText(next.map((part) => part.text).join("\n\n")));
      }
      if (next.length !== original.length) {
        updates.push(() => {
          let position = 0;
          for (const [previous, part] of revised.entries()) {
            if (part === null) this.sql.exec("DELETE FROM line_message WHERE outbox_id = ? AND position = ?", row.id, previous);
            else {
              if (position !== previous) this.sql.exec("UPDATE line_message SET position = ? WHERE outbox_id = ? AND position = ?", position, row.id, previous);
              position++;
            }
          }
        });
      }
      if (next.length === 0) {
        updates.push(() => this.sql.exec(
          `UPDATE outbox SET texts = '[]', correction_spans = NULL, choice = NULL, reply_token = NULL, reply_expires = NULL, event_key = 'forgotten',
             status = CASE WHEN status IN ('pending', 'sending') THEN 'dropped' ELSE status END,
             drop_reason = CASE WHEN status IN ('pending', 'sending') THEN 'forgotten' ELSE drop_reason END,
             closed_at = COALESCE(closed_at, ?) WHERE id = ?`, now, row.id,
        ));
      } else {
        updates.push(() => this.sql.exec(
          "UPDATE outbox SET texts = ?, correction_spans = ? WHERE id = ?", texts, JSON.stringify(next.map((part) => part.spans)), row.id,
        ));
      }
    }
    if (!fits) return false;
    for (const update of updates) update();
    for (const [digest, text] of quoteRewrites) {
      this.sql.exec(
        `INSERT INTO quote_rewrite (digest, text, expires_at) VALUES (?, ?, ?)
         ON CONFLICT (digest) DO UPDATE SET text = excluded.text, expires_at = excluded.expires_at WHERE quote_rewrite.text IS NOT NULL`,
        digest, text, now + OUTBOX_KEEP_MS,
      );
    }
    this.sql.exec("UPDATE forget SET quote_rewrites_before = MAX(COALESCE(quote_rewrites_before, 0), ?)", now);
    const writes = this.sql.exec<{ id: string; args: string; receipt: string | null }>("SELECT id, args, receipt FROM outside_write").toArray();
    for (const w of writes.filter((w) => [...jsonStrings(w.args), ...jsonStrings(w.receipt)].some((s) => correctText(s, c) !== s))) {
      this.sql.exec("DELETE FROM outside_approval WHERE write_id = ?", w.id);
      this.sql.exec("DELETE FROM outside_write WHERE id = ?", w.id);
    }
    this.sql.exec("DELETE FROM box_session");
    return true;
  }

  /** Each key or ref among `renamable` the correction changes, mapped to a new one no row in `used` has, so the unique indexes hold. */
  private slugRenames(used: string, renamable: string, c: Correction, fallback: string): ReadonlyMap<string, string> | null {
    const values = (query: string) => this.sql.exec<{ v: string }>(query).toArray().map((r) => r.v);
    const taken = new Set(values(used));
    const renames = new Map<string, string>();
    for (const old of values(renamable)) {
      const base = correctSlug(old, c) || fallback;
      if (base === old) continue;
      let next = base;
      for (let n = 2; taken.has(next); n++) next = `${base}-${n}`;
      if (parseWakeupKey(next) === null) return null;
      taken.add(next);
      renames.set(old, next);
    }
    return renames;
  }

  private stillClaimed(keys: readonly EventKey[]): boolean {
    if (this.held()) return false;
    const { n } = this.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM inbox WHERE status = 'processing' AND event_key IN (SELECT value FROM json_each(?))", JSON.stringify(keys))
      .one();
    return n === new Set(keys).size;
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
      this.insertLogs([{ stream: "task", id: globalTaskId(agent, id), agent, kind: t.kind, causeKind: cause.kind, openedAt: now }], now);
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
    out: Asked & Pick<Outbound, "texts" | "reply" | "replyOnly"> & Partial<Pick<Outbound, "spans">> &
      { readonly triggerKind: OutboxTriggerKind; readonly taskId: TaskId | null; readonly choice: string | null },
    now: EpochMs,
    { readyAt = now, transient = false }: { readonly readyAt?: EpochMs; readonly transient?: boolean } = {},
  ): void {
    this.sql.exec(
      `INSERT INTO outbox (id, event_key, trigger_kind, intent, texts, reply_token, reply_expires, ready_at, created_at, task_id, purpose, choice, reply_only, correction_spans, transient)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      key,
      out.triggerKind,
      out.intent,
      JSON.stringify(out.texts),
      out.reply?.token ?? null,
      out.reply?.expiresAt ?? null,
      readyAt,
      now,
      out.taskId,
      out.intent === "unasked" ? out.purpose : null,
      out.choice,
      out.replyOnly ? 1 : 0,
      out.spans?.some((spans) => spans.length > 0) ? JSON.stringify(out.spans) : null,
      transient ? 1 : 0,
    );
  }

  box(): Box | null {
    const r = this.sql
      .exec<BoxCols>(
        "SELECT name, host, url, setup, state, state_at, link_sent_at, signin_poll_until, attempts, next_at, poll_at, reclaim_at, reclaim_reason, retire_at, image, ensure_at FROM box",
      )
      .toArray()[0];
    return r ? toBox(r) : null;
  }

  private writeBox(b: Box): void {
    const out = b.state === "signed_out" ? b : null;
    this.sql.exec("UPDATE agent SET claude_plan_at = COALESCE(claude_plan_at, ?) WHERE NOT EXISTS (SELECT 1 FROM box)", b.stateAt);
    this.sql.exec(
      `INSERT INTO box (one, name, host, url, setup, state, state_at, link_sent_at, signin_poll_until, attempts, next_at, poll_at, reclaim_at,
         reclaim_reason, retire_at, image, ensure_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (one) DO UPDATE SET name = excluded.name, host = excluded.host, url = excluded.url, setup = excluded.setup, state = excluded.state,
         state_at = excluded.state_at, link_sent_at = excluded.link_sent_at, signin_poll_until = excluded.signin_poll_until,
         attempts = excluded.attempts, next_at = excluded.next_at, poll_at = excluded.poll_at, reclaim_at = excluded.reclaim_at,
         reclaim_reason = excluded.reclaim_reason, retire_at = excluded.retire_at, image = excluded.image, ensure_at = excluded.ensure_at`,
      b.name,
      b.host,
      b.url,
      b.setup,
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

  applyBox(b: Box, message: NoteMessage | null, logs: readonly LogRow[], now: EpochMs, noticeTrigger: NoticeTrigger): void {
    this.tx(() => {
      this.writeBox(b);
      if (message) this.insertMessage(eventKey.box(b.name), message, now, noticeTrigger);
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

  /** The volume the box's /health named; empty when its image names none, null when not read yet. */
  boxVolume(): string | null {
    return this.sql.exec<{ volume: string | null }>("SELECT volume FROM box").toArray()[0]?.volume ?? null;
  }

  setBoxVolume(name: BoxName, volume: string | null): void {
    this.sql.exec("UPDATE box SET volume = ? WHERE name = ?", volume, name);
  }

  forgetClaudePlan(): void {
    this.sql.exec("UPDATE agent SET claude_plan_at = NULL");
  }

  removeBox(name: BoxName, message: NoteMessage | null, now: EpochMs, noticeTrigger: NoticeTrigger): void {
    this.tx(() => {
      this.sql.exec("DELETE FROM box WHERE name = ?", name);
      if (message) this.insertMessage(eventKey.box(name), message, now, noticeTrigger);
    });
  }

  private insertMessage(key: EventKey, message: NoteMessage, now: EpochMs, noticeTrigger: NoticeTrigger, choice: string | null = null): void {
    this.sql.exec("INSERT INTO turn (role, text, at, event_key) VALUES ('note', ?, ?, ?)", message.note, now, key);
    const tz = this.agent()?.tz ?? DEFAULT_TIME_ZONE;
    const readyAt = noticeTrigger === "background" ? quietUntil(now, tz) ?? now : now;
    this.insertOutbox(
      crypto.randomUUID() as OutboxId,
      key,
      { texts: message.texts, intent: "requested", triggerKind: noticeTrigger === "background" ? "background" : "message", replyOnly: false, taskId: null, choice },
      now,
      { readyAt },
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

  applyStanding(s: Standing, message: { readonly key: EventKey; readonly message: NoteMessage } | null, now: EpochMs, noticeTrigger: NoticeTrigger): void {
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
      if (message && this.agent()) this.insertMessage(message.key, message.message, now, noticeTrigger);
    });
  }

  /** Tells the person `message` unless `once` was already told, marking it like a handled Stripe event. */
  notifyOnce(once: string, key: EventKey, message: NoteMessage | null, now: EpochMs, noticeTrigger: NoticeTrigger): void {
    this.tx(() => {
      if (this.billingEventSeen(once)) return;
      if (message && this.agent()) this.insertMessage(key, message, now, noticeTrigger);
      this.billingEventDone(once, now);
    });
  }

  openCheckouts(): readonly { readonly id: CheckoutId; readonly eventKey: EventKey }[] {
    return this.sql
      .exec<{ id: CheckoutId; event_key: EventKey }>("SELECT id, event_key FROM checkout_session WHERE closed = 0 ORDER BY created_at, id")
      .toArray()
      .map((r) => ({ id: r.id, eventKey: r.event_key }));
  }

  checkoutOpened(id: CheckoutId, key: EventKey, now: EpochMs): void {
    this.sql.exec("INSERT OR IGNORE INTO checkout_session (id, event_key, created_at) VALUES (?, ?, ?)", id, key, now);
  }

  checkoutClosed(id: CheckoutId): void {
    this.sql.exec("UPDATE checkout_session SET closed = 1 WHERE id = ?", id);
  }

  checkoutIds(): readonly CheckoutId[] {
    return this.sql.exec<{ id: CheckoutId }>("SELECT id FROM checkout_session ORDER BY created_at, id")
      .toArray().map(({ id }) => id);
  }

  billingEventSeen(id: string): boolean {
    return this.sql.exec("SELECT 1 FROM billing_event WHERE id = ?", id).toArray().length > 0;
  }

  billingEventDone(id: string, now: EpochMs): void {
    this.sql.exec("INSERT OR IGNORE INTO billing_event (id, at) VALUES (?, ?)", id, now);
  }

  queueBillingAlert(ids: string, now: EpochMs): void {
    this.sql.exec("INSERT OR IGNORE INTO billing_alert (subscription_ids, delivery_id, ready_at) VALUES (?, ?, ?)", ids, crypto.randomUUID(), now);
  }

  nextBillingAlert(operatorRoute: string, now: EpochMs) {
    return this.sql.exec<{
      subscription_ids: string; delivery_id: OutboxId; ready_at: EpochMs; notified: number; attempts: number; telegram_redirect: string | null;
    }>(`SELECT subscription_ids, delivery_id, notified, attempts,
          CASE WHEN destination_wait = 1 AND operator_route != ?1 THEN ?2 ELSE ready_at END AS ready_at,
          CASE WHEN operator_route = ?1 THEN telegram_redirect END AS telegram_redirect
        FROM billing_alert WHERE ready_at IS NOT NULL ORDER BY ready_at, subscription_ids LIMIT 1`, operatorRoute, now,
    ).toArray()[0] ?? null;
  }

  startBillingAlertAttempt(ids: string, readyAt: EpochMs, operatorRoute: string): void {
    this.sql.exec(`UPDATE billing_alert SET ready_at = ?1, attempts = attempts + 1, destination_wait = 0,
      telegram_redirect = CASE WHEN operator_route = ?2 THEN telegram_redirect END, operator_route = ?2
      WHERE subscription_ids = ?3`, readyAt, operatorRoute, ids);
  }

  finishBillingAlertAttempt(settlement: BillingAlertSettlement, now: EpochMs): void {
    this.tx(() => {
      const { text, subscriptionIds, kind } = settlement;
      if (text && this.agent()) this.insertMessage(eventKey.billing("duplicate"), { texts: [text], note: text }, now, "background");
      const readyAt = kind === "sent" ? null : kind === "migrated" ? now : now + settlement.delayMs;
      const notified = text ? (kind === "unavailable" ? 2 : 1) : 0;
      this.sql.exec(`UPDATE billing_alert SET ready_at = ?, notified = max(notified, ?), closed_as = ?,
        destination_wait = ?, telegram_redirect = coalesce(?, telegram_redirect) WHERE subscription_ids = ?`,
        readyAt, notified, kind === "sent" ? kind : null, kind === "unavailable" ? 1 : 0,
        kind === "migrated" ? settlement.chatId : null, subscriptionIds);
    });
  }

  appendLogs(logs: readonly LogRow[], now: EpochMs): void {
    this.tx(() => this.insertLogs(logs, now));
  }

  private insertWakeup(w: NewWakeup, createdBy: string, now: EpochMs, task: TaskId | null = null): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO wakeup (key, kind, origin, note, due_at, created_at, created_by, task_id, bookkeeping, repeat, repeat_anchor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      w.key,
      w.kind,
      w.origin,
      w.note,
      w.dueAt,
      now,
      createdBy,
      task,
      w.kind === "reminder" && w.bookkeeping ? 1 : 0,
      w.kind === "reminder" && w.repeat ? w.repeat.every : null,
      w.kind === "reminder" && w.repeat ? w.repeat.anchor : null,
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

  memoryNotes(limit: number): readonly string[] {
    return this.sql
      .exec<{ text: string }>("SELECT text FROM memory_note ORDER BY id DESC LIMIT ?", limit)
      .toArray()
      .map((n) => n.text);
  }

  makeDue(key: WakeupKey, now: EpochMs): boolean {
    return this.sql.exec("UPDATE wakeup SET due_at = ? WHERE key = ? AND status = 'pending'", now, key).rowsWritten > 0;
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

  private savedState(): SavedState {
    return this.sql.exec<SavedState>("SELECT snapshot, snapshot_revision, revision, cursor_item, cursor_offset FROM saved_items").one();
  }

  queueSavedPage(input: { key: EventKey; restart: boolean; reply?: ReplyHandle; replyOnly: boolean; now: EpochMs }): void {
    this.tx(() => {
      const { key, restart, reply, replyOnly, now } = input;
      if (restart) {
        snapshotSavedItems(this.sql);
        this.sql.exec(
          "UPDATE saved_items SET snapshot = ?, snapshot_revision = revision, cursor_item = 0, cursor_offset = 0", crypto.randomUUID(),
        );
      }
      const state = this.savedState();
      this.sql.exec(
        `INSERT INTO outbox (id, event_key, trigger_kind, intent, texts, reply_token, reply_expires, ready_at, created_at, reply_only,
                             saved_snapshot, saved_item, saved_offset)
         VALUES (?, ?, 'message', 'reply', '[]', ?, ?, ?, ?, ?, ?, ?, ?)`,
        crypto.randomUUID(), key, reply?.token ?? null, reply?.expiresAt ?? null, now, now, replyOnly ? 1 : 0,
        state.snapshot, state.cursor_item, state.cursor_offset,
      );
      this.sql.exec("UPDATE inbox SET status = 'done', outcome = 'no_model', finished_at = ? WHERE event_key = ?", now, key);
    });
  }

  savedPage(ref: SavedReference, agent: AgentRow, privacy: boolean = false): SavedPage | null {
    const state = this.savedState();
    if (ref.snapshot === null) return savedPageNotice(agent.language, false);
    if (ref.snapshot !== state.snapshot || ref.item !== state.cursor_item || ref.offset !== state.cursor_offset) return null;
    if (state.snapshot_revision !== state.revision) return savedPageNotice(agent.language, true);
    if (!privacy) return renderSavedPage({ sql: this.sql, cursor: ref, agent });
    const f = this.forgetOp();
    if (f?.phase !== "review" || f.code === null) return null;
    const t = FORGET_TEXT[agent.language];
    return renderSavedPage({ sql: this.sql, cursor: ref, agent, footer: { more: t.listMore, done: t.listDone(f.code) } });
  }

  /** While a forget is open, only its own messages are ready. */
  readyOutbox(now: EpochMs, limit: number): readonly OutboxRow[] {
    const agent = this.agent();
    if (!agent) return [];
    const { epoch, op } = this.forget();
    return this.sql
      .exec<OutboxCols>(
        `SELECT id, event_key, trigger_kind, intent, texts, reply_token, reply_expires, admitted_day, in_doubt, attempts, task_id, purpose, choice, reply_only,
                saved_snapshot, saved_item, saved_offset, privacy, epoch, (${ROUTINE_OUTBOX}) AS routine
         FROM outbox o WHERE status = 'pending' AND ready_at <= ? AND (? = 0 OR epoch = ?) ORDER BY created_at, rowid LIMIT ?`,
        now,
        op === null ? 0 : 1,
        epoch,
        limit,
      )
      .toArray()
      .map((r): OutboxRow => {
        const base = {
          id: r.id,
          to: agent.identity,
          intent: r.intent,
          eventKey: r.event_key,
          triggerKind: r.trigger_kind,
          admittedDay: r.admitted_day,
          routine: r.routine === 1,
          attempts: r.attempts,
          taskId: r.task_id,
          purpose: r.purpose,
          replyOnly: r.reply_only === 1,
          privacy: r.privacy,
          epoch: r.epoch,
          inDoubt: r.in_doubt === 1,
          ...button(r.choice, agent.language, epoch),
          ...(r.in_doubt === 0 && r.reply_token !== null && r.reply_expires !== null
            ? { reply: { token: r.reply_token, expiresAt: r.reply_expires } } : {}),
        };
        return r.saved_item !== null && r.saved_offset !== null
          ? { ...base, saved: { snapshot: r.saved_snapshot, item: r.saved_item, offset: r.saved_offset } }
          : { ...base, saved: null, texts: fromJson<OutboundMessage["texts"]>(r.texts) };
      });
  }

  unaskedAdmitted(day: LocalDate): number {
    return this.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM outbox WHERE intent = 'unasked' AND admitted_day = ?", day)
      .one().n;
  }

  routineSendsInLastDay(now: EpochMs): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM routine_delivery WHERE at > ?", now - DAY_MS).one().n;
  }

  /**
   * False when the row is no longer waiting or a forget began since `epoch`; nothing may then be sent for it. The
   * forget's own messages need only their epoch to be current, since they go out during its hold.
   */
  markSending(id: OutboxId, admittedDay: LocalDate | null, epoch: ForgetEpoch, routineAt: EpochMs | null, privacy: boolean = false): boolean {
    return this.tx(() => {
      if (privacy ? this.forget().epoch !== epoch : !this.live(epoch)) return false;
      const started = this.sql.exec(
        "UPDATE outbox SET status = 'sending', admitted_day = ?, attempts = attempts + 1 WHERE id = ? AND status = 'pending'",
        admittedDay,
        id,
      ).rowsWritten > 0;
      if (started && routineAt !== null) {
        this.sql.exec("INSERT INTO routine_delivery (at, sending_id) VALUES (?, ?)", routineAt, id);
      }
      return started;
    });
  }

  finishRoutineDelivery(id: OutboxId, countedAt: EpochMs | null): void {
    if (countedAt === null) this.sql.exec("DELETE FROM routine_delivery WHERE sending_id = ?", id);
    else this.sql.exec("UPDATE routine_delivery SET at = ?, sending_id = NULL WHERE sending_id = ?", countedAt, id);
  }

  markSent(
    id: OutboxId,
    via: "reply" | "push",
    now: EpochMs,
    logs: readonly LogRow[],
    next: SavedCursor | null = null,
    providerMessages: readonly ProviderMessageReference[] = [],
  ): void {
    this.tx(() => {
      if (next !== null) {
        this.sql.exec(
          `UPDATE saved_items SET cursor_item = ?, cursor_offset = ? WHERE snapshot_revision = revision AND EXISTS (
             SELECT 1 FROM outbox WHERE id = ? AND status = 'sending' AND saved_snapshot = snapshot
               AND saved_item = cursor_item AND saved_offset = cursor_offset)`,
          next.item, next.offset, id,
        );
      } else if (this.sql.exec("SELECT 1 FROM outbox WHERE id = ? AND privacy = 'page'", id).toArray().length > 0) {
        this.sql.exec("UPDATE forget SET listed = 1 WHERE phase = 'review' AND epoch = (SELECT epoch FROM outbox WHERE id = ? AND status = 'sending')", id);
      } else {
        const done = this.sql.exec(
          `UPDATE saved_items SET snapshot = NULL WHERE snapshot_revision = revision AND EXISTS (
             SELECT 1 FROM outbox WHERE id = ? AND status = 'sending' AND saved_snapshot = snapshot
               AND saved_item = cursor_item AND saved_offset = cursor_offset)`, id,
        ).rowsWritten > 0;
        if (done) this.sql.exec("DELETE FROM saved_item");
      }
      const marked = this.sql.exec<{ transient: number; created_at: number }>(
        "UPDATE outbox SET status = 'sent', via = ?, closed_at = ? WHERE id = ? AND status = 'sending' RETURNING transient, created_at", via, now, id,
      ).toArray()[0];
      if (marked?.transient === 1) {
        this.blockQuoteWindow(marked.created_at, Math.max(marked.created_at, now), providerMessages.map((m) => m.id));
        this.sql.exec(DROP_PRIVATE_INBOX_QUOTES);
      } else if (marked && providerMessages.length > 0) {
        const channel = this.agent()?.identity.channel;
        if (channel === "telegram") {
          this.sql.exec("UPDATE outbox SET telegram_message_id = ? WHERE id = ?", providerMessages[0].id, id);
        }
        if (channel === "line") {
          for (const m of providerMessages) {
            this.sql.exec("INSERT OR IGNORE INTO line_message (id, outbox_id, position, created_at) VALUES (?, ?, ?, ?)", m.id, id, m.position, now);
          }
        }
      }
      this.sql.exec("UPDATE outbox SET reply_token = NULL, reply_expires = NULL WHERE id = ? AND saved_item IS NOT NULL", id);
      this.insertLogs(logs, now);
    });
  }

  /**
   * Each delivery write names the state it expects the row in: `pending` before a send, `sending` after one. A row a forget
   * dropped meanwhile is in neither, so a late result can't put it back in the queue or block the channel.
   */
  blockUnconfirmedQuote(id: OutboxId, now: EpochMs): void {
    this.tx(() => {
      const row = this.sql.exec<{ created_at: number }>(
        "SELECT created_at FROM outbox WHERE id = ? AND status = 'sending' AND transient = 1", id,
      ).toArray()[0];
      if (!row) return;
      this.blockQuoteWindow(row.created_at, Math.max(row.created_at, now), []);
      this.sql.exec(DROP_PRIVATE_INBOX_QUOTES);
    });
  }

  reschedule(id: OutboxId, readyAt: EpochMs, expect: "pending" | "sending"): void {
    this.sql.exec("UPDATE outbox SET status = 'pending', ready_at = ? WHERE id = ? AND status = ?", readyAt, id, expect);
  }

  rescheduleInDoubt(id: OutboxId, readyAt: EpochMs): void {
    this.sql.exec("UPDATE outbox SET status = 'pending', ready_at = ?, in_doubt = 1 WHERE id = ? AND status = 'sending'", readyAt, id);
  }

  drop(id: OutboxId, reason: "budget" | "blocked" | "quota" | "failed" | "removed", now: EpochMs, logs: readonly LogRow[], expect: "pending" | "sending"): void {
    this.tx(() => {
      const dropped = this.sql.exec("UPDATE outbox SET status = 'dropped', drop_reason = ?, closed_at = ? WHERE id = ? AND status = ?", reason, now, id, expect).rowsWritten;
      if (dropped === 0) return;
      this.sql.exec("UPDATE outbox SET reply_token = NULL, reply_expires = NULL WHERE id = ? AND saved_item IS NOT NULL", id);
      this.insertLogs(logs, now);
    });
  }

  recipientGone(id: OutboxId, now: EpochMs, logs: readonly LogRow[]): void {
    this.tx(() => {
      if (this.sql.exec("UPDATE outbox SET status = 'dropped', drop_reason = 'gone', closed_at = ? WHERE id = ? AND status = 'sending'", now, id).rowsWritten === 0) return;
      this.sql.exec("UPDATE outbox SET reply_token = NULL, reply_expires = NULL WHERE id = ? AND saved_item IS NOT NULL", id);
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
    noticeTrigger: NoticeTrigger,
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
      if (message) this.insertMessage(message.key, message.message, now, noticeTrigger);
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
      this.deleteKey();
      return current !== null;
    });
  }

  private deleteKey(): void {
    this.sql.exec("DELETE FROM model_key");
    this.sql.exec("UPDATE key_revision SET revision = revision + 1");
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
  askBackup(message: NoteMessage, choice: string, key: EventKey, now: EpochMs, noticeTrigger: NoticeTrigger, expectRevision: number, again: boolean = false): boolean {
    return this.tx(() => {
      const asked =
        this.sql.exec(
          "UPDATE model_key SET backup_asked_at = ? WHERE revision = ? AND backup = 0 AND (backup_asked_at IS NULL OR ?)",
          now,
          expectRevision,
          again ? 1 : 0,
        ).rowsWritten > 0;
      if (asked) this.insertMessage(key, message, now, noticeTrigger, choice);
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
    notice: { readonly key: EventKey; readonly message: NoteMessage } | null,
    today: LocalDate,
    now: EpochMs,
    noticeTrigger: NoticeTrigger,
    expectRevision: number,
    under: string | null = null,
  ): "stale" | "rested" | "told" {
    return this.tx(() => {
      const current = this.key();
      if (current === null || current.revision !== expectRevision) return "stale";
      const tell = notice !== null && (current.health.kind === "ok" || current.health.toldOn !== today);
      this.sql.exec(
        "UPDATE model_key SET fault = ?, failures = MIN(failures + 1, ?), rest_until = ?, told_on = ?, unreadable_under = ? WHERE revision = ?",
        fault,
        KEY_MAX_FAILURES,
        until,
        today,
        under,
        expectRevision,
      );
      if (tell) this.insertMessage(notice.key, notice.message, now, noticeTrigger);
      return tell ? "told" : "rested";
    });
  }

  keyHealthy(expectRevision: number): void {
    this.sql.exec(
      "UPDATE model_key SET fault = NULL, failures = 0, rest_until = NULL, told_on = NULL, unreadable_under = NULL WHERE fault IS NOT NULL AND revision = ?",
      expectRevision,
    );
  }

  putOutsideWrite(write: NewOutsideWrite, approval: NewOutsideApproval | null): OutsideWritePut {
    return this.tx(() => {
      const forget = this.forget();
      if (forget.op !== null || forget.epoch !== write.epoch) return { kind: "stale" };
      const inserted = this.sql.exec(
        `INSERT OR IGNORE INTO outside_write (id, intent, provider, action, operation_id, args, epoch, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        write.id,
        write.intent,
        write.provider,
        write.action,
        write.operationId,
        canonicalJsonObject(write.args),
        write.epoch,
        write.status,
        write.now,
        write.now,
      ).rowsWritten;
      if (inserted > 0) {
        if (approval) {
          this.sql.exec(
            "INSERT INTO outside_approval (id, write_id, owner_key, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
            approval.id,
            approval.writeId,
            approval.owner,
            approval.expiresAt,
            approval.now,
          );
        }
        const created = this.outsideWrite(write.id);
        if (!created) throw new Error("outside write insert missing");
        return { kind: "created", write: created, approval: approval ? this.outsideApproval(approval.id) : null };
      }
      const existing = this.sql
        .exec<OutsideWriteCols>(
          "SELECT id, intent, provider, action, operation_id, args, epoch, status, attempt, in_doubt, lease_until, receipt, failure, created_at, updated_at FROM outside_write WHERE intent = ?",
          write.intent,
        )
        .toArray()[0];
      if (!existing) throw new Error("outside write conflict missing");
      const current = toOutsideWrite(existing);
      const existingApproval = this.approvalForWrite(current.id);
      const sameAction =
        current.provider === write.provider && current.action === write.action && canonicalJsonObject(current.args) === canonicalJsonObject(write.args);
      const sameApproval =
        approval === null
          ? existingApproval === null
          : existingApproval !== null && existingApproval.owner === approval.owner;
      if (!sameAction || !sameApproval) return { kind: "conflict", write: current };
      return { kind: "existing", write: current, approval: existingApproval };
    });
  }

  outsideWrite(id: OutsideWriteId): OutsideWrite | null {
    const r = this.sql
      .exec<OutsideWriteCols>(
        "SELECT id, intent, provider, action, operation_id, args, epoch, status, attempt, in_doubt, lease_until, receipt, failure, created_at, updated_at FROM outside_write WHERE id = ?",
        id,
      )
      .toArray()[0];
    return r ? toOutsideWrite(r) : null;
  }

  outsideApproval(id: OutsideApprovalId): OutsideApproval | null {
    const r = this.sql
      .exec<OutsideApprovalCols>(
        "SELECT id, write_id, owner_key, status, expires_at, created_at, decided_at, decided_by, consumed_at FROM outside_approval WHERE id = ?",
        id,
      )
      .toArray()[0];
    return r ? toOutsideApproval(r) : null;
  }

  approvalForWrite(writeId: OutsideWriteId): OutsideApproval | null {
    const r = this.sql
      .exec<OutsideApprovalCols>(
        "SELECT id, write_id, owner_key, status, expires_at, created_at, decided_at, decided_by, consumed_at FROM outside_approval WHERE write_id = ?",
        writeId,
      )
      .toArray()[0];
    return r ? toOutsideApproval(r) : null;
  }

  beginOutsideWrite(id: OutsideWriteId, now: EpochMs, leaseMs: number, epoch: ForgetEpoch): { readonly attempt: number } | null {
    const r = this.sql
      .exec<{ attempt: number }>(
        `UPDATE outside_write SET status = 'verifying', attempt = attempt + 1, lease_until = ?, updated_at = ?
         WHERE id = ? AND status = 'ready' AND epoch = ?
           AND EXISTS (SELECT 1 FROM forget WHERE op IS NULL AND epoch = ?)
         RETURNING attempt`,
        (now + leaseMs) as EpochMs,
        now,
        id,
        epoch,
        epoch,
      )
      .toArray()[0];
    return r ?? null;
  }

  finishOutsideWrite(id: OutsideWriteId, attempt: number, outcome: WriteFinish, now: EpochMs): boolean {
    return (
      this.sql.exec(
        `UPDATE outside_write SET status = ?, in_doubt = ?, lease_until = NULL, receipt = ?, failure = ?, updated_at = ?
         WHERE id = ? AND attempt = ? AND status = 'verifying'`,
        outcome.kind,
        outcome.kind === "uncertain" ? 1 : 0,
        outcome.kind === "succeeded" ? canonicalJsonObject(outcome.receipt) : null,
        outcome.kind === "failed" ? outcome.reason : null,
        now,
        id,
        attempt,
      ).rowsWritten > 0
    );
  }

  reconcileOutsideWrite(id: OutsideWriteId, attempt: number, outcome: WriteReconciliation, now: EpochMs): boolean {
    return (
      this.sql.exec(
        `UPDATE outside_write SET status = ?, in_doubt = ?, lease_until = NULL, receipt = ?, failure = ?, updated_at = ?
         WHERE id = ? AND attempt = ? AND status IN ('verifying', 'uncertain')`,
        outcome.kind,
        outcome.kind === "uncertain" ? 1 : 0,
        outcome.kind === "succeeded" ? canonicalJsonObject(outcome.receipt) : null,
        outcome.kind === "failed" ? outcome.reason : null,
        now,
        id,
        attempt,
      ).rowsWritten > 0
    );
  }

  private expireOutsideApproval(id: OutsideApprovalId, writeId: OutsideWriteId, now: EpochMs): void {
    this.sql.exec("UPDATE outside_approval SET status = 'expired' WHERE id = ? AND status IN ('pending', 'approved')", id);
    this.sql.exec(
      "UPDATE outside_write SET status = 'failed', lease_until = NULL, failure = 'approval expired', updated_at = ? WHERE id = ? AND status = 'approval_pending'",
      now,
      writeId,
    );
  }

  decideOutsideApproval(id: OutsideApprovalId, actor: OutsideApproval["owner"], decision: "approve" | "refuse", now: EpochMs): ApprovalDecision {
    return this.tx(() => {
      const approval = this.outsideApproval(id);
      if (!approval) return { kind: "missing" };
      if (approval.owner !== actor) return { kind: "wrong_owner" };
      if (approval.status === "consumed") return { kind: "used" };
      if (approval.status === "expired" || approval.expiresAt <= now) {
        this.expireOutsideApproval(id, approval.writeId, now);
        return { kind: "expired" };
      }
      if (approval.status === "approved") return { kind: "already_approved" };
      if (approval.status === "refused") return { kind: "already_refused" };
      const status = decision === "approve" ? "approved" : "refused";
      this.sql.exec("UPDATE outside_approval SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'", status, now, actor, id);
      if (decision === "refuse") {
        this.sql.exec(
          "UPDATE outside_write SET status = 'failed', lease_until = NULL, failure = 'approval refused', updated_at = ? WHERE id = ? AND status = 'approval_pending'",
          now,
          approval.writeId,
        );
      }
      return { kind: status };
    });
  }

  consumeOutsideApproval(id: OutsideApprovalId, writeId: OutsideWriteId, now: EpochMs): ApprovalConsumption {
    return this.tx(() => {
      const approval = this.outsideApproval(id);
      if (!approval) return { kind: "missing" };
      if (approval.writeId !== writeId) return { kind: "mismatched" };
      if (approval.status === "consumed") return { kind: "used" };
      if (approval.status === "expired" || approval.expiresAt <= now) {
        this.expireOutsideApproval(id, approval.writeId, now);
        return { kind: "expired" };
      }
      if (approval.status !== "approved") return { kind: "not_approved" };
      if (this.outsideWrite(writeId)?.status !== "approval_pending") return { kind: "unavailable" };
      const consumed = this.sql.exec(
        "UPDATE outside_approval SET status = 'consumed', consumed_at = ? WHERE id = ? AND status = 'approved'",
        now,
        id,
      ).rowsWritten;
      if (consumed === 0) return { kind: "used" };
      this.sql.exec("UPDATE outside_write SET status = 'ready', updated_at = ? WHERE id = ? AND status = 'approval_pending'", now, writeId);
      return { kind: "consumed" };
    });
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
        .exec<{ seq: number; role: TurnRow["role"]; text: string; at: EpochMs; transient: number }>(
          "SELECT seq, role, text, at, transient FROM turn ORDER BY seq LIMIT ?", kept + COMPACTION.foldTurns,
        )
        .toArray()
        .map((t) => ({ ...t, transient: t.transient === 1 })),
      noteCount: this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM memory_note").one().n,
      oldestNotes: this.sql
        .exec<{ id: number; text: string }>("SELECT id, text FROM memory_note ORDER BY id LIMIT ?", COMPACTION.foldNotes)
        .toArray(),
    };
  }

  commitCompaction(c: CompactionCommit, now: EpochMs, epoch: ForgetEpoch): boolean {
    return this.tx(() => {
      if (!this.live(epoch)) return false;
      const swapped = this.sql.exec(
        `UPDATE memory SET summary = ?, through_turn_seq = ?, updated_at = ?, compaction_failures = 0, compaction_retry_at = 0
         WHERE through_turn_seq = ?`,
        c.summary,
        c.throughSeq,
        now,
        c.expectThroughSeq,
      ).rowsWritten;
      if (swapped === 0) return false;
      if (c.deleteSeqs.length > 0) {
        const transient = this.sql.exec(`SELECT 1 FROM turn WHERE transient = 1 AND seq IN (${placeholders(c.deleteSeqs.length)})`, ...c.deleteSeqs).toArray();
        if (transient.length > 0) this.sql.exec("DELETE FROM box_session");
        this.sql.exec(`DELETE FROM turn WHERE seq IN (${placeholders(c.deleteSeqs.length)})`, ...c.deleteSeqs);
      }
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
      const diagnostic = diagnosticRow(row);
      if (diagnostic === null) continue;
      this.sql.exec(
        "INSERT OR IGNORE INTO log_outbox (id, stream, row, created_at) VALUES (?, ?, ?, ?)",
        `${row.stream}:${row.id}`,
        row.stream,
        JSON.stringify(diagnostic),
        now,
      );
    }
  }

  pendingLogs(now: EpochMs, limit: number): readonly LogRow[] {
    const { retry_at } = this.sql.exec<{ retry_at: EpochMs }>("SELECT retry_at FROM log_flush").one();
    if (retry_at > now) return [];
    const queued = this.sql.exec<{ id: string; row: string }>(
      "SELECT id, CASE WHEN json_valid(row) THEN row ELSE 'null' END AS row FROM log_outbox ORDER BY created_at, rowid LIMIT ?", limit,
    ).toArray();
    const rows: LogRow[] = [];
    for (const { id, row } of queued) {
      const diagnostic = diagnosticRow(JSON.parse(row));
      if (diagnostic !== null) rows.push(diagnostic);
      else this.sql.exec("DELETE FROM log_outbox WHERE id = ?", id);
    }
    return rows;
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

  private inboxReadyAt(now: EpochMs, catchUpBudget: string | null): EpochMs | null {
    const head = this.sql.exec<QueuedInboxCols & { readonly status: string }>(
      `SELECT seq, event_key, kind, payload, attempts, received_at, ready_at, catch_up, status FROM inbox
       WHERE status IN ('pending', 'processing') ORDER BY catch_up IS NOT NULL DESC, seq LIMIT 1`,
    ).toArray()[0];
    if (!head) return null;
    if (head.status !== "pending") return head.ready_at;
    const plan = this.planBatchRows(now, catchUpBudget);
    return plan.kind === "wait" ? plan.at : head.ready_at;
  }

  readiness(now: EpochMs, catchUpBudget: string | null = null): {
    readonly inboxReadyAt: EpochMs | null;
    readonly channelEventWaiting: boolean;
    readonly earliestWakeups: readonly { readonly origin: WakeupOrigin; readonly dueAt: EpochMs }[];
    readonly outboxReadyAt: EpochMs | null;
    readonly logsReadyAt: EpochMs | null;
    readonly compactionRetryAt: EpochMs | null;
    readonly boxAt: EpochMs | null;
    readonly privacyReadyAt: EpochMs | null;
    readonly forgetAt: EpochMs | null;
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
      inboxReadyAt: this.inboxReadyAt(now, catchUpBudget),
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
      privacyReadyAt: min("SELECT MIN(ready_at) AS t FROM outbox WHERE status IN ('pending', 'sending') AND epoch = (SELECT epoch FROM forget)"),
      forgetAt: min(
        "SELECT MIN(t) AS t FROM (SELECT CASE WHEN phase = 'erase' THEN retry_at END AS t FROM forget WHERE op IS NOT NULL UNION ALL SELECT notice_at FROM forget WHERE op IS NOT NULL)",
      ),
    };
  }

  forget(): ForgetState {
    const r = this.sql
      .exec<{
        epoch: ForgetEpoch;
        op: string | null;
        cutoff_at: EpochMs | null;
        cutoff_seq: number | null;
        completed_at: EpochMs | null;
        receipt: string | null;
      }>("SELECT epoch, op, cutoff_at, cutoff_seq, completed_at, receipt FROM forget")
      .one();
    return {
      epoch: r.epoch,
      op: r.op,
      cutoff: r.cutoff_at === null ? null : { at: r.cutoff_at, seq: r.cutoff_seq },
      completedAt: r.completed_at,
      finished: r.receipt !== null,
    };
  }

  /** True while no forget is open and none began since `epoch`. */
  live(epoch: ForgetEpoch): boolean {
    const f = this.forget();
    return f.op === null && f.epoch === epoch;
  }

  /** What work starting now holds; none while a forget is open, since nothing ordinary may start then. */
  claim(): Claim | null {
    const f = this.forget();
    return f.op === null ? { epoch: f.epoch, live: () => this.live(f.epoch) } : null;
  }

  held(): boolean {
    return this.forget().op !== null;
  }

  clearForErasure(job: Extract<Erasure, { kind: "preparing" }>): void {
    this.tx(() => {
      this.sql.exec("PRAGMA defer_foreign_keys = ON");
      const tables = this.sql.exec<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table'
          AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name NOT GLOB '__cf_*'
          AND name NOT IN ('meta', 'forget')`,
      ).toArray();
      for (const { name } of tables) this.sql.exec(`DELETE FROM "${name.replaceAll('"', '""')}"`);
      this.sql.exec("INSERT INTO memory (one) VALUES (1)");
      this.sql.exec("INSERT INTO log_flush (one) VALUES (1)");
      this.sql.exec("INSERT INTO key_revision (one) VALUES (1)");
      this.sql.exec("INSERT INTO saved_items (one) VALUES (1)");
      this.storage.kv.delete(ERASE_CHALLENGE);
      this.storage.kv.delete(START_CHALLENGE);
      this.storage.kv.put(ERASE_JOB, job);
    });
  }

  detachInviter(inviter: AgentKey): void {
    this.sql.exec("UPDATE admission SET inviter = NULL, code = NULL WHERE state = 'admitted' AND inviter = ?", inviter);
  }

  /**
   * Opens a forget: the epoch moves on, so every result of work begun before now is stale, and the cutoff moves to the
   * trigger's place in its provider's order. Work in flight, waiting events the cutoff covers, waiting wake-ups and every
   * send not yet confirmed are closed, so neither recovery nor a retry can pick them up again. Events after the cutoff
   * wait out the hold. A second forget while one is open supersedes it.
   */
  beginForget(trigger: ProviderOrder, now: EpochMs): { readonly op: string; readonly epoch: ForgetEpoch } {
    return this.tx(() => this.begin(trigger, now));
  }

  private begin(trigger: ProviderOrder, now: EpochMs): { readonly op: string; readonly epoch: ForgetEpoch } {
    const f = this.forget();
    const op = crypto.randomUUID();
    const epoch = (f.epoch + 1) as ForgetEpoch;
    const cutoff = laterCutoff(f.cutoff, trigger);
    this.sql.exec("UPDATE forget SET epoch = ?, op = ?, opened_at = ?, cutoff_at = ?, cutoff_seq = ?", epoch, op, now, cutoff.at, cutoff.seq);
    const agent = this.agent();
    const next: ForgetState = { ...f, epoch, op, cutoff };
    const covered = this.sql
      .exec<{ event_key: EventKey; payload: string; received_at: EpochMs }>("SELECT event_key, payload, received_at FROM inbox WHERE status = 'pending'")
      .toArray()
      .filter((r) => {
        const event = fromJson<AgentEvent>(r.payload);
        if (!agent || event.kind === "wakeup" || event.kind === "checkin") return true;
        return coveredByForget({ agent: agent.key, identity: agent.identity, key: r.event_key, receivedAt: r.received_at, event }, next);
      })
      .map((r) => r.event_key);
    this.sql.exec(
      `UPDATE inbox SET status = 'failed', outcome = 'forgotten', finished_at = ?, catch_up = NULL, catch_up_budget = NULL
       WHERE status = 'processing' OR event_key IN (SELECT value FROM json_each(?))`,
      now,
      JSON.stringify(covered),
    );
    this.sql.exec("UPDATE inbox SET catch_up = NULL, catch_up_budget = NULL WHERE catch_up IS NOT NULL");
    this.sql.exec("UPDATE outbox SET status = 'dropped', drop_reason = 'forgotten', closed_at = ? WHERE status IN ('pending', 'sending')", now);
    this.sql.exec(
      `UPDATE outside_write SET status = 'dropped', lease_until = NULL,
         in_doubt = CASE WHEN status IN ('verifying', 'uncertain') THEN 1 ELSE in_doubt END, updated_at = ?
       WHERE status IN ('approval_pending', 'ready', 'verifying', 'uncertain')`,
      now,
    );
    this.sql.exec(
      `UPDATE outside_approval SET status = 'expired'
       WHERE status IN ('pending', 'approved') AND write_id IN (SELECT id FROM outside_write WHERE status = 'dropped')`,
    );
    return { op, epoch };
  }

  forgetOp(): ForgetOp | null {
    const r = this.sql
      .exec<{ op: string | null; epoch: ForgetEpoch; phase: ForgetOp["phase"]; code: string | null; listed: number; retry_at: EpochMs | null }>(
        "SELECT op, epoch, phase, code, listed, retry_at FROM forget",
      )
      .one();
    return r.op === null ? null : { op: r.op, epoch: r.epoch, phase: r.phase, code: r.code, listed: r.listed === 1, retryAt: r.retry_at };
  }

  /**
   * A `/forget` message, handled when it arrives, before any admission, access or spend check and whatever the hold. Its
   * inbox row keeps only its key, for dedupe. Every forget clears the chat whole in the same transaction; the person's
   * choice then settles which saved items go.
   */
  private privacy(e: InboundEnvelope, cmd: ForgetCommand, now: EpochMs): "inserted" | "duplicate" {
    if (this.insertInbox(e.key, { kind: "message", text: "/forget" }, e.receivedAt, now) === "duplicate") return "duplicate";
    this.sql.exec("UPDATE inbox SET status = 'done', outcome = 'privacy', finished_at = ? WHERE event_key = ?", now, e.key);
    const reply = e.event.kind === "message" ? e.event.reply : undefined;
    const order = providerOrder(e);
    const f = this.forgetOp();
    switch (cmd.kind) {
      case "start":
      case "all":
        if (order === null) throw new Error("a /forget message has no place in its provider's order");
        this.begin(order, now);
        this.clearChat();
        this.keepReply(reply);
        if (cmd.kind === "all") {
          this.deleteAll();
          this.toErase("all", now);
        } else {
          this.startReview(now);
          this.queuePage(reply, now);
        }
        break;
      case "next":
        if (f?.phase === "review" && !f.listed) this.queuePage(reply, now);
        else this.notice(this.statusText(), reply, now);
        break;
      case "status":
        this.notice(this.statusText(), reply, now);
        break;
      case "choose": {
        const t = FORGET_TEXT[this.language()];
        if (f?.phase !== "review" || f.code !== cmd.code) this.notice(t.help, reply, now);
        else if (!f.listed) this.notice(t.reviewOpen(null), reply, now);
        else if (!this.deleteChosen(cmd.numbers)) this.notice(t.help, reply, now);
        else {
          this.keepReply(reply);
          this.toErase(cmd.numbers, now);
        }
        break;
      }
      case "help":
        this.notice(FORGET_TEXT[this.language()].help, reply, now);
        break;
      default:
        assertNever(cmd);
    }
    return "inserted";
  }

  private language(): Language {
    return this.agent()?.language ?? "en";
  }

  /**
   * The chat and everything written from it, whole: turns, the summary, message bodies and handles, wake-ups the
   * assistant set, offered plans, outside writes and their approvals, the box session.
   */
  private clearChat(): void {
    this.sql.exec("DELETE FROM outside_approval");
    this.sql.exec("DELETE FROM outside_write");
    this.sql.exec("DELETE FROM turn");
    this.sql.exec("UPDATE memory SET summary = '', through_turn_seq = 0, compaction_failures = 0, compaction_retry_at = 0");
    this.sql.exec("DELETE FROM inbox WHERE kind IN ('wakeup', 'checkin')");
    this.sql.exec("UPDATE inbox SET payload = '{}' WHERE status IN ('done', 'failed')");
    this.sql.exec("UPDATE outbox SET texts = '[]', correction_spans = NULL, choice = NULL, reply_token = NULL, reply_expires = NULL, telegram_message_id = NULL, event_key = 'forgotten' WHERE status IN ('sent', 'dropped')");
    this.sql.exec("DELETE FROM line_message WHERE outbox_id IN (SELECT id FROM outbox WHERE status IN ('sent', 'dropped'))");
    this.sql.exec("DELETE FROM wakeup WHERE origin != 'person'");
    this.sql.exec("DELETE FROM proposal");
    this.sql.exec("DELETE FROM box_session");
    this.sql.exec("DELETE FROM saved_item");
    this.sql.exec("UPDATE saved_items SET snapshot = NULL");
  }

  private deleteAll(): void {
    this.sql.exec("DELETE FROM memory_note");
    this.sql.exec("DELETE FROM wakeup");
    this.sql.exec("DELETE FROM task_fact");
    this.sql.exec("DELETE FROM task");
    this.sql.exec("UPDATE outbox SET task_id = NULL");
    for (const setting of [1, 2, 3]) this.resetSetting(setting);
  }

  /** Deletes exactly the numbered items of the current list, each with every copy that exists because of it. False when a number isn't on it. */
  private deleteChosen(numbers: readonly number[]): boolean {
    const items = numbers.map((n) => this.sql.exec<{ kind: string; id: number }>("SELECT kind, source_id AS id FROM saved_item WHERE ordinal = ?", n - 1).toArray()[0]);
    if (items.some((i) => i === undefined)) return false;
    for (const { kind, id } of items) {
      if (kind === "note") this.sql.exec("DELETE FROM memory_note WHERE id = ?", id);
      if (kind === "reminder") {
        this.sql.exec(`DELETE FROM wakeup WHERE origin = 'person' AND ${REMINDER_ITEM} = (SELECT ${REMINDER_ITEM} FROM wakeup WHERE id = ?)`, id);
      }
      if (kind === "task") {
        this.sql.exec("DELETE FROM task_fact WHERE task_id = ?", id);
        this.sql.exec("DELETE FROM task WHERE id = ?", id);
        this.sql.exec("UPDATE wakeup SET task_id = NULL WHERE task_id = ?", id);
        this.sql.exec("UPDATE outbox SET task_id = NULL WHERE task_id = ?", id);
      }
      if (kind === "setting") this.resetSetting(id);
    }
    return true;
  }

  /** A setting goes back to its default. A new time zone keeps each kept reminder at its wall time, as moving zones does. */
  private resetSetting(setting: number): void {
    const a = this.agent();
    if (!a) return;
    if (setting === 1) this.sql.exec("UPDATE agent SET language = ?", CHANNEL_LANGUAGE[a.identity.channel]);
    if (setting === 3) this.sql.exec("UPDATE agent SET checkin_local = ?", SCHEDULE.defaultCheckinLocal);
    if (setting !== 2 || a.tz === DEFAULT_TIME_ZONE) return;
    for (const w of this.sql.exec<{ id: number; due_at: EpochMs }>("SELECT id, due_at FROM wakeup WHERE status = 'pending' AND kind = 'reminder'").toArray()) {
      this.sql.exec("UPDATE wakeup SET due_at = ? WHERE id = ?", fromLocal(toLocal(w.due_at, a.tz), DEFAULT_TIME_ZONE), w.id);
    }
    this.sql.exec("UPDATE agent SET tz = ?", DEFAULT_TIME_ZONE);
  }

  /** The latest command's reply handle, so the receipt can use it while it is fresh. */
  private keepReply(reply: ReplyHandle | undefined): void {
    this.sql.exec("UPDATE forget SET reply_token = ?, reply_expires = ?", reply?.token ?? null, reply?.expiresAt ?? null);
  }

  private startReview(now: EpochMs): void {
    snapshotSavedItems(this.sql);
    this.sql.exec("UPDATE saved_items SET snapshot = ?, snapshot_revision = revision, cursor_item = 0, cursor_offset = 0", crypto.randomUUID());
    this.sql.exec(
      "UPDATE forget SET phase = 'review', code = ?, listed = 0, retry_at = NULL, attempts = 0, notice_at = ?, notices = 0",
      newForgetCode(),
      now + FORGET_REMINDER_MS,
    );
  }

  /** The person settled what goes; what is left is the box erase. Deletions from earlier forgets still open stay for the one receipt. */
  private toErase(deleted: Deleted, now: EpochMs): void {
    this.sql.exec(
      `UPDATE forget SET phase = 'erase', code = NULL, listed = 0, deleted = json_insert(deleted, '$[#]', json(?)), retry_at = ?, attempts = 0,
         notice_at = ?, notices = 0`,
      JSON.stringify(deleted),
      now,
      now + ERASE_NOTICE_MS,
    );
    this.sql.exec("DELETE FROM saved_item");
    this.sql.exec("UPDATE saved_items SET snapshot = NULL");
  }

  private replyOnly(): boolean {
    return this.agent()?.identity.channel === "line" && !mayspend(this.admission());
  }

  private insertPrivacy(privacy: Privacy, texts: readonly string[], reply: ReplyHandle | undefined, now: EpochMs, saved: SavedCursor & { readonly snapshot: string | null } | null = null): void {
    this.sql.exec(
      `INSERT INTO outbox (id, event_key, trigger_kind, intent, texts, reply_token, reply_expires, ready_at, created_at, reply_only,
                           saved_snapshot, saved_item, saved_offset, privacy, epoch)
       VALUES (?, 'forget', 'message', 'reply', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT epoch FROM forget))`,
      crypto.randomUUID(), JSON.stringify(texts), reply?.token ?? null, reply?.expiresAt ?? null, now, now, this.replyOnly() ? 1 : 0,
      saved?.snapshot ?? null, saved?.item ?? null, saved?.offset ?? null, privacy,
    );
  }

  private queuePage(reply: ReplyHandle | undefined, now: EpochMs): void {
    const state = this.savedState();
    this.insertPrivacy("page", [], reply, now, { snapshot: state.snapshot, item: state.cursor_item, offset: state.cursor_offset });
  }

  private notice(text: string, reply: ReplyHandle | undefined, now: EpochMs): void {
    this.insertPrivacy("notice", [text], reply, now);
  }

  private statusText(): string {
    const t = FORGET_TEXT[this.language()];
    const f = this.forgetOp();
    if (f?.phase === "review") return t.reviewOpen(f.listed ? f.code : null);
    if (f?.phase === "erase") return t.erasing;
    if (f) return t.held;
    const receipt = this.sql.exec<{ receipt: string | null }>("SELECT receipt FROM forget").one().receipt;
    return receipt === null ? t.none : t.lastReceipt(fromJson<Receipt>(receipt));
  }

  /** A message that waits out a forget's hold is told why, at most once an hour. */
  private tellHeld(reply: ReplyHandle | undefined, now: EpochMs): void {
    const told = this.sql.exec("UPDATE forget SET held_told_at = ? WHERE phase IS NOT NULL AND (held_told_at IS NULL OR held_told_at <= ?)", now, now - HELD_NOTICE_MS);
    if (told.rowsWritten > 0) this.notice(FORGET_TEXT[this.language()].held, reply, now);
  }

  /** The open forget's next reminder, if one is due: a few, a day apart, then none. */
  remindIfDue(now: EpochMs): void {
    this.tx(() => {
      const due = this.sql.exec<{ notices: number }>("SELECT notices FROM forget WHERE phase IS NOT NULL AND notice_at <= ?", now).toArray()[0];
      if (!due) return;
      this.notice(this.statusText(), undefined, now);
      const notices = due.notices + 1;
      this.sql.exec("UPDATE forget SET notices = ?, notice_at = ?", notices, notices < FORGET_REMINDERS ? now + FORGET_REMINDER_MS : null);
    });
  }

  erasePending(op: string, now: EpochMs): void {
    const { attempts } = this.sql.exec<{ attempts: number }>("SELECT attempts FROM forget").one();
    this.sql.exec(
      "UPDATE forget SET attempts = attempts + 1, retry_at = ? WHERE op = ? AND phase = 'erase'",
      now + Math.min(ERASE_RETRY_BASE_MS * 2 ** attempts, ERASE_RETRY_MAX_MS),
      op,
    );
  }

  /**
   * Completes the forget `op` once its box erase is acknowledged: the hold ends and the receipt is queued, in one
   * transaction. False when `op` is no longer the open forget, or the box's volume changed since the erase was sent.
   */
  completeForget(op: string, volume: string | null, backups: Backups, checkin: NewWakeup | null, now: EpochMs): boolean {
    return this.tx(() => {
      const f = this.forgetOp();
      if (f?.op !== op || f.phase !== "erase" || (volume !== null && this.boxVolume() !== volume)) return false;
      const r = this.sql.exec<{ deleted: string; reply_token: string | null; reply_expires: EpochMs | null }>("SELECT deleted, reply_token, reply_expires FROM forget").one();
      const receipt: Receipt = { deleted: fromJson<Deleted[]>(r.deleted), backups };
      this.sql.exec(
        `UPDATE forget SET op = NULL, opened_at = NULL, phase = NULL, code = NULL, listed = 0, deleted = '[]', retry_at = NULL, attempts = 0,
           quote_rewrites_before = NULL, notice_at = NULL, notices = 0, held_told_at = NULL, reply_token = NULL, reply_expires = NULL, receipt = ?, completed_at = MAX(COALESCE(completed_at, 0), ?)`,
        JSON.stringify(receipt),
        now,
      );
      this.sql.exec(
        `UPDATE inbox SET payload = json_remove(payload, '$.quote')
         WHERE CASE WHEN json_valid(payload) THEN json_type(payload, '$.quote') END IS NOT NULL`,
      );
      this.sql.exec("DELETE FROM quote_rewrite");
      this.sql.exec("DELETE FROM private_quote_id");
      this.sql.exec("DELETE FROM private_quote_window");
      this.sql.exec("DELETE FROM box_session");
      if (checkin && mayspend(this.admission())) this.insertWakeup(checkin, "system", now);
      const reply = r.reply_token !== null && r.reply_expires !== null && r.reply_expires > now ? { token: r.reply_token, expiresAt: r.reply_expires } : undefined;
      this.insertPrivacy("receipt", [FORGET_TEXT[this.language()].receipt(receipt)], reply, now);
      return true;
    });
  }

  /** Ends the hold only for the forget that is open; an older one's end changes nothing. */
  endForget(op: string): boolean {
    return this.sql.exec("UPDATE forget SET op = NULL, opened_at = NULL, phase = NULL, code = NULL, listed = 0, retry_at = NULL, notice_at = NULL WHERE op = ?", op).rowsWritten > 0;
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
    this.sql.exec("DELETE FROM line_message WHERE NOT EXISTS (SELECT 1 FROM outbox WHERE outbox.id = line_message.outbox_id)");
    this.sql.exec("DELETE FROM quote_rewrite WHERE expires_at <= ?", now);
    this.sql.exec("DELETE FROM routine_delivery WHERE at <= ? AND sending_id IS NULL", now - DAY_MS);
    this.sql.exec("DELETE FROM billing_event WHERE at < ?", now - DEDUPE_WINDOW_MS);
  }
}
import { ERASE_CHALLENGE, ERASE_JOB, START_CHALLENGE, type Erasure } from "./account";
