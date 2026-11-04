import type { MicroUsd } from "../domain";
import type { Usage } from "../model/client";
import type { Price } from "../model/providers";
import { PROMPT_OVERHEAD_TOKENS, type Route } from "../model/routes";

/** Whose money a metered call spends: the person's own key, or our included tier. */
export const SPEND_SCOPES = ["byok", "included"] as const;
export type SpendScope = (typeof SPEND_SCOPES)[number];

export type MonthSpend = { readonly spent: MicroUsd; readonly reserved: MicroUsd };

function priceAt(route: Route, promptTokens: number): Price {
  const { longPrompt } = route.card;
  return longPrompt?.price && promptTokens > longPrompt.aboveTokens ? longPrompt.price : route.card;
}

const withFee = (micro: number, route: Route) => Math.ceil((micro * (10_000 + route.feeBps)) / 10_000) as MicroUsd;

function priced(route: Route, usage: Usage): number {
  const p = priceAt(route, usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens);
  return (
    (usage.inputTokens * p.inputPerM + usage.outputTokens * p.outputPerM + usage.cacheWriteTokens * p.cacheWritePerM + usage.cacheReadTokens * p.cacheReadPerM) /
    1_000_000
  );
}

/**
 * An upper bound on one attempt's bill: no token is shorter than a byte, so every prompt byte plus the overhead is
 * priced as a cache write or as input, whichever costs more, and the route's full output budget is added, plus its fee.
 */
export function estimate(route: Route, promptBytes: number): MicroUsd {
  const tokens = promptBytes + PROMPT_OVERHEAD_TOKENS;
  const p = priceAt(route, tokens);
  return withFee(Math.ceil((tokens * Math.max(p.inputPerM, p.cacheWritePerM) + route.maxTokens * p.outputPerM) / 1_000_000), route);
}

/** A cost the provider reported wins over our card. */
export function costOf(route: Route, usage: Usage, reported: MicroUsd | null): MicroUsd {
  return withFee(reported ?? Math.ceil(priced(route, usage)), route);
}

export const fits = (month: MonthSpend, est: MicroUsd, cap: MicroUsd): boolean => month.spent + month.reserved + est <= cap;
