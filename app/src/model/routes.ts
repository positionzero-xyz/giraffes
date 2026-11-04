import { HAIKU_5_5, modelOf, PROVIDER_IDS, PROVIDERS, type ModelRef, type ProviderId, type RateCard } from "./providers";

export const PURPOSES = ["turn", "compaction"] as const;
export type Purpose = (typeof PURPOSES)[number];
/** A connect probe is a call of its own, logged and charged like the others. */
export type CallPurpose = Purpose | "probe";
export type Effort = "low" | "medium" | "high";

export const OUTPUT_TOKENS: Readonly<Record<CallPurpose, number>> = { turn: 18_000, compaction: 12_500, probe: 64 };
/** The most prompt bytes any route takes, before its card's own limits. */
export const PROMPT_CEILING_BYTES = 80_000;
/** Framing plus the injected schema. */
export const PROMPT_OVERHEAD_TOKENS = 4_000;
const PROMPT_MARGIN_TOKENS = 1_000;

export type Route = {
  readonly ref: ModelRef;
  /** What goes on the wire. */
  readonly model: string;
  readonly purpose: CallPurpose;
  readonly maxTokens: number;
  readonly effort: Effort | null;
  readonly card: RateCard;
  /** False: priced at NOMINAL, so a cap bounds tokens rather than dollars, and the person is told it is approximate. */
  readonly priced: boolean;
  readonly feeBps: number;
  /** UTF-8 bytes of system plus user that keep the prompt under the card's long-prompt tier and its context. */
  readonly promptBytes: number;
};

export type BoxProvider = "claude";

export type Source =
  | { readonly kind: "box"; readonly provider: BoxProvider }
  | { readonly kind: "key"; readonly provider: ProviderId; readonly model: string }
  | { readonly kind: "included"; readonly provider: ProviderId; readonly model: string }
  | { readonly kind: "dev"; readonly model: string };

const BOX_MODEL = "claude-haiku-5-5";

/** Bytes bound tokens: every tokenizer here is byte-level, so no token is shorter than a byte. */
export function promptBytesFor(card: RateCard, purpose: CallPurpose): number {
  const tier = card.longPrompt?.aboveTokens ?? Infinity;
  const context = card.contextTokens === null ? Infinity : card.contextTokens - OUTPUT_TOKENS[purpose];
  return Math.min(PROMPT_CEILING_BYTES, Math.min(tier, context) - PROMPT_OVERHEAD_TOKENS - PROMPT_MARGIN_TOKENS);
}

function route(ref: ModelRef, model: string, purpose: CallPurpose, card: RateCard, priced: boolean, effort: boolean, feeBps: number): Route {
  return {
    ref,
    model,
    purpose,
    maxTokens: OUTPUT_TOKENS[purpose],
    effort: effort ? "low" : null,
    card,
    priced,
    feeBps,
    promptBytes: promptBytesFor(card, purpose),
  };
}

export function routeFor(source: Source, purpose: CallPurpose): Route {
  switch (source.kind) {
    case "box":
      return route(`claude-plan:${BOX_MODEL}`, BOX_MODEL, purpose, HAIKU_5_5, true, true, 0);
    case "dev":
      return route(`bridge:${source.model}`, source.model, purpose, HAIKU_5_5, true, true, 0);
    case "key":
    case "included": {
      const { model, priced } = modelOf(source.provider, source.model);
      return route(`${source.provider}:${source.model}`, source.model, purpose, model.card, priced, model.effort, PROVIDERS[source.provider].feeBps);
    }
  }
}

/** The smallest prompt budget over every priced model, per purpose. Compaction plans its page against it. */
export const PROMPT_FLOOR_BYTES: Readonly<Record<Purpose, number>> = {
  turn: floor("turn"),
  compaction: floor("compaction"),
};

function floor(purpose: Purpose): number {
  const cards = PROVIDER_IDS.flatMap((p) => Object.values(PROVIDERS[p].models).map((m) => m.card));
  return Math.min(promptBytesFor(HAIKU_5_5, purpose), ...cards.map((c) => promptBytesFor(c, purpose)));
}
