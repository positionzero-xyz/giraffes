import type { MicroUsd } from "../domain";
import { priceOf, type ModelId, type Usage } from "../model/model";

export const SPEND = {
  userCapMicro: 15_000_000 as MicroUsd,
  globalCeilingMicro: 1_500_000_000 as MicroUsd,
  leaseChunkMicro: 500_000 as MicroUsd,
} as const;

/** Room for the request framing and the output schema the API adds to the prompt. */
export const SCHEMA_ALLOWANCE_TOKENS = 4_000;

export type MonthSpend = {
  readonly spent: MicroUsd;
  readonly reserved: MicroUsd;
  readonly leased: MicroUsd;
};

function priced(model: ModelId, usage: Usage): MicroUsd {
  const p = priceOf(model, usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens);
  const microTimesMillion =
    usage.inputTokens * p.inputPerM +
    usage.outputTokens * p.outputPerM +
    usage.cacheWriteTokens * p.cacheWritePerM +
    usage.cacheReadTokens * p.cacheReadPerM;
  return Math.ceil(microTimesMillion / 1_000_000) as MicroUsd;
}

/**
 * An upper bound on the bill. No token is shorter than one UTF-8 byte in any script, cache writes are
 * the dearest way to pay for input, and the output can't pass `maxTokens`.
 */
export function estimate(model: ModelId, promptBytes: number, maxTokens: number): MicroUsd {
  return priced(model, {
    inputTokens: 0,
    outputTokens: maxTokens,
    cacheWriteTokens: promptBytes + SCHEMA_ALLOWANCE_TOKENS,
    cacheReadTokens: 0,
  });
}

export function costOf(model: ModelId, usage: Usage): MicroUsd {
  return priced(model, usage);
}

export type ReserveDecision =
  | { readonly kind: "reserve" }
  | { readonly kind: "need_lease"; readonly chunk: MicroUsd }
  | { readonly kind: "refuse"; readonly scope: "user_cap" };

export function decideReservation(month: MonthSpend, est: MicroUsd): ReserveDecision {
  const committed = month.spent + month.reserved + est;
  if (committed > SPEND.userCapMicro) return { kind: "refuse", scope: "user_cap" };
  if (committed > month.leased) {
    return { kind: "need_lease", chunk: Math.min(SPEND.leaseChunkMicro, SPEND.userCapMicro - month.leased) as MicroUsd };
  }
  return { kind: "reserve" };
}
