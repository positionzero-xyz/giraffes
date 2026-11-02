/**
 * Spend policy. Pure.
 *
 * Two limits, two owners, no shared hot counter:
 *   - Per-user cap ($15/month): owned by the person's Durable Object. Checked in a local SQLite
 *     transaction, so reserve-before-call is atomic with no network hop.
 *   - Global ceiling ($1,500/month): owned by D1 as a set of *leases*. A Durable Object spends only from
 *     lease chunks it has been granted; it asks D1 for another chunk when its local headroom runs out.
 *     The sum of granted leases never exceeds the ceiling (one conditional INSERT in D1). This is
 *     per-actor state with a merge at the boundary instead of a global counter every call must touch.
 *
 * Unused lease at month end is the over-reservation we accept: at most `leaseChunk` per active agent.
 */
import type { MicroUsd } from "../domain";
import { priceOf, type ModelId, type Usage } from "../model/model";

export const SPEND = {
  userCapMicro: 15_000_000 as MicroUsd,
  globalCeilingMicro: 1_500_000_000 as MicroUsd,
  leaseChunkMicro: 500_000 as MicroUsd,
} as const;

const CHARS_PER_TOKEN = 3;

/** Local spend state for the current month, as derived from the agent's tables. */
export type MonthSpend = {
  /** Settled actual cost (plus crash-recovered estimates). */
  readonly spent: MicroUsd;
  /** Sum of open reservations. Derived: SUM(reservation.micro). */
  readonly reserved: MicroUsd;
  /** Sum of global-ceiling leases granted to this agent this month. */
  readonly leased: MicroUsd;
};

/** Token counts times per-million prices, rounded up to whole micro-dollars. */
function priced(model: ModelId, usage: Usage): MicroUsd {
  const p = priceOf(model);
  const microTimesMillion =
    usage.inputTokens * p.inputPerM +
    usage.outputTokens * p.outputPerM +
    usage.cacheWriteTokens * p.cacheWritePerM +
    usage.cacheReadTokens * p.cacheReadPerM;
  return Math.ceil(microTimesMillion / 1_000_000) as MicroUsd;
}

/**
 * Worst-case cost of a call before it is made: input estimated from characters (≈3 chars/token,
 * rounded up, all priced as uncached input) plus `maxTokens` of output. Over-estimates on purpose;
 * the reservation is released down to actual on settle.
 */
export function estimate(model: ModelId, promptChars: number, maxTokens: number): MicroUsd {
  return priced(model, {
    inputTokens: Math.ceil(promptChars / CHARS_PER_TOKEN),
    outputTokens: maxTokens,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
  });
}

/** Actual cost from the response's `usage`, including cache reads and writes at their own rates. */
export function costOf(model: ModelId, usage: Usage): MicroUsd {
  return priced(model, usage);
}

export type ReserveDecision =
  | { readonly kind: "reserve" }
  /** Local headroom is short; ask the ledger for `chunk` against the global ceiling, then decide again. */
  | { readonly kind: "need_lease"; readonly chunk: MicroUsd }
  | { readonly kind: "refuse"; readonly scope: "user_cap" };

/**
 * spent + reserved + est > userCap            → refuse(user_cap)
 * spent + reserved + est > leased             → need_lease(min(leaseChunk, userCap - leased))
 * otherwise                                   → reserve
 * A "ceiling" answer from the ledger turns need_lease into refuse(global_ceiling) at the caller.
 */
export function decideReservation(month: MonthSpend, est: MicroUsd): ReserveDecision {
  const committed = month.spent + month.reserved + est;
  if (committed > SPEND.userCapMicro) return { kind: "refuse", scope: "user_cap" };
  if (committed > month.leased) {
    return { kind: "need_lease", chunk: Math.min(SPEND.leaseChunkMicro, SPEND.userCapMicro - month.leased) as MicroUsd };
  }
  return { kind: "reserve" };
}
