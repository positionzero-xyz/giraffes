import type { EpochMs, LocalDate, PersonStatus, TimeOfDay, TimeZone } from "../domain";
import { localDate, localHour, nextLocalTime } from "./time";

export const OUTREACH = {
  quietStartHour: 22,
  quietEndHour: 8,
  dailyUnaskedBudget: 3,
} as const;

export function quietUntil(t: EpochMs, tz: TimeZone): EpochMs | null {
  const h = localHour(t, tz);
  if (h >= OUTREACH.quietEndHour && h < OUTREACH.quietStartHour) return null;
  return nextLocalTime(t, tz, `${String(OUTREACH.quietEndHour).padStart(2, "0")}:00` as TimeOfDay);
}

export type UnaskedVerdict =
  | { readonly verdict: "send"; readonly day: LocalDate }
  | { readonly verdict: "defer"; readonly until: EpochMs }
  | { readonly verdict: "drop"; readonly reason: "budget" | "blocked" };

/** Quiet hours apply to every attempt; the budget is charged once per local day a row goes out on. */
export function admitUnasked(input: {
  readonly now: EpochMs;
  readonly tz: TimeZone;
  readonly admitted: LocalDate | null;
  readonly sentToday: number;
  readonly dailyBudget: number;
  readonly status: PersonStatus;
}): UnaskedVerdict {
  if (input.status === "blocked") return { verdict: "drop", reason: "blocked" };
  const until = quietUntil(input.now, input.tz);
  if (until !== null) return { verdict: "defer", until };
  const today = localDate(input.now, input.tz);
  if (input.admitted === today) return { verdict: "send", day: today };
  if (input.sentToday >= input.dailyBudget) return { verdict: "drop", reason: "budget" };
  return { verdict: "send", day: today };
}
