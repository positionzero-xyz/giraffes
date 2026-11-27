import { diagnostic } from "../diagnostics";
import { z } from "zod";
import { planAllowsBox, type Plan } from "../billing/plan";
import type { BoxAgentRequest, SessionUsed } from "../box/client";
import type { BoxState } from "../box/machine";
import { AGENT_TOOLS, BoxTurnOutputSchema, oneOffBoxTurn, turnFromAgent, type BoxTurnPrompt } from "../agent/turn";
import { assertNever, eventKey, mayspend, type AgentKey, type EpochMs, type MicroUsd, type TimeZone } from "../domain";
import { modelCallRow, type Backend, type ModelCallStatus } from "../ledger/ledger";
import { NOTICES, type KeyPageError } from "../notices";
import { OUTPUTS, outputOf, type Output } from "../agent/purposes";
import type { Claim } from "../agent/forget";
import type { AgentStore, Reservation } from "../agent/store";
import {
  jsonSchemaOf,
  looseUser,
  readAttempt,
  runParse,
  type Attempt,
  type Connect,
  type Endpoint,
  type JsonSchema,
  type KeyFault,
  type Meter,
  type Parsed,
  type SchemaMode,
  type WireResult,
} from "../model/client";
import { bytesOf, fitSections, renderPrompt, type PromptParts } from "../model/prompt";
import { PROVIDERS, type ModelRef } from "../model/providers";
import { routeFor, type CallPurpose, type Purpose, type Route, type Source } from "../model/routes";
import { costOf, estimate, fits, type SpendScope } from "../policy/spend";
import { DEFAULT_TIME_ZONE, fromLocal, localDate, toLocal, utcMonth } from "../policy/time";
import { endpointOf, open, secretsFingerprint, sessionOf, type KeyDraft, type KeySecrets, type StoredKey } from "./key";

export type KeysConfig =
  | { readonly on: false; readonly defaultCapMicro: MicroUsd }
  | { readonly on: true; readonly secrets: KeySecrets; readonly publicUrl: string; readonly defaultCapMicro: MicroUsd };

export type IncludedOn = {
  readonly on: true;
  readonly endpoint: Endpoint;
  readonly source: Extract<Source, { kind: "included" | "dev" }>;
  readonly mode: SchemaMode;
  readonly capMicro: MicroUsd;
  /** "plan": people on the included plan. "everyone": the dev bridge or a scripted dev run, behind DEV_MODE. */
  readonly who: "plan" | "everyone";
};
export type IncludedConfig = { readonly on: false } | IncludedOn;

export const DEV_CAP_MICRO = 15_000_000 as MicroUsd;
export const DEV_URL_SCRIPTED = "scripted:";

/** The dev lane: everyone's calls go to the bridge at `baseUrl`, or to a script, metered like our included tier. Behind DEV_MODE only. */
export function devLane(baseUrl: string): IncludedOn {
  return {
    on: true,
    endpoint: { provider: "bridge", protocol: "bridge", baseUrl, auth: "none", key: null, headers: {}, body: {} },
    source: { kind: "dev", model: "claude-haiku-5-5" },
    mode: "strict",
    capMicro: DEV_CAP_MICRO,
    who: "everyone",
  };
}

/** One way a person's model calls can be served, in the order they are tried. */
export type Lane = { readonly kind: "box" } | { readonly kind: "key"; readonly key: StoredKey } | { readonly kind: "included"; readonly included: IncludedOn };

export type AccessFacts = {
  readonly admitted: boolean;
  readonly plan: Plan;
  readonly box: BoxState | null;
  /** The person has their Claude plan's box in any state, or had one and never removed it. */
  readonly claudePlan: boolean;
  readonly key: StoredKey | null;
  readonly included: IncludedConfig;
};

/** `whenEmpty` says why there is no lane: nothing is connected, or the person's own plan is connected but its box isn't signed in. */
export type Access = { readonly lanes: readonly Lane[]; readonly whenEmpty: "nothing" | "box_not_ready" };

/**
 * Pure. Access is computed from facts that already have owners (the box row, the key row, the plan), never stored.
 * The person's own plan comes first. While they have or had their plan's box, in any state, their key backs it up
 * only if they said yes, so their metered money is never a silent fallback. Our included tier serves only someone
 * with no access of their own.
 */
