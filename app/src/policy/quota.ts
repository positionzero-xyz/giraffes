import type { EpochMs, UtcMonth } from "../domain";
import { utcMonth } from "./time";

/**
 * Pushes count against LINE's monthly message quota and replies don't. At the reserve, the last tenth of the
 * quota is kept for replies that fall back to a push and for reminders people asked for.
 */
export const LINE_QUOTA = { alertPercents: [70, 90], reservePercent: 90 } as const;

/** `limit` is null when the account has no monthly limit. */
export type QuotaReading = { readonly at: EpochMs; readonly month: UtcMonth; readonly limit: number | null; readonly used: number };

function usedPercent(r: QuotaReading): number | null {
  if (r.limit === null) return null;
  return r.limit > 0 ? Math.floor((r.used * 100) / r.limit) : 100;
}

export function alertsDue(r: QuotaReading, alerted: readonly number[]): number[] {
  const used = usedPercent(r);
  return used === null ? [] : LINE_QUOTA.alertPercents.filter((p) => used >= p && !alerted.includes(p));
}

export function quotaAlert(r: QuotaReading, percent: number): string {
  return `LINE messages this month: ${r.used} of ${r.limit} (${usedPercent(r)}%), past the ${percent}% alert.`;
}

/** A reading from an earlier month says nothing about this one, since the quota starts again each month. */
export function inLineReserve(r: QuotaReading | null, now: EpochMs): boolean {
  if (r === null || r.month !== utcMonth(now)) return false;
  const used = usedPercent(r);
  return used !== null && used >= LINE_QUOTA.reservePercent;
}
