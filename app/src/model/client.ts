import { z } from "zod";
import { readBody } from "../body";
import type { MicroUsd } from "../domain";
import type { Auth, Protocol, ProviderId } from "./providers";
import type { CallPurpose, Route } from "./routes";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export type SchemaMode = "strict" | "loose";
export type JsonSchema = Readonly<Record<string, unknown>>;

export type Usage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheReadTokens: number;
};

/** A credential that a log line or a JSON dump prints as a placeholder. */
export class SecretKey {
  readonly #value: string;
  private constructor(value: string) {
    this.#value = value;
  }
  /** Trims; 8 to 512 printable ASCII characters, else null. */
  static from(raw: string): SecretKey | null {
    const v = raw.trim();
    return /^[\x21-\x7e]{8,512}$/.test(v) ? new SecretKey(v) : null;
  }
  reveal(): string {
    return this.#value;
  }
  get hint(): string {
    return this.#value.slice(-4);
  }
  toString(): string {
    return "[key]";
  }
  toJSON(): string {
    return "[key]";
  }
}

export type Endpoint = {
  readonly provider: ProviderId | "bridge";
  readonly protocol: Protocol | "bridge";
  readonly baseUrl: string;
  readonly auth: Auth | "none";
  readonly key: SecretKey | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Readonly<Record<string, unknown>>;
};

export type WireRequest = {
  readonly route: Route;
  readonly mode: SchemaMode;
  readonly system: string;
  readonly user: string;
  readonly schema: JsonSchema;
  readonly repair: { readonly previous: string; readonly issues: string } | null;
};

/** One HTTP attempt, read only as far as HTTP. Never throws for an HTTP or network failure. */
export type WireResult =
  | {
      readonly kind: "reply";
      readonly text: string;
      readonly stop: "end" | "max_tokens" | "refusal";
      /** Null: the provider ran the call but said nothing about what it used. */
      readonly usage: Usage | null;
      readonly reportedMicro: MicroUsd | null;
    }
  | { readonly kind: "status"; readonly status: number; readonly retryAfterMs: number | null; readonly billing: boolean }
  | { readonly kind: "network" }
  | { readonly kind: "provider_fault"; readonly reason: "redirect" | "response_too_large" }
  /** The dev bridge didn't answer or answered with an error: nothing ran on anyone's account. */
  | { readonly kind: "unreachable" };

export interface ModelClient {
  send(req: WireRequest): Promise<WireResult>;
}
export type Connect = (e: Endpoint) => ModelClient;

/** How long one attempt may take, headers and body together, before it counts as in doubt. */
export type ProviderTimeouts = Readonly<Record<CallPurpose, number>>;
export const PROVIDER_TIMEOUT_MS: ProviderTimeouts = { turn: 60_000, compaction: 60_000, probe: 20_000 };

export const LOOSE_INSTRUCTION = "Reply with only one JSON object that matches this JSON Schema:";
const REPAIR_INSTRUCTION = "That reply didn't match the schema. Reply with only the corrected JSON object.";
const BILLING_ERROR = /credit|balance|billing|insufficient|payment|quota/i;
const MAX_RETRY_AFTER_MS = 24 * 60 * 60_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export const looseUser = (user: string, schema: JsonSchema): string => `${user}\n\n${LOOSE_INSTRUCTION}\n${JSON.stringify(schema)}`;

function retryAfterMs(h: string | null): number | null {
  if (h === null) return null;
  const s = Number(h);
  if (Number.isFinite(s) && s >= 0) return Math.min(s * 1000, MAX_RETRY_AFTER_MS);
  const at = Date.parse(h);
  return Number.isNaN(at) ? null : Math.min(Math.max(0, at - Date.now()), MAX_RETRY_AFTER_MS);
}

type PostResult = { readonly kind: "body"; readonly body: string } | Exclude<WireResult, { kind: "reply" | "unreachable" }>;