export function accessOf(f: AccessFacts): Access {
  if (!f.admitted || f.plan.kind === "lapsed") return { lanes: [], whenEmpty: "nothing" };
  const boxAllowed = f.box !== null && planAllowsBox(f.plan.kind);
  const planConnected = boxAllowed && (f.box === "signed_in" || f.box === "signed_out");
  const lanes: Lane[] = [];
  if (boxAllowed && f.box === "signed_in") lanes.push({ kind: "box" });
  if (f.key && (!f.claudePlan || f.key.backup)) lanes.push({ kind: "key", key: f.key });
  const own = planConnected || f.key !== null;
  if (!own && f.included.on && (f.included.who === "everyone" || f.plan.kind === "included")) lanes.push({ kind: "included", included: f.included });
  return { lanes, whenEmpty: f.claudePlan ? "box_not_ready" : "nothing" };
}

export type CallRecord = {
  readonly lane: Lane["kind"];
  readonly model: ModelRef;
  readonly costMicro: MicroUsd;
  readonly box?: { readonly session: string | null; readonly sentThrough: number };
};

export type OverCap = SpendScope | "included_ceiling";

/** `trimmed`: lines of the conversation not yet in the summary were left out to fit the route. */
export type Served<P extends Purpose> =
  | { readonly kind: "ok"; readonly value: Output<P>; readonly call: CallRecord; readonly trimmed: boolean }
  /** Invalid output or a refusal, after the one repair in loose mode. */
  | { readonly kind: "failed"; readonly call: CallRecord; readonly trimmed: boolean }
  /** What the prompt keeps whole, the newest message with it, doesn't fit the route; nothing was sent. */
  | { readonly kind: "too_long" }
  /** Some lane is down for now; retry the batch later. */
  | { readonly kind: "unavailable" }
  | { readonly kind: "over_cap"; readonly scope: OverCap }
  /**
   * Nothing is connected, the plan's box isn't signed in, or every lane rests on a fault. `told`: this call already sent
   * the person a notice. `notice`: a resting key's problem, which the reply names.
   */
  | { readonly kind: "no_access"; readonly why: Access["whenEmpty"]; readonly told: boolean; readonly notice: string | null; readonly waitForConnection: boolean }
  /** A forget began after the work that asked; no request was started for it from then on, and it must save nothing. */
  | Fenced;

type Fenced = { readonly kind: "fenced" };
const FENCED: Fenced = { kind: "fenced" };

export type BoxAnswer =
  | { readonly kind: "reply"; readonly reply: Extract<WireResult, { kind: "reply" }>; readonly session?: SessionUsed }
  | { readonly kind: "moved_on"; readonly transient: boolean; readonly told: boolean }
  | Fenced;

export interface BoxLane {
  state(): BoxState | null;
  parse(req: { readonly purpose: CallPurpose; readonly model: string; readonly system: string; readonly user: string; readonly jsonSchema: JsonSchema }, claim: Claim): Promise<BoxAnswer>;
  agent(req: BoxAgentRequest, claim: Claim): Promise<BoxAnswer>;
}

export type Clock = { now(): EpochMs };

export type AccessDeps = {
  readonly store: AgentStore;
  readonly connect: Connect;
  readonly box: BoxLane;
  readonly keys: KeysConfig;
  readonly included: IncludedConfig;
  readonly clock: Clock;
  /** Random per DO instance; marks this instance's reservations so recovery leaves them alone. */
  readonly instance: string;
};

export type CallRequest<P extends Purpose> = {
  readonly purpose: P;
  readonly system: string;
  readonly prompt: PromptParts;
  readonly plan: Plan;
  readonly box?: BoxTurnPrompt;
  /** Checked before each lane and before each request a lane sends. */
  readonly claim: Claim;
};

type Next = {
  readonly kind: "next";
  readonly transient?: boolean;
  readonly overCap?: OverCap;
  readonly told?: boolean;
  readonly notice?: string;
  readonly tooLong?: boolean;
};
type LaneResult<P extends Purpose> = { readonly kind: "served"; readonly served: Served<P> } | Next | Fenced;

