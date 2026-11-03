import type { z } from "zod";
import type { Config } from "../config";
import { anthropicModel } from "./anthropic";
import { bridgeModel } from "./bridge";

export type ModelId = "claude-haiku-5-5" | "claude-sonnet-5-5";
export type Effort = "low" | "medium" | "high";

export const PURPOSES = ["turn", "compaction", "planning"] as const;
export type Purpose = (typeof PURPOSES)[number];

export type Route = { readonly model: ModelId; readonly maxTokens: number; readonly effort: Effort };

export const ROUTES: Readonly<Record<Purpose, Route>> = {
  turn: { model: "claude-haiku-5-5", maxTokens: 1200, effort: "low" },
  compaction: { model: "claude-haiku-5-5", maxTokens: 1500, effort: "low" },
  planning: { model: "claude-haiku-5-5", maxTokens: 4000, effort: "medium" },
};

export type Price = {
  readonly inputPerM: number;
  readonly outputPerM: number;
  readonly cacheWritePerM: number;
  readonly cacheReadPerM: number;
};
const PRICES: Readonly<Record<ModelId, Price>> = {
  "claude-haiku-5-5": { inputPerM: 100_000, outputPerM: 500_000, cacheWritePerM: 125_000, cacheReadPerM: 10_000 },
  "claude-sonnet-5-5": { inputPerM: 2_000_000, outputPerM: 10_000_000, cacheWritePerM: 2_500_000, cacheReadPerM: 200_000 },
};
export const priceOf = (m: ModelId): Price => PRICES[m];

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
  | "unavailable";

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