function jsonOf(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function authHeaders(e: Endpoint): Record<string, string> {
  if (e.key === null || e.auth === "none") return {};
  return e.auth === "x-api-key" ? { "x-api-key": e.key.reveal() } : { authorization: `Bearer ${e.key.reveal()}` };
}

async function post(fetch: Fetch, url: string, headers: Record<string, string>, body: string, timeoutMs: number): Promise<PostResult> {
  try {
    const res = await fetch(url, { method: "POST", redirect: "manual", headers: { "content-type": "application/json", ...headers }, body, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status >= 300 && res.status < 400) {
      void res.body?.cancel().catch(() => {});
      return { kind: "provider_fault", reason: "redirect" };
    }
    const bytes = await readBody(res.body, MAX_RESPONSE_BYTES);
    if (bytes === null) return { kind: "provider_fault", reason: "response_too_large" };
    const text = new TextDecoder().decode(bytes);
    if (res.ok) return { kind: "body", body: text };
    return { kind: "status", status: res.status, retryAfterMs: retryAfterMs(res.headers.get("retry-after")), billing: res.status === 402 || BILLING_ERROR.test(text) };
  } catch {
    return { kind: "network" };
  }
}

export const UNREADABLE_REPLY: Extract<WireResult, { kind: "reply" }> ={ kind: "reply", text: "", stop: "end", usage: null, reportedMicro: null };

const tokenCount = z.number().int().nonnegative();
const TokenUsage = z.object({
  input_tokens: tokenCount,
  output_tokens: tokenCount,
  cache_creation_input_tokens: tokenCount.nullish(),
  cache_read_input_tokens: tokenCount.nullish(),
});

function readTokenUsage(raw: unknown): Usage | null {
  const usage = TokenUsage.safeParse(raw).data;
  return usage ? {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
  } : null;
}

const AnthropicReply = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  stop_reason: z.string().nullable(),
  usage: z.unknown().optional(),
});

function anthropic(fetch: Fetch, e: Endpoint, timeouts: ProviderTimeouts): ModelClient {
  return {
    async send(req) {
      const user = req.mode === "loose" ? looseUser(req.user, req.schema) : req.user;
      const messages = req.repair
        ? [
            { role: "user", content: user },
            { role: "assistant", content: req.repair.previous },
            { role: "user", content: `${REPAIR_INSTRUCTION}\n${req.repair.issues}` },
          ]
        : [{ role: "user", content: user }];
      const output = req.mode === "strict" ? { format: { type: "json_schema", schema: req.schema }, ...(req.route.effort ? { effort: req.route.effort } : {}) } : null;
      const body = JSON.stringify({
        ...e.body,
        model: req.route.model,
        max_tokens: req.route.maxTokens,
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        messages,
        ...(output ? { output_config: output } : {}),
      });
      const res = await post(fetch, `${e.baseUrl}/v1/messages`, { "anthropic-version": "2023-06-01", ...authHeaders(e), ...e.headers }, body, timeouts[req.route.purpose]);
      if (res.kind !== "body") return res;
      const parsed = AnthropicReply.safeParse(jsonOf(res.body));
      if (!parsed.success) return UNREADABLE_REPLY;
      const r = parsed.data;
      return {
        kind: "reply",
        text: r.content.flatMap((b) => (b.type === "text" && b.text !== undefined ? [b.text] : [])).join(""),
        stop: r.stop_reason === "refusal" ? "refusal" : r.stop_reason === "max_tokens" ? "max_tokens" : "end",
        usage: readTokenUsage(r.usage),
        reportedMicro: null,
      };
    },
  };
}

const OpenAIReply = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullish(), refusal: z.string().nullish() }), finish_reason: z.string().nullish() }))
    .min(1),
  usage: z.unknown().optional(),
});

const OpenAIUsage = z.object({
  prompt_tokens: tokenCount,
  completion_tokens: tokenCount,
  prompt_tokens_details: z.object({ cached_tokens: tokenCount.nullish() }).nullish(),
});
const OpenAICost = z.object({ cost: z.number().nonnegative() });

