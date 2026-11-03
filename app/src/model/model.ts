import type { z } from "zod";
import type { Config } from "../config";
import { anthropicModel } from "./anthropic";
import { bridgeModel } from "./bridge";

export type ModelId = "claude-haiku-5-5" | "claude-sonnet-5-5";
export type Effort = "low" | "medium" | "high";

export const PURPOSES = ["turn", "compaction", "planning"] as const;
export type Purpose = (typeof PURPOSES)[number];

export type Route = { readonly model: ModelId; readonly maxTokens: number; readonly effort: Effort };

/** Turn and compaction budgets fit the largest output their schemas accept; policy.test.ts pins that. */
export const ROUTES: Readonly<Record<Purpose, Route>> = {
  turn: { model: "claude-haiku-5-5", maxTokens: 12_000, effort: "low" },
  compaction: { model: "claude-haiku-5-5", maxTokens: 12_500, effort: "low" },
  planning: { model: "claude-haiku-5-5", maxTokens: 4000, effort: "medium" },
};

export type Price = {
  readonly inputPerM: number;
  readonly outputPerM: number;
  readonly cacheWritePerM: number;
  readonly cacheReadPerM: number;
};
type RateCard = {
  readonly base: Price;
  readonly longPrompt: { readonly aboveTokens: number; readonly price: Price } | null;
};
const PRICES: Readonly<Record<ModelId, RateCard>> = {
  "claude-haiku-5-5": {
    base: { inputPerM: 100_000, outputPerM: 500_000, cacheWritePerM: 125_000, cacheReadPerM: 10_000 },
    longPrompt: { aboveTokens: 100_000, price: { inputPerM: 500_000, outputPerM: 2_500_000, cacheWritePerM: 625_000, cacheReadPerM: 50_000 } },
  },
  "claude-sonnet-5-5": {
    base: { inputPerM: 2_000_000, outputPerM: 10_000_000, cacheWritePerM: 2_500_000, cacheReadPerM: 200_000 },
    longPrompt: null,
  },
};

/** The prompt's size picks the rate card; input, cache-write and cache-read tokens all count toward it. */
export function priceOf(m: ModelId, promptTokens = 0): Price {
  const { base, longPrompt } = PRICES[m];
  return longPrompt && promptTokens > longPrompt.aboveTokens ? longPrompt.price : base;
}

export type Usage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheReadTokens: number;
};

export const routeOf = (p: Purpose): Route => ROUTES[p];

export type ModelRequest<T> = {
  readonly purpose: Purpose;
  readonly system: string;
  readonly user: string;
  readonly schema: z.ZodType<T>;
};

export type ModelFailure =
  | "invalid_output"
  | "refused_by_model"
  | "unavailable"
  | "in_doubt";

export type ModelResult<T> =
  | { readonly ok: true; readonly value: T; readonly usage: Usage }
  | { readonly ok: false; readonly failure: ModelFailure; readonly usage: Usage | null };

export interface ModelClient {
  parse<T>(req: ModelRequest<T>): Promise<ModelResult<T>>;
}

export function makeModelClient(config: Config["model"]): ModelClient {
  switch (config.backend) {
    case "anthropic":
      return anthropicModel(config.apiKey);
    case "bridge":
      return bridgeModel(config.bridgeUrl);
    case "scripted":
      return unscripted();
  }
}

function unscripted(): ModelClient {
  return {
    parse: async () => {
      throw new Error("MODEL_BACKEND=scripted: the test didn't inject a script (Agent.withDeps)");
    },
  };
}
