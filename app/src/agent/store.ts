/**
 * Typed access to the agent's SQLite tables. The only module that writes SQL against `ctx.storage.sql`
 * and the only one that parses JSON columns. Imported only by `agent.ts` (lint: no-restricted-imports
 * on `agent/store` from anywhere else).
 *
 * Every method is synchronous: SQLite calls in a Durable Object don't await, so a method body is
 * atomic with respect to other requests. Multi-statement changes that must be all-or-nothing go
 * through `tx`, which wraps `ctx.storage.transactionSync`.
 */
import type {
  AgentEvent,
  AgentKey,
  EpochMs,
  EventKey,
  Identity,
  InboundEnvelope,
  LocalDate,
  MicroUsd,
  MonthKey,
  OutboundMessage,
  OutboxId,
  PersonStatus,
  TimeZone,
} from "../domain";
import type { LogRow } from "../ledger/ledger";
import type { ModelId, Purpose, Usage } from "../model/model";
import type { Firing, PendingWakeup } from "../policy/schedule";
import type { MonthSpend } from "../policy/spend";
import type { CompactionCommit, CompactionInput } from "./compaction";
import type { Batch, TurnCommit, TurnRow } from "./turn";

export type AgentRow = {
  readonly key: AgentKey;
  readonly identity: Identity;
  readonly tz: TimeZone;
  readonly checkinLocal: string;
  readonly status: PersonStatus;
};

export type OutboxRow = OutboundMessage & {
  readonly eventKey: EventKey;
  readonly triggerKind: AgentEvent["kind"];
  readonly admittedDay: LocalDate | null;
  readonly attempts: number;
};

export type Reservation = {
  readonly id: string;
  readonly month: MonthKey;
  readonly purpose: Purpose;
  readonly model: ModelId;
  readonly estimate: MicroUsd;
};

export type Recovery = {
  /** `processing` inbox rows put back to `pending` (attempts kept). */
  readonly requeued: number;
  /** Rows that hit TURN.maxAttempts; the drain commits a `poison` turn for each. */
  readonly poisoned: readonly Batch[];
  /** `sending` outbox rows put back to `pending` with in_doubt = 1. */
  readonly inDoubt: number;
  /** Open reservations, now settled at estimate, with their model_call log rows written. */
  readonly settledAtEstimate: readonly Reservation[];
};