function openai(fetch: Fetch, e: Endpoint, timeouts: ProviderTimeouts): ModelClient {
  return {
    async send(req) {
      const user = req.mode === "loose" ? looseUser(req.user, req.schema) : req.user;
      const messages = [
        { role: "system", content: req.system },
        { role: "user", content: user },
        ...(req.repair
          ? [
              { role: "assistant", content: req.repair.previous },
              { role: "user", content: `${REPAIR_INSTRUCTION}\n${req.repair.issues}` },
            ]
          : []),
      ];
      const format =
        req.mode === "strict"
          ? { type: "json_schema", json_schema: { name: req.route.purpose, strict: true, schema: req.schema } }
          : { type: "json_object" };
      const body = JSON.stringify({
        ...e.body,
        model: req.route.model,
        max_tokens: req.route.maxTokens,
        messages,
        response_format: format,
        ...(req.route.effort ? { reasoning_effort: req.route.effort } : {}),
      });
      const res = await post(fetch, `${e.baseUrl}/chat/completions`, { ...authHeaders(e), ...e.headers }, body, timeouts[req.route.purpose]);
      if (res.kind !== "body") return res;
      const parsed = OpenAIReply.safeParse(jsonOf(res.body));
      if (!parsed.success) return UNREADABLE_REPLY;
      const [choice] = parsed.data.choices;
      const u = OpenAIUsage.safeParse(parsed.data.usage).data;
      const cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
      const cost = OpenAICost.safeParse(parsed.data.usage).data?.cost;
      const reported = cost === undefined ? null : Math.ceil(cost * 1_000_000);
      const refused = (choice.message.refusal ?? "") !== "" || choice.finish_reason === "content_filter";
      return {
        kind: "reply",
        text: choice.message.content ?? "",
        stop: refused ? "refusal" : choice.finish_reason === "length" ? "max_tokens" : "end",
        usage: u && cached <= u.prompt_tokens
          ? { inputTokens: u.prompt_tokens - cached, outputTokens: u.completion_tokens, cacheWriteTokens: 0, cacheReadTokens: cached }
          : null,
        reportedMicro: reported !== null && Number.isSafeInteger(reported) ? reported as MicroUsd : null,
      };
    },
  };
}

const BridgeReply = z.object({
  structured: z.unknown(),
  usage: z.unknown().optional(),
  stop: z.enum(["end", "refusal", "max_tokens"]),
});

/** The body the dev bridge and a box's /parse take. */
export function bridgeBody(req: { readonly model: string; readonly system: string; readonly user: string; readonly jsonSchema: JsonSchema }): string {
  return JSON.stringify({ model: req.model, system: req.system, user: req.user, jsonSchema: req.jsonSchema });
}

/** A bridge or box reply, read as a model reply; null when it isn't one. */
export function readBridgeReply(raw: unknown): Extract<WireResult, { kind: "reply" }> | null {
  const reply = BridgeReply.safeParse(raw);
  if (!reply.success) return null;
  return {
    kind: "reply",
    text: reply.data.structured === undefined ? "" : JSON.stringify(reply.data.structured),
    stop: reply.data.stop,
    usage: readTokenUsage(reply.data.usage),
    reportedMicro: null,
  };
}

function bridge(fetch: Fetch, e: Endpoint, timeouts: ProviderTimeouts): ModelClient {
  return {
    async send(req) {
      const body = bridgeBody({ model: req.route.model, system: req.system, user: req.user, jsonSchema: req.schema });
      const res = await post(fetch, `${e.baseUrl}/parse`, {}, body, timeouts[req.route.purpose]);
      if (res.kind === "provider_fault") return res;
      if (res.kind !== "body") return { kind: "unreachable" };
      return readBridgeReply(jsonOf(res.body)) ?? UNREADABLE_REPLY;
    },
  };
}

/** Anthropic Messages (native or any compatible base URL), OpenAI chat completions, or the dev bridge. */
export function connect(fetch: Fetch, timeouts: ProviderTimeouts = PROVIDER_TIMEOUT_MS): Connect {
  return (e) => {
    switch (e.protocol) {
      case "anthropic":
        return anthropic(fetch, e, timeouts);
      case "openai":
        return openai(fetch, e, timeouts);
      case "bridge":
        return bridge(fetch, e, timeouts);
    }
  };
}

const LIMITS = ["maxLength", "maxItems", "minItems"] as const;
const LIMIT_TEXT: Readonly<Record<(typeof LIMITS)[number], (n: number) => string>> = {
  maxLength: (n) => `At most ${n} characters.`,
  maxItems: (n) => `At most ${n} items.`,
  minItems: (n) => `At least ${n} items.`,
};

