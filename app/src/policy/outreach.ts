import type { EpochMs, LocalDate, PersonStatus, TimeZone } from "../domain";
import { localDate, localHour, nextLocalTime } from "./time";

export const OUTREACH = {
  quietStartHour: 22,
  quietEndHour: 8,
  dailyUnaskedBudget: 3,
} as const;

export function quietUntil(t: EpochMs, tz: TimeZone): EpochMs | null {
  const h = localHour(t, tz);
  if (h >= OUTREACH.quietEndHour && h < OUTREACH.quietStartHour) return null;
  return nextLocalTime(t, tz, "08:00");
}

export type UnaskedVerdict =
  | { readonly verdict: "send"; readonly day: LocalDate }
  | { readonly verdict: "defer"; readonly until: EpochMs }
  | { readonly verdict: "drop"; readonly reason: "budget" | "blocked" };

export function admitUnasked(input: {
  readonly now: EpochMs;
  readonly tz: TimeZone;
  readonly sentToday: number;
  readonly dailyBudget: number;
  readonly status: PersonStatus;
}): UnaskedVerdict {
  if (input.status === "blocked") return { verdict: "drop", reason: "blocked" };
  const until = quietUntil(input.now, input.tz);
  if (until !== null) return { verdict: "defer", until };
  if (input.sentToday >= input.dailyBudget) return { verdict: "drop", reason: "budget" };
  return { verdict: "send", day: localDate(input.now, input.tz) };
}