export type ProbeResult = { readonly ok: true; readonly mode: SchemaMode } | { readonly ok: false; readonly error: Extract<KeyPageError, ProbeError> };
type ProbeError = "bad_key" | "no_credit" | "bad_model" | "rate_limited" | "unreachable" | "no_json" | "over_cap";

const ProbeOutput = z.object({ ok: z.boolean() });
const PROBE_SYSTEM = "You check that an API key works. Reply with JSON only.";
const PROBE_USER = 'Reply with {"ok": true}.';

function probeError(a: Attempt<unknown> | null): ProbeError {
  if (a === null) return "over_cap";
  switch (a.kind) {
    case "fault":
      return a.fault === "credential" ? "bad_key" : a.fault === "payment" ? "no_credit" : a.fault === "model" ? "bad_model" : "rate_limited";
    case "turned_away":
      return "rate_limited";
    case "in_doubt":
      return "unreachable";
    case "ok":
    case "invalid":
    case "refused_by_model":
    case "rejected":
      return "no_json";
    default:
      return assertNever(a);
  }
}

/** What a route takes for the user prompt: its budget less the system prompt and, in loose mode, the inlined schema. */
function userBudget(route: Route, mode: SchemaMode, purpose: Purpose, system: string): number {
  const schemaBytes = mode === "loose" ? bytesOf(looseUser("", jsonSchemaOf(OUTPUTS[purpose]))) : 0;
  return route.promptBytes - bytesOf(system) - schemaBytes;
}

const HOUR_MS = 60 * 60_000;
const MIN_MS = 60_000;

/** The first whole local minute at or after `until` that no earlier moment shares, so no reading of it comes before the deadline. */
function retryShownAt(until: EpochMs, tz: TimeZone): string {
  let at = (Math.ceil(until / MIN_MS) * MIN_MS) as EpochMs;
  while (fromLocal(toLocal(at, tz), tz) < at) at = (at + MIN_MS) as EpochMs;
  return toLocal(at, tz).replace("T", " ");
}

/** How long a fault rests the key. An unreadable key rests until it is replaced or the configured secrets change. */
type Rest = { readonly kind: "until_replaced" } | { readonly kind: "for"; readonly ms: number };

function restFor(fault: KeyFault, failures: number, retryAfterMs: number | null): Rest {
  const doubling = (base: number, max: number): Rest => ({ kind: "for", ms: Math.min(base * 2 ** Math.min(failures, 10), max) });
  switch (fault) {
    case "credential":
    case "payment":
      return doubling(HOUR_MS, 24 * HOUR_MS);
    case "model":
      return { kind: "for", ms: 24 * HOUR_MS };
    case "rate":
      return retryAfterMs === null ? doubling(15 * MIN_MS, 6 * HOUR_MS) : { kind: "for", ms: retryAfterMs };
    case "unreadable":
      return { kind: "until_replaced" };
    default:
      return assertNever(fault);
  }
}

const STATUS: Readonly<Record<Attempt<unknown>["kind"], ModelCallStatus>> = {
  ok: "settled",
  invalid: "settled",
  refused_by_model: "settled",
  turned_away: "unavailable",
  fault: "provider_refused",
  rejected: "rejected",
  in_doubt: "in_doubt",
};

/**
 * One person's model access. `call` resolves their lanes and tries them in order. Per lane it fits the prompt to the
 * route, reserves, sends, and settles and logs each attempt in its own transaction. A provider fault rests the key,
 * tells the person once, and moves on. It never touches another DO's state.
 */
export class ModelAccess {
  constructor(private readonly deps: AccessDeps) {}

  async call<P extends Purpose>(req: CallRequest<P>): Promise<Served<P>> {
    const access = this.#access(req.plan);
    let transient = false;
    let overCap: OverCap | null = null;
    let told = false;
    let tooLong = false;
    let notice: string | null = null;
    for (const lane of access.lanes) {
      if (!req.claim.live()) return FENCED;
      const r = await this.#lane(lane, req);
      if (r.kind === "served") return r.served;
      if (r.kind === "fenced") return r;
      transient ||= r.transient ?? false;
      told ||= r.told ?? false;
      tooLong ||= r.tooLong ?? false;
      notice ??= r.notice ?? null;
      overCap ??= r.overCap ?? null;
    }
    if (transient) return { kind: "unavailable" };
    if (tooLong) return { kind: "too_long" };
    if (overCap) return { kind: "over_cap", scope: overCap };
    const boxWaiting = access.whenEmpty === "box_not_ready" || (access.lanes.length > 0 && access.lanes.every((l) => l.kind === "box"));
    const waitForConnection = access.lanes.length === 0 || (boxWaiting && this.deps.box.state() === "signed_out");
    return { kind: "no_access", why: boxWaiting ? "box_not_ready" : "nothing", told, notice, waitForConnection };
  }

