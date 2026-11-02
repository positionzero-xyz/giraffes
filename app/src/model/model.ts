/**
 * The model port: one interface, three backends (Anthropic SDK, local `claude -p` bridge, scripted fake),
 * plus the two decisions that must live in exactly one place: routing and prices.
 *
 * Callers never see SDK types. A backend parses its wire response into `ModelResult` and validates the
 * structured output with the caller's zod schema before returning it.
 */
import type { z } from "zod";
import type { Config } from "../config";

export type ModelId = "claude-haiku-5-5" | "claude-sonnet-5-5";
export type Effort = "low" | "medium" | "high";

/** Why the agent is calling. Routing is keyed on this and nothing else. */
export type Purpose = "turn" | "compaction" | "planning";

export type Route = { readonly model: ModelId; readonly maxTokens: number; readonly effort: Effort };

/**
 * The single routing decision. Week 1 routes everything to Haiku; week 2 points "planning" at Sonnet
 * by editing this table.
 */
export const ROUTES: Readonly<Record<Purpose, Route>> = {
  turn: { model: "claude-haiku-5-5", maxTokens: 1200, effort: "low" },
  compaction: { model: "claude-haiku-5-5", maxTokens: 1500, effort: "low" },
  planning: { model: "claude-haiku-5-5", maxTokens: 4000, effort: "medium" },
};

/**
 * Micro-USD per million tokens. Source: week-1 brief (Haiku $0.10/$0.50, Sonnet $2/$10 per MTok).
 * Cache multipliers (write 1.25x, read 0.1x of input) are the published Anthropic ratios; confirm for
 * the 5.5 models before launch.
 */
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
  /** Backends resolve the model with `routeOf(purpose)`; the agent uses the same call to estimate spend. */
  readonly purpose: Purpose;
  /** Byte-stable across calls (see agent/prompt.ts) so the prompt cache hits. Sent first with cache_control. */
  readonly system: string;
  /** Per-event content. Everything that varies goes here, after the system prompt. */
  readonly user: string;
  readonly schema: z.ZodType<T>;
};

export type ModelFailure =
  /** The response didn't parse against the schema, or hit max_tokens mid-JSON. Usage is still billed. */
  | "invalid_output"
  /** stop_reason "refusal". */
  | "refused_by_model"
  /** 429/529/5xx after the backend's own bounded retries. */
  | "unavailable";

export type ModelResult<T> =
  | { readonly ok: true; readonly value: T; readonly usage: Usage }
  /** `usage` is null only when the request never reached the model (transport failure). */
  | { readonly ok: false; readonly failure: ModelFailure; readonly usage: Usage | null };

export interface ModelClient {
  /**
   * One structured call. Returns model-side problems as values; throws only on programmer error
   * (bad config). Never retries in a way that could double-bill silently: any internal retry is
   * reported in `usage` as the sum of attempts.
   */
  parse<T>(req: ModelRequest<T>): Promise<ModelResult<T>>;
}

/** Picks the backend from validated config. The only place that knows all three exist. */
export function makeModelClient(config: Config): ModelClient {
  // TODO: switch (config.model.backend) {
  //   case "anthropic": return anthropicModel(config.model.apiKey);
  //   case "bridge":    return bridgeModel(config.model.bridgeUrl);
  //   case "scripted":  throw new Error("scripted model must be injected by the test via Agent.withDeps");
  // }
  throw new Error("not implemented");
}