export class AgentStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  tx<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }

  // --- agent ----------------------------------------------------------------------------------

  agent(): AgentRow | null {
    throw new Error("not implemented");
  }
  /** INSERT OR IGNORE the singleton row and, the first time, an `agent` log row and the daily check-in. */
  ensureAgent(envelope: InboundEnvelope): AgentRow {
    throw new Error("not implemented");
  }

  // --- inbox ----------------------------------------------------------------------------------

  /** INSERT OR IGNORE on event_key. "duplicate" means this exact event was seen before, in any status. */
  insertInbox(key: EventKey, event: AgentEvent, receivedAt: EpochMs, readyAt: EpochMs): "inserted" | "duplicate" {
    throw new Error("not implemented");
  }

  /**
   * Called once at the start of every drain. Anything in `processing`/`sending` or any open reservation
   * belongs to a run that died: the in-memory drain guard guarantees no live run exists when this runs.
   */
  recover(now: EpochMs): Recovery {
    throw new Error("not implemented");
  }

  /**
   * Claim the next batch: the oldest ready pending row; if it is a message, also the following ready
   * pending message rows up to TURN.maxBatchMessages, stopping at the first non-message. Sets them to
   * `processing` and increments attempts, in one transaction. Returns null when nothing is ready.
   */
  claimBatch(now: EpochMs): Batch | null {
    throw new Error("not implemented");
  }

  /**
   * processing -> pending with ready_at moved: the model was unavailable. Attempts are kept, so a long
   * outage ends in a poison turn instead of an endless loop.
   */
  releaseBatch(keys: readonly EventKey[], readyAt: EpochMs): void {
    throw new Error("not implemented");
  }

  /**
   * Derived "already told them about the monthly limit today": any done message row with outcome
   * refused_budget finished since the local day began. No flag to keep in sync.
   */
  refusedToday(dayStart: EpochMs): boolean {
    throw new Error("not implemented");
  }

  // --- the turn's read and write --------------------------------------------------------------

  /** One synchronous read of everything `TurnView` needs except the batch and clock. */
  turnContext(limitTurns: number): {
    readonly summary: string;
    readonly notes: readonly string[];
    readonly recent: readonly TurnRow[];
    readonly pending: readonly PendingWakeup[];
  } {
    throw new Error("not implemented");
  }

  /**
   * Apply a turn atomically:
   *   insert turns; cancel wake-ups (status cancelled where key in ... and status pending and kind reminder);
   *   insert wake-ups (INSERT OR IGNORE against the partial unique index: a racing duplicate is dropped);
   *   ensure check-in; insert notes; set agent.status; insert the outbox row (new OutboxId = UUID);
   *   mark batch rows done with outcome; settle `reservation` (delete row, spent += actual) if given;
   *   insert log rows (turn, model_call, lifecycle).
   */
  commitTurn(
    commit: TurnCommit,
    settle: { readonly reservation: Reservation; readonly cost: MicroUsd; readonly usage: Usage | null } | null,
    logs: readonly LogRow[],
    now: EpochMs,
  ): void {
    throw new Error("not implemented");
  }

  // --- wake-ups -------------------------------------------------------------------------------

  /** Pending rows with due_at <= now, oldest first. */
  dueWakeups(now: EpochMs): readonly PendingWakeup[] {
    throw new Error("not implemented");
  }

  /**
   * One transaction per firing: inbox insert (OR IGNORE on 'wake:<id>' or 'checkin:<day>'), close the
   * wake-up as fired or skipped, insert its successor (check-in).
   */
  applyFiring(firing: Firing, now: EpochMs): void {
    throw new Error("not implemented");
  }

  // --- outbox ---------------------------------------------------------------------------------

  readyOutbox(now: EpochMs, limit: number): readonly OutboxRow[] {
    throw new Error("not implemented");
  }
  /** Derived budget: COUNT(*) WHERE intent='unasked' AND admitted_day = day. */
  unaskedAdmitted(day: LocalDate): number {
    throw new Error("not implemented");
  }
  /** pending -> sending, recording admitted_day for unasked rows. Must commit before the network call. */
  markSending(id: OutboxId, admittedDay: LocalDate | null): void {
    throw new Error("not implemented");
  }
  markSent(id: OutboxId, via: "reply" | "push", now: EpochMs, logs: readonly LogRow[]): void {
    throw new Error("not implemented");
  }
  /** sending|pending -> pending with ready_at moved (retry backoff or quiet-hours deferral). */
  reschedule(id: OutboxId, readyAt: EpochMs): void {
    throw new Error("not implemented");
  }
  drop(id: OutboxId, reason: "budget" | "blocked" | "failed" | "gone", now: EpochMs, logs: readonly LogRow[]): void {
    throw new Error("not implemented");
  }

  // --- spend ----------------------------------------------------------------------------------

  monthSpend(month: MonthKey): MonthSpend {
    throw new Error("not implemented");
  }
  reserve(r: Reservation, eventKey: EventKey | null, now: EpochMs): void {
    throw new Error("not implemented");
  }
  /** Settle outside a turn commit (a failed compaction call). Deletes the reservation, adds actual. */
  settle(r: Reservation, cost: MicroUsd, logs: readonly LogRow[]): void {
    throw new Error("not implemented");
  }
  /** Persist the seq about to be requested, so a crash between asking and recording retries the same seq. */
  beginLease(month: MonthKey): number {
    throw new Error("not implemented");
  }
  grantLease(month: MonthKey, seq: number, micro: MicroUsd): void {
    throw new Error("not implemented");
  }
  denyLease(month: MonthKey, seq: number): void {
    throw new Error("not implemented");
  }

  // --- memory ---------------------------------------------------------------------------------

  compactionInput(): CompactionInput {
    throw new Error("not implemented");
  }
  /**
   * Settle the compaction call and, if memory.through_turn_seq still equals c.expectThroughSeq, replace
   * the summary and delete folded turns and notes. One transaction. Returns false if the compare-and-set
   * missed (the settle still applies).
   */
  commitCompaction(
    c: CompactionCommit,
    settle: { readonly reservation: Reservation; readonly cost: MicroUsd },
    logs: readonly LogRow[],
    now: EpochMs,
  ): boolean {
    throw new Error("not implemented");
  }

  // --- logs -----------------------------------------------------------------------------------

  pendingLogs(limit: number): readonly LogRow[] {
    throw new Error("not implemented");
  }
  /** Delete shipped rows and reset the failure counter. */
  logsShipped(ids: readonly string[]): void {
    throw new Error("not implemented");
  }
  logsFailed(now: EpochMs): void {
    throw new Error("not implemented");
  }

  // --- the alarm's inputs ---------------------------------------------------------------------

  /** The earliest instant each table needs the drain. Feeds `nextAlarm`; nothing stores the result. */
  readiness(): {
    readonly inboxReadyAt: EpochMs | null;
    readonly earliestWakeupDue: EpochMs | null;
    readonly outboxReadyAt: EpochMs | null;
    readonly logsReadyAt: EpochMs | null;
  } {
    throw new Error("not implemented");
  }

  /** Housekeeping: delete done inbox rows older than 14 days (dedupe window), closed outbox older than 30. */
  prune(now: EpochMs): void {
    throw new Error("not implemented");
  }
}