function nullable(s: Record<string, unknown>): Record<string, unknown> {
  const t = s.type;
  if (t === "null" || (Array.isArray(t) && t.includes("null"))) return s;
  if (Array.isArray(s.anyOf) && s.anyOf.some((b: { type?: unknown }) => b.type === "null")) return s;
  if (typeof t === "string") return { ...s, type: [t, "null"] };
  if (Array.isArray(t)) return { ...s, type: [...t, "null"] };
  return { anyOf: [s, { type: "null" }] };
}

function normalize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalize);
  if (node === null || typeof node !== "object") return node;
  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const notes: string[] = [];
  for (const [k, v] of Object.entries(src)) {
    if (k === "$schema" || k === "minLength") continue;
    if ((LIMITS as readonly string[]).includes(k)) {
      if (typeof v === "number" && !(k === "minItems" && v === 0)) notes.push(LIMIT_TEXT[k as (typeof LIMITS)[number]](v));
      continue;
    }
    if (k === "oneOf") out.anyOf = normalize(v);
    else if (k === "const") out.enum = [v];
    else out[k] = normalize(v);
  }
  if (notes.length > 0) {
    const said = typeof out.description === "string" ? out.description : "";
    const missing = notes.filter((n) => !said.includes(n));
    if (missing.length > 0) out.description = [said, ...missing].filter((x) => x !== "").join(" ");
  }
  if (out.type === "object" && out.properties && typeof out.properties === "object") {
    const props = out.properties as Record<string, Record<string, unknown>>;
    const required = new Set(Array.isArray(src.required) ? (src.required as string[]) : []);
    out.properties = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, required.has(k) ? v : nullable(v)]));
    out.required = Object.keys(props);
    out.additionalProperties = false;
  }
  return out;
}

const SCHEMAS = new WeakMap<z.ZodType, JsonSchema>();

/**
 * Plain JSON Schema from zod, normalized once per schema for every provider's strict mode: no additional
 * properties, every property required (an optional one becomes nullable), and length and count limits moved
 * into descriptions. The box and the bridge get the same object.
 */
export function jsonSchemaOf(schema: z.ZodType): JsonSchema {
  const cached = SCHEMAS.get(schema);
  if (cached) return cached;
  const made = normalize(z.toJSONSchema(schema)) as JsonSchema;
  SCHEMAS.set(schema, made);
  return made;
}

export type KeyFault =
  /** 401, 403: revoked or mistyped. */
  | "credential"
  /** 402, or a billing error body: out of credit. */
  | "payment"
  /** 404: the model or path is gone. */
  | "model"
  /** A 429 with no Retry-After, or one longer than a minute: a usage window. */
  | "rate"
  /** Our side: no secret we hold opens it. */
  | "unreadable";

/** What one attempt meant. The single table from HTTP to meaning, shared by every protocol. */
export type Attempt<T> =
  | { readonly kind: "ok"; readonly value: T; readonly usage: Usage | null; readonly reported: MicroUsd | null }
  | { readonly kind: "invalid"; readonly text: string; readonly issues: string; readonly usage: Usage | null; readonly reported: MicroUsd | null }
  | { readonly kind: "refused_by_model"; readonly usage: Usage | null; readonly reported: MicroUsd | null }
  /** 429 with a short Retry-After, or 529: it did not run. */
  | { readonly kind: "turned_away" }
  /** The provider refused this key or model; it did not run. */
  | { readonly kind: "fault"; readonly fault: Exclude<KeyFault, "unreadable">; readonly retryAfterMs: number | null }
  /** Another 4xx: it did not run. */
  | { readonly kind: "rejected" }
  /** Network, 408 or 5xx: it may have run and billed. */
  | { readonly kind: "in_doubt" };

const SHORT_RETRY_MS = 60_000;

