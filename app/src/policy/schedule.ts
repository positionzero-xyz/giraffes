/**
 * The scheduler: plain code, not the model. Pure functions over rows the agent loads.
 * The agent applies their decisions inside SQL transactions; nothing here does I/O.
 */
import {
  CHECKIN_KEY,
  eventKey,
  parseWakeupKey,
  type AgentEvent,
  type AgentEventKind,
  type EpochMs,
  type EventKey,
  type PersonStatus,
  type TimeOfDay,
  type TimeZone,
  type WakeupId,
  type WakeupKey,
} from "../domain";
import { quietUntil } from "./outreach";
import { fromLocal, localDate, nextLocalTime, parseLocalDateTime } from "./time";

export const SCHEDULE = {
  /** Reminders only (any origin); the daily check-in is exempt and always exists for an active person. */
  maxPendingReminders: 20,
  lateAfterMs: 60 * 60 * 1000,
  minLeadMs: 60 * 1000,
  maxHorizonMs: 366 * 24 * 60 * 60 * 1000,
  defaultCheckinLocal: "09:00",
} as const;

/** The origin is part of the variant, so a person-asked check-in or a system reminder can't be built. */
export type PendingWakeup = {
  readonly id: WakeupId;
  readonly key: WakeupKey;
  readonly note: string;
  readonly dueAt: EpochMs;
} & (
  | { readonly kind: "reminder"; readonly origin: "person" | "agent" }
  | { readonly kind: "checkin"; readonly origin: "system" }
);

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type NewWakeup = DistributiveOmit<PendingWakeup, "id">;
export type NewReminder = Extract<NewWakeup, { kind: "reminder" }>;

// ---------------------------------------------------------------------------------------------
// Origin (who asked)

/**
 * Only a turn started by the person's own message can create a `person` wake-up, and only when the
 * model marks it as asked for. Everything scheduled in a proactive turn (a wake-up, the check-in, a
 * follow) is the agent's own, whatever the model claims.
 */
export function wakeupOrigin(trigger: AgentEventKind, askedFor: boolean): "person" | "agent" {
  return trigger === "message" && askedFor ? "person" : "agent";
}

// ---------------------------------------------------------------------------------------------
// Admission (model asks to schedule)

export type ReminderRejection = "duplicate" | "limit" | "past" | "too_far" | "bad_time" | "bad_key" | "reserved_key";

export type ReminderAdmission =
  | { readonly ok: true; readonly wakeup: NewReminder }
  | { readonly ok: false; readonly reason: ReminderRejection };

/**
 * Validates one schedule_wakeup action against the pending set *as it stands mid-turn*. The caller
 * threads `pending` through the turn's actions in order, so "cancel x, schedule x" in one turn
 * reschedules, and "schedule x, schedule x" drops the second.
 */
export function admitReminder(
  req: { readonly key: string; readonly at: string; readonly note: string; readonly origin: "person" | "agent" },
  ctx: { readonly now: EpochMs; readonly tz: TimeZone; readonly pending: ReadonlyMap<WakeupKey, NewWakeup> },
): ReminderAdmission {
  const key = parseWakeupKey(req.key);
  if (key === null) return { ok: false, reason: "bad_key" };
  if (key === CHECKIN_KEY) return { ok: false, reason: "reserved_key" };
  const at = parseLocalDateTime(req.at);
  if (at === null) return { ok: false, reason: "bad_time" };
  const dueAt = fromLocal(at, ctx.tz);
  if (dueAt < ctx.now + SCHEDULE.minLeadMs) return { ok: false, reason: "past" };
  if (dueAt > ctx.now + SCHEDULE.maxHorizonMs) return { ok: false, reason: "too_far" };
  if (ctx.pending.has(key)) return { ok: false, reason: "duplicate" };
  const reminders = [...ctx.pending.values()].filter((w) => w.kind === "reminder").length;
  if (reminders >= SCHEDULE.maxPendingReminders) return { ok: false, reason: "limit" };
  return { ok: true, wakeup: { key, kind: "reminder", origin: req.origin, note: req.note, dueAt } };
}

