export const PROVIDER_IDS = ["anthropic", "opencode-go", "openrouter", "deepinfra", "alibaba", "mistral", "anthropic-compatible", "openai-compatible"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
export const isProviderId = (s: string): s is ProviderId => PROVIDER_IDS.some((p) => p === s);

export type Protocol = "anthropic" | "openai";
export type Auth = "x-api-key" | "bearer";

/** A provider-qualified model id. Box calls use the pseudo-provider "claude-plan", and the dev bridge "bridge". */
export type ModelRef = `${ProviderId | "claude-plan" | "bridge"}:${string}`;

/** Micro-USD per million tokens. */
export type Price = { readonly inputPerM: number; readonly outputPerM: number; readonly cacheWritePerM: number; readonly cacheReadPerM: number };

export type RateCard = Price & {
  /** Prompts above this many tokens bill on `price`. Every route's prompt budget sits below it, so a null price is never reached. */
  readonly longPrompt: { readonly aboveTokens: number; readonly price: Price | null } | null;
  /** Null when the provider doesn't publish it; the prompt ceiling bounds the prompt then. */
  readonly contextTokens: number | null;
};

export type ProviderModel = { readonly card: RateCard; readonly effort: boolean };

export type Provider = {
  readonly label: string;
  readonly protocol: Protocol;
  /** Null: the person types an https URL. */
  readonly baseUrl: string | null;
  readonly auth: Auth;
  /** A typo check on the pasted key, not a validation. */
  readonly keyShape: RegExp | null;
  /** Null: the person types one. */
  readonly defaultModel: string | null;
  /** Models whose every price is published; any other model is priced at its protocol's dearest card and shown as approximate. */
  readonly models: Readonly<Record<string, ProviderModel>>;
  /** "probe": the connect probe decides between strict and loose. */
  readonly schema: "strict" | "probe" | "loose";
  /** A fee on top of list price, in basis points. */
  readonly feeBps: number;
  readonly headers: (ctx: { readonly session: string }) => Readonly<Record<string, string>>;
  readonly body: Readonly<Record<string, unknown>>;
  readonly signup: string | null;
};

const usd = (n: number) => Math.round(n * 1_000_000);

export const HAIKU_5_5: RateCard = {
  inputPerM: usd(0.1),
  outputPerM: usd(0.5),
  cacheWritePerM: usd(0.125),
  cacheReadPerM: usd(0.01),
  longPrompt: { aboveTokens: 100_000, price: { inputPerM: usd(0.5), outputPerM: usd(2.5), cacheWritePerM: usd(0.625), cacheReadPerM: usd(0.05) } },
  contextTokens: null,
};

/** OpenCode Go meters each model at its list price; Haiku's list price is Anthropic's, and Go serves it up to 100K tokens. */
const GO_HAIKU: RateCard = { ...HAIKU_5_5, longPrompt: { aboveTokens: 100_000, price: null } };

/** On an OpenAI-compatible API a cache write is billed as input, since usage reports no write tokens. */
const openaiCard = (input: number, cacheRead: number, output: number, longPrompt: RateCard["longPrompt"] = null): RateCard => ({
  inputPerM: usd(input),
  outputPerM: usd(output),
  cacheWritePerM: usd(input),
  cacheReadPerM: usd(cacheRead),
  longPrompt,
  contextTokens: null,
});

const none = () => ({});

export const PROVIDERS: Readonly<Record<ProviderId, Provider>> = {
  anthropic: {
    label: "Anthropic",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com",
    auth: "x-api-key",
    keyShape: /^sk-ant-/,
    defaultModel: "claude-haiku-5-5",
    models: { "claude-haiku-5-5": { card: HAIKU_5_5, effort: true } },
    schema: "strict",
    feeBps: 0,
    headers: none,
    body: {},
    signup: "https://platform.claude.com",
  },
  "opencode-go": {
    label: "OpenCode Go",
    protocol: "anthropic",
    baseUrl: "https://opencode.ai/inference/go/anthropic",
    auth: "bearer",
    keyShape: /^oc_sk_/,
    defaultModel: "claude-haiku-5-5",
    models: { "claude-haiku-5-5": { card: GO_HAIKU, effort: true } },
    schema: "probe",
    feeBps: 0,
    headers: ({ session }) => ({ "user-agent": "giraffes/1", "x-opencode-session": session }),
    body: {},
    signup: "https://opencode.ai/go",
  },
  openrouter: {
    label: "OpenRouter",
    protocol: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    auth: "bearer",
    keyShape: /^sk-or-/,
    defaultModel: "anthropic/claude-haiku-5.5",
    models: { "anthropic/claude-haiku-5.5": { card: HAIKU_5_5, effort: false } },
    schema: "strict",
    feeBps: 550,
    headers: none,
    body: { provider: { require_parameters: true }, usage: { include: true } },
    signup: "https://openrouter.ai/keys",
  },
  deepinfra: {
    label: "DeepInfra",
    protocol: "openai",
    baseUrl: "https://api.deepinfra.com/v1/openai",
    auth: "bearer",
    keyShape: null,
    defaultModel: "deepseek-ai/DeepSeek-V4-Flash-0731",
    models: { "deepseek-ai/DeepSeek-V4-Flash-0731": { card: openaiCard(0.06, 0.015, 0.18), effort: false } },
    schema: "strict",
    feeBps: 0,
    headers: none,
    body: {},
    signup: "https://deepinfra.com",
  },
  alibaba: {
    label: "Alibaba Model Studio",
    protocol: "openai",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    auth: "bearer",
    keyShape: /^sk-/,
    defaultModel: "qwen3.7-flash",
    models: { "qwen3.7-flash": { card: openaiCard(0.03, 0.006, 0.13, { aboveTokens: 32_000, price: null }), effort: false } },
    schema: "loose",
    feeBps: 0,
    headers: none,
    body: {},
    signup: "https://www.alibabacloud.com/product/modelstudio",
  },
  mistral: {
    label: "Mistral",
    protocol: "openai",
    baseUrl: "https://api.mistral.ai/v1",
    auth: "bearer",
    keyShape: null,
    defaultModel: "mistral-small-2603",
    /** Mistral publishes no cached-input price for Small 4, so a cache read is priced as input. */
    models: { "mistral-small-2603": { card: openaiCard(0.15, 0.15, 0.6), effort: false } },
    schema: "probe",
    feeBps: 0,
    headers: none,
    body: {},
    signup: "https://console.mistral.ai/api-keys",
  },
  "anthropic-compatible": {
    label: "Other (Anthropic-compatible)",
    protocol: "anthropic",
    baseUrl: null,
    auth: "bearer",
    keyShape: null,
    defaultModel: null,
    models: {},
    schema: "probe",
    feeBps: 0,
    headers: none,
    body: {},
    signup: null,
  },
  "openai-compatible": {
    label: "Other (OpenAI-compatible)",
    protocol: "openai",
    baseUrl: null,
    auth: "bearer",
    keyShape: null,
    defaultModel: null,
    models: {},
    schema: "probe",
    feeBps: 0,
    headers: none,
    body: {},
    signup: null,
  },
};

const dearness = (c: RateCard) => c.inputPerM + c.outputPerM;

/**
 * A model nobody published a card for (a custom endpoint, an unlisted model) is priced at the dearest card any preset
 * on its protocol publishes, so a cap on it is never looser than on a listed model.
 */
export function modelOf(
  provider: ProviderId,
  model: string,
  table: Readonly<Record<ProviderId, Provider>> = PROVIDERS,
): { readonly model: ProviderModel; readonly priced: boolean } {
  const known = table[provider].models[model];
  if (known) return { model: known, priced: true };
  const protocol = table[provider].protocol;
  const cards = Object.values(table)
    .filter((p) => p.protocol === protocol)
    .flatMap((p) => Object.values(p.models).map((m) => m.card));
  const card = cards.reduce((a, b) => (dearness(b) > dearness(a) ? b : a), cards[0] ?? HAIKU_5_5);
  return { model: { card, effort: false }, priced: false };
}