  catchUpBudget(plan: Plan, now: EpochMs): string | null {
    const { lanes } = this.#access(plan);
    if (lanes.some((lane) => lane.kind === "box")) return "box";
    const key = lanes.find((lane) => lane.kind === "key");
    if (!key || !this.deps.keys.on || key.key.health.kind !== "ok") return null;
    return `key:${utcMonth(now)}:${key.key.revision}:${key.key.capMicro}`;
  }

  /** True when the first lane can take this turn's whole user prompt without trimming history. */
  turnFitsWhole(req: { readonly system: string; readonly prompt: PromptParts; readonly box: BoxTurnPrompt; readonly plan: Plan }): boolean {
    const [lane] = this.#access(req.plan).lanes;
    if (!lane) return true;
    const { route, mode } = this.#routeOf(lane, "turn");
    if (lane.kind === "box") {
      const budget = userBudget(route, mode, "turn", req.box.append);
      const prompt = req.box.session === null ? req.box.fresh : req.box.turn;
      return bytesOf(renderPrompt(prompt)) <= budget;
    }
    return bytesOf(renderPrompt(req.prompt)) <= userBudget(route, mode, "turn", req.system);
  }

  /**
   * Checks whether a key works and which schema mode its endpoint honours: strict first, then loose
   * when the provider leaves that to the probe. It reserves and is charged to the person's own spend like any call.
   */
  async probe(draft: KeyDraft, capMicro: MicroUsd): Promise<ProbeResult> {
    const route = routeFor({ kind: "key", provider: draft.provider, model: draft.model }, "probe");
    const client = this.deps.connect(endpointOf(draft, draft.key, await sessionOf(this.#agent())));
    const policy = PROVIDERS[draft.provider].schema;
    const modes: readonly SchemaMode[] = policy === "strict" ? ["strict"] : policy === "loose" ? ["loose"] : ["strict", "loose"];
    let last: Attempt<unknown> | null = null;
    for (const mode of modes) {
      const out = await runParse(client, { route, mode, system: PROBE_SYSTEM, user: PROBE_USER, schema: ProbeOutput }, this.#meter("byok", capMicro, "key"));
      if (out.overCap && out.last === null) return { ok: false, error: "over_cap" };
      last = out.last;
      if (last?.kind === "ok") return { ok: true, mode };
      if (last?.kind !== "rejected" && last?.kind !== "invalid") break;
    }
    return { ok: false, error: probeError(last) };
  }

  #lane<P extends Purpose>(lane: Lane, req: CallRequest<P>): Promise<LaneResult<P>> {
    switch (lane.kind) {
      case "box":
        return this.#box(req);
      case "key":
        return this.#key(lane.key, req);
      case "included":
        return this.#included(lane.included, req);
      default:
        return assertNever(lane);
    }
  }

  /**
   * The user-prompt bytes every lane that would serve this person can take for `purpose`, so a caller can tell whether
   * a prompt fits before it calls; null when the person has no lane.
   */
  budget(purpose: Purpose, system: string, plan: Plan): number | null {
    const budgets = this.#access(plan).lanes.map((lane) => {
      const { route, mode } = this.#routeOf(lane, purpose);
      return userBudget(route, mode, purpose, system);
    });
    return budgets.length === 0 ? null : Math.min(...budgets);
  }

  #access(plan: Plan): Access {
    const { store } = this.deps;
    return accessOf({ admitted: mayspend(store.admission()), plan, box: this.deps.box.state(), claudePlan: store.claudePlan(), key: store.key(), included: this.deps.included });
  }