export function checkinWakeup(after: EpochMs, tz: TimeZone, checkinLocal: TimeOfDay): NewWakeup {
  return {
    key: CHECKIN_KEY,
    kind: "checkin",
    origin: "system",
    note: "Daily check-in",
    dueAt: nextLocalTime(after, tz, checkinLocal),
  };
}

// ---------------------------------------------------------------------------------------------
// Firing (alarm found due rows)

/**
 * When a pending wake-up actually fires. A reminder the person asked for fires when they asked, even at
 * night. The agent's own wake-ups and the check-in wait for quiet hours to end.
 */
export function fireAt(w: { readonly origin: PendingWakeup["origin"]; readonly dueAt: EpochMs }, tz: TimeZone): EpochMs {
  if (w.origin === "person") return w.dueAt;
  return quietUntil(w.dueAt, tz) ?? w.dueAt;
}

export type Firing =
  | {
      readonly kind: "fire";
      readonly wakeup: PendingWakeup;
      readonly key: EventKey;
      /** The inbox event. `firedAt - dueAt > lateAfterMs` makes the turn late; the turn derives that. */
      readonly event: Extract<AgentEvent, { kind: "wakeup" } | { kind: "checkin" }>;
      /** The check-in's successor, inserted in the same transaction so there is never zero or two. */
      readonly next: NewWakeup | null;
    }
  | { readonly kind: "skip"; readonly wakeup: PendingWakeup; readonly reason: "blocked" };

/**
 * Input: rows with `dueAt <= now`, oldest first (SQL can't evaluate zone math, so the store bounds on
 * due_at). Rows whose `fireAt` is still ahead (an unasked wake-up due in quiet hours) produce no Firing;
 * they stay pending and `nextAlarm` wakes the agent at their fireAt.
 *
 * Blocked person: wake-ups are marked fired-and-skipped (no model call, no message). A re-follow gets a
 * fresh check-in; missed reminders are not replayed.
 */
export function planFiring(
  now: EpochMs,
  tz: TimeZone,
  status: PersonStatus,
  checkinLocal: TimeOfDay,
  due: readonly PendingWakeup[],
): Firing[] {
  const firings: Firing[] = [];
  for (const w of due) {
    if (status === "blocked") {
      firings.push({ kind: "skip", wakeup: w, reason: "blocked" });
      continue;
    }
    if (fireAt(w, tz) > now) continue;
    switch (w.kind) {
      case "reminder":
        firings.push({
          kind: "fire",
          wakeup: w,
          key: eventKey.wakeup(w.id),
          event: { kind: "wakeup", wakeupId: w.id, key: w.key, origin: w.origin, note: w.note, dueAt: w.dueAt, firedAt: now },
          next: null,
        });
        break;
      case "checkin": {
        const day = localDate(now, tz);
        firings.push({
          kind: "fire",
          wakeup: w,
          key: eventKey.checkin(day),
          event: { kind: "checkin", day, dueAt: w.dueAt, firedAt: now },
          next: checkinWakeup(now, tz, checkinLocal),
        });
        break;
      }
    }
  }
  return firings;
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
  /** The earliest fireAt() over pending wake-ups. */
  readonly wakeupFireAt: EpochMs | null;
  readonly outboxReadyAt: EpochMs | null;
  /** Earliest time a log flush should run: now if rows wait and the last flush succeeded, else the backoff. */
  readonly logsReadyAt: EpochMs | null;
}): EpochMs | null {
  const times = [input.inboxReadyAt, input.wakeupFireAt, input.outboxReadyAt, input.logsReadyAt].filter(
    (t): t is EpochMs => t !== null,
  );
  if (times.length === 0) return null;
  return Math.max(input.now, Math.min(...times)) as EpochMs;
}
