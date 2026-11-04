import { z } from "zod";
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
  | { readonly kind: "network" };

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

export const looseUser = (user: string, schema: JsonSchema): string => `${user}\n\n${LOOSE_INSTRUCTION}\n${JSON.stringify(schema)}`;

function retryAfterMs(h: string | null): number | null {
  if (h === null) return null;
  const s = Number(h);
  if (Number.isFinite(s) && s >= 0) return Math.min(s * 1000, MAX_RETRY_AFTER_MS);
  const at = Date.parse(h);
  return Number.isNaN(at) ? null : Math.min(Math.max(0, at - Date.now()), MAX_RETRY_AFTER_MS);
}

type Answer = { readonly status: number; readonly ok: boolean; readonly retryAfter: string | null; readonly body: string };

function failed(res: Answer): WireResult {
  return { kind: "status", status: res.status, retryAfterMs: retryAfterMs(res.retryAfter), billing: res.status === 402 || BILLING_ERROR.test(res.body) };
}

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

/** Null when the request or its body fails or outlasts `timeoutMs`: the provider may have run it. */
async function post(fetch: Fetch, url: string, headers: Record<string, string>, body: string, timeoutMs: number): Promise<Answer | null> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body, signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status, ok: res.ok, retryAfter: res.headers.get("retry-after"), body: await res.text() };
  } catch {
    return null;
  }
}

const UNREADABLE_REPLY: WireResult = { kind: "reply", text: "", stop: "end", usage: null, reportedMicro: null };

const AnthropicReply = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  stop_reason: z.string().nullable(),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    cache_creation_input_tokens: z.number().nullish(),
    cache_read_input_tokens: z.number().nullish(),
  }),
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
      if (res === null) return { kind: "network" };
      if (!res.ok) return failed(res);
      const parsed = AnthropicReply.safeParse(jsonOf(res.body));
      if (!parsed.success) return UNREADABLE_REPLY;
      const r = parsed.data;
      return {
        kind: "reply",
        text: r.content.flatMap((b) => (b.type === "text" && b.text !== undefined ? [b.text] : [])).join(""),
        stop: r.stop_reason === "refusal" ? "refusal" : r.stop_reason === "max_tokens" ? "max_tokens" : "end",
        usage: {
          inputTokens: r.usage.input_tokens,
          outputTokens: r.usage.output_tokens,
          cacheWriteTokens: r.usage.cache_creation_input_tokens ?? 0,
          cacheReadTokens: r.usage.cache_read_input_tokens ?? 0,
        },
        reportedMicro: null,
      };
    },
  };
}

const OpenAIReply = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullish(), refusal: z.string().nullish() }), finish_reason: z.string().nullish() }))
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number(),
      completion_tokens: z.number(),
      prompt_tokens_details: z.object({ cached_tokens: z.number().nullish() }).nullish(),
      cost: z.number().nullish(),
    })
    .nullish(),
});

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
      if (res === null) return { kind: "network" };
      if (!res.ok) return failed(res);
      const parsed = OpenAIReply.safeParse(jsonOf(res.body));
      if (!parsed.success) return UNREADABLE_REPLY;
      const [choice] = parsed.data.choices;
      const u = parsed.data.usage;
      const cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
      const refused = (choice.message.refusal ?? "") !== "" || choice.finish_reason === "content_filter";
      return {
        kind: "reply",
        text: choice.message.content ?? "",
        stop: refused ? "refusal" : choice.finish_reason === "length" ? "max_tokens" : "end",
        usage: u ? { inputTokens: u.prompt_tokens - cached, outputTokens: u.completion_tokens, cacheWriteTokens: 0, cacheReadTokens: cached } : null,
        reportedMicro: typeof u?.cost === "number" ? (Math.ceil(u.cost * 1_000_000) as MicroUsd) : null,
      };
    },
  };
}

const BridgeReply = z.object({
  structured: z.unknown(),
  usage: z
    .object({
      input_tokens: z.number(),
      output_tokens: z.number(),
      cache_creation_input_tokens: z.number().nullish(),
      cache_read_input_tokens: z.number().nullish(),
    })
    .nullable(),
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
  const u = reply.data.usage;
  return {
    kind: "reply",
    text: reply.data.structured === undefined ? "" : JSON.stringify(reply.data.structured),
    stop: reply.data.stop,
    usage: u
      ? { inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheWriteTokens: u.cache_creation_input_tokens ?? 0, cacheReadTokens: u.cache_read_input_tokens ?? 0 }
      : null,
    reportedMicro: null,
  };
}

const BRIDGE_DOWN: WireResult = { kind: "status", status: 529, retryAfterMs: null, billing: false };

function bridge(fetch: Fetch, e: Endpoint, timeouts: ProviderTimeouts): ModelClient {
  return {
    async send(req) {
      const body = bridgeBody({ model: req.route.model, system: req.system, user: req.user, jsonSchema: req.schema });
      const res = await post(fetch, `${e.baseUrl}/parse`, {}, body, timeouts[req.route.purpose]);
      if (res === null || !res.ok) return BRIDGE_DOWN;
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

export function classify(r: Extract<WireResult, { kind: "status" | "network" }>): Attempt<never> {
  if (r.kind === "network") return { kind: "in_doubt" };
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

export type Parsed<T> = { readonly last: Attempt<T> | null; readonly overCap: boolean; readonly attempts: number };

const utf8 = new TextEncoder();

/** Strict: one attempt. Loose: one attempt, then one repair when the JSON or its shape is wrong. */
export async function runParse<T>(client: ModelClient, req: ParseRequest<T>, meter: Meter): Promise<Parsed<T>> {
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
