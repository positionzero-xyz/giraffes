/**
 * When the agent may speak unasked. Pure.
 *
 * Single enforcement point: `admitUnasked` runs at *delivery* time on every outbox row whose intent is
 * "unasked", whatever produced it (wake-up, check-in, and in week 2 a job result). The scheduler also
 * calls `quietUntil` to fire wake-ups at 08:00 instead of composing at 23:00, but that is freshness,
 * not enforcement: removing it would delay messages, never leak one into quiet hours.
 */
import type { EpochMs, LocalDate, PersonStatus, TimeZone } from "../domain";

export const OUTREACH = {
  quietStartHour: 22, // inclusive, local
  quietEndHour: 8, //    exclusive, local
  dailyUnaskedBudget: 3,
} as const;

/** If `t` falls in 22:00–08:00 local, the instant quiet hours end. Otherwise null. */
export function quietUntil(t: EpochMs, tz: TimeZone): EpochMs | null {
  throw new Error("not implemented");
}

export type UnaskedVerdict =
  | { readonly verdict: "send"; readonly day: LocalDate }
  | { readonly verdict: "defer"; readonly until: EpochMs }
  | { readonly verdict: "drop"; readonly reason: "budget" | "blocked" };

/**
 * Order matters and is the policy:
 *   1. blocked → drop (the channel would reject it, and a block is final for the MVP's metrics).
 *   2. quiet hours → defer to 08:00. Budget is *not* consumed; the row is re-judged at 08:00 against
 *      that day's count.
 *   3. `sentToday >= dailyBudget` → drop. The caller logs the text to `unasked_message` with status
 *      `dropped_budget`.
 *   4. send, recording `day` on the row. `sentToday` is derived by counting rows admitted for `day`,
 *      so admission is idempotent: a re-run after a crash sees its own earlier admission and does not
 *      re-judge a row that already has `admitted_day`.
 */
export function admitUnasked(input: {
  readonly now: EpochMs;
  readonly tz: TimeZone;
  readonly sentToday: number;
  readonly dailyBudget: number;
  readonly status: PersonStatus;
}): UnaskedVerdict {
  throw new Error("not implemented");
}
