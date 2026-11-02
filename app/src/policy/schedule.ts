/**
 * The scheduler: plain code, not the model. Pure functions over rows the agent loads.
 * The agent applies their decisions inside SQL transactions; nothing here does I/O.
 */
import {
  CHECKIN_KEY,
  type AgentEvent,
  type EpochMs,
  type LocalDateTime,
  type PersonStatus,
  type TimeZone,
  type WakeupId,
  type WakeupKey,
} from "../domain";
import { quietUntil } from "./outreach";

export const SCHEDULE = {
  /** Model-scheduled reminders only; the daily check-in is exempt and always exists for an active person. */
  maxPendingReminders: 20,
  lateAfterMs: 60 * 60 * 1000,
  minLeadMs: 60 * 1000,
  maxHorizonMs: 366 * 24 * 60 * 60 * 1000,
  defaultCheckinLocal: "09:00",
} as const;

export type PendingWakeup = {
  readonly id: WakeupId;
  readonly key: WakeupKey;
  readonly kind: "reminder" | "checkin";
  readonly note: string;
  readonly dueAt: EpochMs;
};

export type NewWakeup = Omit<PendingWakeup, "id">;

// ---------------------------------------------------------------------------------------------
// Admission (model asks to schedule)

export type ReminderRejection = "duplicate" | "limit" | "past" | "too_far" | "bad_time" | "reserved_key";

export type ReminderAdmission =
  | {
      readonly ok: true;
      readonly wakeup: NewWakeup;
      /** Set when `dueAt` is in quiet hours: it will fire at this instant instead, and the person is told now. */
      readonly firesLateAt: EpochMs | null;
    }
  | { readonly ok: false; readonly reason: ReminderRejection };

/**
 * Validates one schedule_wakeup action against the pending set *as it stands mid-turn*. The caller
 * threads `pending` through the turn's actions in order, so "cancel x, schedule x" in one turn
 * reschedules, and "schedule x, schedule x" drops the second.
 */
export function admitReminder(
  req: { readonly key: string; readonly at: string; readonly note: string },
  ctx: { readonly now: EpochMs; readonly tz: TimeZone; readonly pending: ReadonlyMap<WakeupKey, PendingWakeup> },
): ReminderAdmission {
  // TODO:
  //   key must match slug regex and != CHECKIN_KEY            else reserved_key / bad_time
  //   at = parseLocalDateTime(req.at) ?? bad_time; due = fromLocal(at, tz)
  //   due < now + minLeadMs → past;  due > now + maxHorizonMs → too_far
  //   pending.has(key) → duplicate
  //   count(pending where kind == "reminder") >= maxPendingReminders → limit
  //   firesLateAt = quietUntil(due, tz)
  void CHECKIN_KEY;
  throw new Error("not implemented");
}

// ---------------------------------------------------------------------------------------------
// Firing (alarm found due rows)

/** When a pending wake-up will actually fire: its due time, or the end of quiet hours if it lands inside. */
export function fireAt(dueAt: EpochMs, tz: TimeZone): EpochMs {
  return quietUntil(dueAt, tz) ?? dueAt;
}

export type Firing =
  | {
      readonly kind: "fire";
      readonly wakeup: PendingWakeup;
      /** The inbox event. `firedAt - dueAt > lateAfterMs` makes the turn late; the turn derives that. */
      readonly event: Extract<AgentEvent, { kind: "wakeup" } | { kind: "checkin" }>;
      /** The check-in's successor, inserted in the same transaction so there is never zero or two. */
      readonly next: NewWakeup | null;
    }
  | { readonly kind: "skip"; readonly wakeup: PendingWakeup; readonly reason: "blocked" };

/**
 * Input: rows with `dueAt <= now`, oldest first (SQL can't evaluate zone math, so the store bounds on
 * due_at). Rows whose `fireAt` is still ahead (due in quiet hours) produce no Firing; they stay pending
 * and `nextAlarm` wakes the agent at their fireAt.
 *
 * Blocked person: wake-ups are marked fired-and-skipped (no model call, no message). A re-follow gets a
 * fresh check-in; missed reminders are not replayed.
 */
export function planFiring(
  now: EpochMs,
  tz: TimeZone,
  status: PersonStatus,
  checkinLocal: string,
  due: readonly PendingWakeup[],
): Firing[] {
  throw new Error("not implemented");
}

export function isLate(e: { readonly dueAt: EpochMs; readonly firedAt: EpochMs }): boolean {
  return e.firedAt - e.dueAt > SCHEDULE.lateAfterMs;
}

// ---------------------------------------------------------------------------------------------
// The one alarm

/**
 * The Durable Object has one alarm. Its time is *derived* from the tables every time the drain ends;
 * no table stores "next alarm". Each input is the earliest instant that table needs attention, or null.
 * Returns null when nothing is pending (the alarm is deleted; the next `enqueue` sets it).
 */
export function nextAlarm(input: {
  readonly now: EpochMs;
  readonly inboxReadyAt: EpochMs | null;
  /** fireAt() of the earliest pending wake-up (fireAt is monotone in dueAt, so min of fireAt = fireAt of min). */
  readonly wakeupFireAt: EpochMs | null;
  readonly outboxReadyAt: EpochMs | null;
  /** Earliest time a log flush should run: now if rows wait and the last flush succeeded, else the backoff. */
  readonly logsReadyAt: EpochMs | null;
}): EpochMs | null {
  // TODO: min of non-null inputs, clamped to >= now.
  throw new Error("not implemented");
}

export type { LocalDateTime };
