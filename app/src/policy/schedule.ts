import {
  CHECKIN_KEY,
  eventKey,
  parseWakeupKey,
  type AgentEvent,
  type AgentEventKind,
  type EpochMs,
  type EventKey,
  type LocalDate,
  type PersonStatus,
  type Repeat,
  type TaskId,
  type TimeOfDay,
  type TimeZone,
  type WakeupId,
  type WakeupKey,
} from "../domain";
import { quietUntil } from "./outreach";
import { dayOfWeek, fromLocal, localDate, nextLocalTime, parseLocalDateTime, toLocal } from "./time";

const MINUTE_MS = 60 * 1000;

export const SCHEDULE = {
  maxPendingReminders: 20,
  lateAfterMs: 60 * 60 * 1000,
  agentMinLeadMs: MINUTE_MS,
  maxHorizonMs: 366 * 24 * 60 * 60 * 1000,
  defaultCheckinLocal: "09:00",
} as const;

export type PendingWakeup = {
  readonly id: WakeupId;
  readonly key: WakeupKey;
  readonly note: string;
  readonly dueAt: EpochMs;
} & (
  | { readonly kind: "reminder"; readonly origin: "person" | "agent"; readonly task: TaskId | null; readonly bookkeeping: boolean; readonly repeat: Repeat | null }
  | { readonly kind: "checkin"; readonly origin: "system" }
);

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A wake-up before it has an id. A reminder's task is linked when it is stored, since it may name a task opened in the same turn. */
export type NewWakeup = DistributiveOmit<PendingWakeup, "id" | "task">;
export type NewReminder = Extract<NewWakeup, { kind: "reminder" }>;

export function wakeupOrigin(trigger: AgentEventKind, askedFor: boolean): "person" | "agent" {
  return trigger === "message" && askedFor ? "person" : "agent";
}

export const REMINDER_REJECTIONS = ["duplicate", "limit", "past", "too_far", "bad_time", "bad_key", "reserved_key"] as const;
export type ReminderRejection = (typeof REMINDER_REJECTIONS)[number];

export type ReminderAdmission =
  | { readonly ok: true; readonly wakeup: NewReminder }
  | { readonly ok: false; readonly reason: ReminderRejection };

export function admitReminder(
  req: { readonly key: string; readonly at: string; readonly note: string; readonly origin: "person" | "agent"; readonly repeat: Repeat["every"] | null },
  ctx: { readonly now: EpochMs; readonly tz: TimeZone; readonly pending: ReadonlyMap<WakeupKey, NewWakeup> },
): ReminderAdmission {
  const key = parseWakeupKey(req.key);
  if (key === null) return { ok: false, reason: "bad_key" };
  if (key === CHECKIN_KEY) return { ok: false, reason: "reserved_key" };
  const at = parseLocalDateTime(req.at);
  if (at === null) return { ok: false, reason: "bad_time" };
  const dueAt = fromLocal(at, ctx.tz);
  const earliest = req.origin === "person" ? ctx.now - (ctx.now % MINUTE_MS) : ctx.now + SCHEDULE.agentMinLeadMs;
  if (dueAt < earliest) return { ok: false, reason: "past" };
  if (dueAt > ctx.now + SCHEDULE.maxHorizonMs) return { ok: false, reason: "too_far" };
  if (ctx.pending.has(key)) return { ok: false, reason: "duplicate" };
  const repeat = req.repeat === null ? null : { every: req.repeat, anchor: at };
  return { ok: true, wakeup: { key, kind: "reminder", origin: req.origin, note: req.note, dueAt, bookkeeping: false, repeat } };
}

export function nextOccurrence(r: Repeat, after: EpochMs, tz: TimeZone): EpochMs {
  const time = r.anchor.slice(11) as TimeOfDay;
  const anchorDay = dayOfWeek(r.anchor.slice(0, 10) as LocalDate);
  const fits = (t: EpochMs) => {
    const d = dayOfWeek(localDate(t, tz));
    return r.every === "daily" || (r.every === "weekdays" ? d >= 1 && d <= 5 : d === anchorDay);
  };
  let t = nextLocalTime(after, tz, time);
  while (!fits(t)) t = nextLocalTime(t, tz, time);
  return t;
}

export function remindersOverCap(pending: Iterable<NewWakeup>): number {
  let reminders = 0;
  for (const w of pending) if (w.kind === "reminder") reminders++;
  return Math.max(0, reminders - SCHEDULE.maxPendingReminders);
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

/** A reminder keeps its local wall time in the new zone; the check-in moves to its next local time there. */
export function retime(w: NewWakeup, from: TimeZone, to: TimeZone, now: EpochMs, checkinLocal: TimeOfDay): EpochMs {
  return w.kind === "checkin" ? checkinWakeup(now, to, checkinLocal).dueAt : fromLocal(toLocal(w.dueAt, from), to);
}

export function fireAt(w: { readonly origin: PendingWakeup["origin"]; readonly dueAt: EpochMs }, tz: TimeZone): EpochMs {
  if (w.origin === "person") return w.dueAt;
  return quietUntil(w.dueAt, tz) ?? w.dueAt;
}

export type Firing =
  | {
      readonly kind: "fire";
      readonly wakeup: PendingWakeup;
      readonly key: EventKey;
      readonly event: Extract<AgentEvent, { kind: "wakeup" } | { kind: "checkin" }>;
      readonly next: NewWakeup | null;
    }
  | { readonly kind: "skip"; readonly wakeup: PendingWakeup; readonly reason: "blocked" };

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
          event: {
            kind: "wakeup",
            wakeupId: w.id,
            key: w.key,
            origin: w.origin,
            note: w.note,
            dueAt: w.dueAt,
            firedAt: now,
            task: w.task,
            bookkeeping: w.bookkeeping,
            repeat: w.repeat,
          },
          next: w.repeat && { key: w.key, kind: "reminder", origin: w.origin, note: w.note, dueAt: nextOccurrence(w.repeat, now, tz), bookkeeping: false, repeat: w.repeat },
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

export function nextAlarm(input: {
  readonly now: EpochMs;
  readonly inboxReadyAt: EpochMs | null;
  readonly wakeupFireAt: EpochMs | null;
  readonly outboxReadyAt: EpochMs | null;
  readonly logsReadyAt: EpochMs | null;
  readonly compactionRetryAt: EpochMs | null;
  readonly boxAt: EpochMs | null;
}): EpochMs | null {
  const times = [input.inboxReadyAt, input.wakeupFireAt, input.outboxReadyAt, input.logsReadyAt, input.compactionRetryAt, input.boxAt].filter(
    (t): t is EpochMs => t !== null,
  );
  if (times.length === 0) return null;
  return Math.max(input.now, Math.min(...times)) as EpochMs;
}