export function classify(r: Exclude<WireResult, { kind: "reply" }>): Attempt<never> {
  if (r.kind === "network") return { kind: "in_doubt" };
  if (r.kind === "unreachable") return { kind: "turned_away" };
  if (r.kind === "provider_fault") {
    // An oversized reply may already have incurred a charge.
    return r.reason === "redirect" ? { kind: "fault", fault: "model", retryAfterMs: null } : { kind: "in_doubt" };
  }
  const { status } = r;
  if (status === 529) return { kind: "turned_away" };
  if (status === 429) {
    return r.retryAfterMs !== null && r.retryAfterMs <= SHORT_RETRY_MS ? { kind: "turned_away" } : { kind: "fault", fault: "rate", retryAfterMs: r.retryAfterMs };
  }
  if (status === 402 || (r.billing && status >= 400 && status < 500 && status !== 408)) return { kind: "fault", fault: "payment", retryAfterMs: null };
  if (status === 401 || status === 403) return { kind: "fault", fault: "credential", retryAfterMs: null };
  if (status === 404) return { kind: "fault", fault: "model", retryAfterMs: null };
  if (status === 408 || status >= 500) return { kind: "in_doubt" };
  return { kind: "rejected" };
}

export function readAttempt<T>(r: WireResult, schema: z.ZodType<T>): Attempt<T> {
  if (r.kind !== "reply") return classify(r);
  const { usage, reportedMicro: reported } = r;
  if (r.stop === "refusal") return { kind: "refused_by_model", usage, reported };
  if (r.stop === "max_tokens") return { kind: "invalid", text: r.text, issues: "The reply was cut off at the output limit.", usage, reported };
  let raw: unknown;
  try {
    raw = JSON.parse(r.text);
  } catch {
    return { kind: "invalid", text: r.text, issues: "The reply was not valid JSON.", usage, reported };
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { kind: "ok", value: parsed.data, usage, reported };
  return { kind: "invalid", text: r.text, issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("\n"), usage, reported };
}

export type Reserved = { readonly id: string; readonly estimate: MicroUsd };

/** Asked before each attempt and told after it, so every billed attempt passes through its own reservation. */
export interface Meter {
  /** Null: over the cap, so the attempt is not sent. */
  reserve(route: Route, promptBytes: number): Reserved | null;
  settle(r: Reserved, route: Route, outcome: Attempt<unknown>): void;
}

export type ParseRequest<T> = {
  readonly route: Route;
  readonly mode: SchemaMode;
  readonly system: string;
  readonly user: string;
  readonly schema: z.ZodType<T>;
};

/** `fenced`: `live` turned false, so the next attempt was never sent. */
export type Parsed<T> = { readonly last: Attempt<T> | null; readonly overCap: boolean; readonly attempts: number; readonly fenced?: true };

const utf8 = new TextEncoder();

/**
 * Strict: one attempt. Loose: one attempt, then one repair when the JSON or its shape is wrong. `live` is asked right
 * before each attempt is reserved and sent, with no await between, so a forget that began meanwhile stops it.
 */
export async function runParse<T>(client: ModelClient, req: ParseRequest<T>, meter: Meter, live: () => boolean = () => true): Promise<Parsed<T>> {
  const schema = jsonSchemaOf(req.schema);
  let repair: WireRequest["repair"] = null;
  let last: Attempt<T> | null = null;
  const tries = req.mode === "loose" ? 2 : 1;
  let sent = 0;
  for (let i = 0; i < tries; i++) {
    const user = req.mode === "loose" ? looseUser(req.user, schema) : req.user;
    const extra = repair ? repair.previous + repair.issues + REPAIR_INSTRUCTION : "";
    const bytes = utf8.encode(req.system + user + extra).length;
    if (repair && bytes > req.route.promptBytes) break;
    if (!live()) return { last, overCap: false, attempts: sent, fenced: true };
    const reserved = meter.reserve(req.route, bytes);
    if (!reserved) return { last, overCap: true, attempts: sent };
    sent++;
    let wire: WireResult;
    try {
      wire = await client.send({ route: req.route, mode: req.mode, system: req.system, user: req.user, schema, repair });
    } catch (err) {
      meter.settle(reserved, req.route, { kind: "in_doubt" });
      throw err;
    }
    last = readAttempt(wire, req.schema);
    meter.settle(reserved, req.route, last);
    if (last.kind !== "invalid") break;
    repair = { previous: last.text, issues: last.issues };
  }
  return { last, overCap: false, attempts: sent };
}