  #routeOf(lane: Lane, purpose: Purpose): { readonly route: Route; readonly mode: SchemaMode } {
    switch (lane.kind) {
      case "box":
        return { route: routeFor({ kind: "box", provider: "claude" }, purpose), mode: "strict" };
      case "key":
        return { route: routeFor({ kind: "key", provider: lane.key.provider, model: lane.key.model }, purpose), mode: lane.key.mode };
      case "included":
        return { route: routeFor(lane.included.source, purpose), mode: lane.included.mode };
      default:
        return assertNever(lane);
    }
  }

  /** Null: even with every trimmable line dropped, the prompt doesn't fit the route. */
  #fit(route: Route, mode: SchemaMode, req: CallRequest<Purpose>): { readonly user: string; readonly historyCut: number } | null {
    const budget = userBudget(route, mode, req.purpose, req.system);
    const fitted = fitSections(req.prompt, budget);
    return bytesOf(fitted.text) <= budget ? { user: fitted.text, historyCut: fitted.historyCut } : null;
  }

  #agent(): AgentKey {
    const a = this.deps.store.agent();
    if (!a) throw new Error("a model call for a DO with no agent row");
    return a.key;
  }

  #log(route: Route, backend: Backend, status: ModelCallStatus, est: MicroUsd, cost: MicroUsd, attempt: Attempt<unknown> | null): void {
    const now = this.deps.clock.now();
    const u = attempt && "usage" in attempt ? attempt.usage : null;
    this.deps.store.appendLogs(
      [modelCallRow({ id: crypto.randomUUID(), agent: this.#agent(), purpose: route.purpose, backend, status, estimate: est, cost, usage: u, at: now })],
      now,
    );
  }

  /** A turn as the person's own Claude Code session; its tool calls and reply become a turn output for the usual checks. */
  async #boxAgent(req: CallRequest<"turn">): Promise<LaneResult<"turn">> {
    const box = req.box ?? oneOffBoxTurn(req.prompt);
    const ephemeral = req.box === undefined;
    const { append, session } = box;
    const route = routeFor({ kind: "box", provider: "claude" }, "turn");
    const turn = this.#fit(route, "strict", { ...req, system: append, prompt: box.turn });
    const fresh = this.#fit(route, "strict", { ...req, system: append, prompt: box.fresh });
    if (turn === null || fresh === null) return { kind: "next", tooLong: true };
    const answer = await this.deps.box.agent({ model: route.model, append, session, turn: turn.user, fresh: fresh.user, tools: AGENT_TOOLS, ...(ephemeral ? { ephemeral: true } : {}) }, req.claim);
    if (answer.kind === "fenced") return answer;
    if (answer.kind === "moved_on") return { kind: "next", transient: answer.transient, told: answer.told };
    const output = turnFromAgent(jsonOrNull(answer.reply.text));
    const attempt = readAttempt(output === null ? answer.reply : { ...answer.reply, text: JSON.stringify(output) }, BoxTurnOutputSchema);
    this.#log(route, "box", "settled", 0 as MicroUsd, 0 as MicroUsd, attempt);
    const startedFresh = answer.session?.resumed === false;
    const prompt = startedFresh ? box.fresh : box.turn;
    const historyCut = (startedFresh ? fresh : turn).historyCut;
    const firstOmitted = historyCut > 0 ? prompt.historySeqs?.at(-historyCut) : undefined;
    const sentThrough = firstOmitted === undefined ? prompt.sentThrough : firstOmitted - 1;
    const call: CallRecord = { lane: "box", model: route.ref, costMicro: 0 as MicroUsd, box: { session: answer.session?.id ?? null, sentThrough } };
    const trimmed = historyCut > 0;
    return { kind: "served", served: attempt.kind === "ok" ? { kind: "ok", value: attempt.value, call, trimmed } : { kind: "failed", call, trimmed } };
  }

  async #box<P extends Purpose>(req: CallRequest<P>): Promise<LaneResult<P>> {
    if (isTurn(req)) return this.#boxAgent(req) as Promise<LaneResult<P>>;
    const route = routeFor({ kind: "box", provider: "claude" }, req.purpose);
    const fitted = this.#fit(route, "strict", req);
    if (fitted === null) return { kind: "next", tooLong: true };
    const answer = await this.deps.box.parse({ purpose: req.purpose, model: route.model, system: req.system, user: fitted.user, jsonSchema: jsonSchemaOf(OUTPUTS[req.purpose]) }, req.claim);
    if (answer.kind === "fenced") return answer;
    if (answer.kind === "moved_on") return { kind: "next", transient: answer.transient, told: answer.told };
    const attempt = readAttempt(answer.reply, outputOf(req.purpose));
    this.#log(route, "box", "settled", 0 as MicroUsd, 0 as MicroUsd, attempt);
    const call: CallRecord = { lane: "box", model: route.ref, costMicro: 0 as MicroUsd };
    const trimmed = fitted.historyCut > 0;
    return { kind: "served", served: attempt.kind === "ok" ? { kind: "ok", value: attempt.value, call, trimmed } : { kind: "failed", call, trimmed } };
  }

  async #key<P extends Purpose>(k: StoredKey, req: CallRequest<P>): Promise<LaneResult<P>> {
    const { store, clock, keys } = this.deps;
    const now = clock.now();
    const secrets = await secretsFingerprint(keys.on ? keys.secrets : null);
    const h = k.health;
    if (h.kind === "resting" && (h.until === null || h.until > now) && !(h.fault === "unreadable" && h.under !== secrets)) {
      return { kind: "next", notice: this.#faultText(k, h.fault, h.until), transient: h.fault === "rate" };
    }
    const agent = this.#agent();
    const opened = keys.on ? await open(keys.secrets, agent, k) : ({ kind: "unreadable" } as const);
    if (opened.kind === "unreadable") return this.#rested(k, "unreadable", null, false, req.claim, secrets);
    if (opened.kind === "resealed" && !store.reseal(opened.again, k.revision)) return { kind: "next", transient: true };
    const route = routeFor({ kind: "key", provider: k.provider, model: k.model }, req.purpose);
    const fitted = this.#fit(route, k.mode, req);
    if (fitted === null) return { kind: "next", tooLong: true };
    const client = this.deps.connect(endpointOf(k, opened.key, await sessionOf(agent)));
    const meter = this.#meter("byok", k.capMicro, "key");
    const out = await runParse(client, { route, mode: k.mode, system: req.system, user: fitted.user, schema: outputOf(req.purpose) }, meter, req.claim.live);
    if (out.fenced) return FENCED;
    const last = out.last;
    if (last?.kind === "fault") return this.#rested(k, last.fault, last.retryAfterMs, last.fault === "rate", req.claim);
    if (last?.kind === "ok" || last?.kind === "invalid" || last?.kind === "refused_by_model") store.keyHealthy(k.revision);
    return this.#outcome(out, route, "key", "byok", meter.spent, fitted.historyCut > 0);
  }

  async #included<P extends Purpose>(inc: IncludedOn, req: CallRequest<P>): Promise<LaneResult<P>> {
    const route = routeFor(inc.source, req.purpose);
    const fitted = this.#fit(route, inc.mode, req);
    if (fitted === null) return { kind: "next", tooLong: true };
    const meter = this.#meter("included", inc.capMicro, "included");
    const out = await runParse(this.deps.connect(inc.endpoint), { route, mode: inc.mode, system: req.system, user: fitted.user, schema: outputOf(req.purpose) }, meter, req.claim.live);
    if (out.fenced) return FENCED;
    const last = out.last;
    if (last?.kind === "fault") {
      diagnostic("included_provider_refused");
      return last.fault === "payment" ? { kind: "next", overCap: "included_ceiling" } : { kind: "next", transient: true };
    }
    return this.#outcome(out, route, "included", "included", meter.spent, fitted.historyCut > 0);
  }

  #outcome<P extends Purpose>(out: Parsed<Output<P>>, route: Route, lane: Lane["kind"], scope: SpendScope, spent: () => MicroUsd, trimmed: boolean): LaneResult<P> {
    const last = out.last;
    const call: CallRecord = { lane, model: route.ref, costMicro: spent() };
    if (last === null) return { kind: "next", overCap: scope };
    switch (last.kind) {
      case "ok":
        return { kind: "served", served: { kind: "ok", value: last.value, call, trimmed } };
      case "invalid":
      case "refused_by_model":
        return { kind: "served", served: { kind: "failed", call, trimmed } };
      case "turned_away":
      case "in_doubt":
      case "rejected":
      case "fault":
        return { kind: "next", transient: true };
      default:
        return assertNever(last);
    }
  }

  /**
   * Rests the key and says what the lane did: nothing when the key was replaced or removed while this call ran (the
   * batch retries on the new key), else the notice went out now, or the reply names the problem. A forget that began
   * during the call still lets the key rest, but no notice is queued for work from before it.
   */
  #rested(k: StoredKey, fault: KeyFault, retryAfterMs: number | null, transient: boolean, claim: Claim, under: string | null = null): Next {
    const { store, clock } = this.deps;
    const now = clock.now();
    const failures = k.health.kind === "resting" ? k.health.failures : 0;
    const rest = restFor(fault, failures, retryAfterMs);
    const until = rest.kind === "for" ? ((now + rest.ms) as EpochMs) : null;
    const text = this.#faultText(k, fault, until);
    const today = localDate(now, store.agent()?.tz ?? DEFAULT_TIME_ZONE);
    const notice = claim.live() ? { key: eventKey.access(`fault:${now}`), message: { texts: [text] as const, note: text } } : null;
    const r = store.restKey(fault, until, notice, today, now, k.revision, under);
    if (r === "stale") return { kind: "next", transient: true };
    return r === "told" ? { kind: "next", told: true, transient } : { kind: "next", notice: text, transient };
  }

  #faultText(k: StoredKey, fault: KeyFault, until: EpochMs | null): string {
    const a = this.deps.store.agent();
    const t = NOTICES[a?.language ?? "en"];
    const label = PROVIDERS[k.provider].label;
    switch (fault) {
      case "credential":
        return t.keyRefused(label);
      case "payment":
        return t.keyNoCredit(label, until === null ? null : retryShownAt(until, a?.tz ?? DEFAULT_TIME_ZONE));
      case "model":
        return t.keyNoModel(label, k.model);
      case "rate":
        return t.keyRateLimited(label, until === null || !a ? "" : retryShownAt(until, a.tz));
      case "unreadable":
        return t.keyUnreadable;
      default:
        return assertNever(fault);
    }
  }

  #meter(scope: SpendScope, cap: MicroUsd, backend: "key" | "included"): Meter & { readonly spent: () => MicroUsd } {
    const { store, clock, instance } = this.deps;
    const open = new Map<string, Reservation>();
    let spent = 0;
    return {
      spent: () => spent as MicroUsd,
      reserve: (route, promptBytes) => {
        const now = clock.now();
        const month = utcMonth(now);
        const est = estimate(route, promptBytes);
        if (!fits(store.spend(scope, month), est, cap)) {
          this.#log(route, backend, "refused_user_cap", est, 0 as MicroUsd, null);
          return null;
        }
        const r: Reservation = { id: crypto.randomUUID(), month, scope, purpose: route.purpose, model: route.ref, backend, estimate: est, instance };
        store.reserve(r, now);
        open.set(r.id, r);
        return { id: r.id, estimate: est };
      },
      settle: (reserved, route, outcome) => {
        const r = open.get(reserved.id);
        if (!r) throw new Error("settled a reservation this meter didn't make");
        open.delete(reserved.id);
        const now = clock.now();
        const ran = outcome.kind === "ok" || outcome.kind === "invalid" || outcome.kind === "refused_by_model";
        const measured = ran && (outcome.usage !== null || outcome.reported !== null) ? costOf(route, outcome.usage, outcome.reported) : null;
        const unmetered = ran && (measured === null || !Number.isSafeInteger(measured) || measured < 0);
        const cost = unmetered || outcome.kind === "in_doubt" ? r.estimate : measured ?? (0 as MicroUsd);
        spent += cost;
        const usage = "usage" in outcome ? outcome.usage : null;
        const status = unmetered ? "usage_missing" : STATUS[outcome.kind];
        store.settle(
          r,
          cost,
          [modelCallRow({ id: r.id, agent: this.#agent(), purpose: r.purpose, backend, status, estimate: r.estimate, cost, usage, at: now })],
          now,
        );
      },
    };
  }
}

const isTurn = (req: CallRequest<Purpose>): req is CallRequest<"turn"> => req.purpose === "turn";

function jsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
