import { planAllowsBox, type Plan } from "../billing/plan";
import type { BoxState } from "../box/machine";
import { assertNever, eventKey, mayspend, type AgentKey, type EpochMs, type MicroUsd } from "../domain";
import { modelCallRow, type Backend, type ModelCallStatus } from "../ledger/ledger";
import { NOTICES } from "../notices";
import { OUTPUTS, outputOf, type Output } from "../agent/purposes";
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
import { bytesOf, fitPrompt, type PromptParts } from "../model/prompt";
import { PROVIDERS, type ModelRef } from "../model/providers";
import { routeFor, type CallPurpose, type Purpose, type Route, type Source } from "../model/routes";
import { costOf, estimate, fits, type SpendScope } from "../policy/spend";
import { toLocal, utcMonth } from "../policy/time";
import { z } from "zod";
import type { KeyPageError } from "../notices";
import { endpointOf, open, sessionOf, type KeyDraft, type KeySecrets, type StoredKey } from "./key";

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

/** The dev lane's monthly cap, the size of the old per-person cap, so a dev run doesn't hit it by accident. */
export const DEV_CAP_MICRO = 15_000_000 as MicroUsd;
/** Where a scripted dev run's lane points; the scripted client answers it instead of a fetch. */
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
  /** The state of the box that serves this person, or null when none does. */
  readonly box: BoxState | null;
  readonly key: StoredKey | null;
  readonly included: IncludedConfig;
};

/** `whenEmpty` says why there is no lane: nothing is connected, or the person's own plan is connected but its box isn't signed in. */
export type Access = { readonly lanes: readonly Lane[]; readonly whenEmpty: "nothing" | "box_not_ready" };

/**
 * Pure. Access is computed from facts that already have owners (the box row, the key row, the plan), never stored.
 * The person's own plan comes first. Their key backs it up only if they said yes, so their metered money is never a
 * silent fallback. Our included tier serves only someone with no access of their own.
 */
export function accessOf(f: AccessFacts): Access {
  if (!f.admitted || f.plan.kind === "lapsed") return { lanes: [], whenEmpty: "nothing" };
  const boxAllowed = f.box !== null && planAllowsBox(f.plan.kind);
  const planConnected = boxAllowed && (f.box === "signed_in" || f.box === "signed_out");
  const lanes: Lane[] = [];
  if (boxAllowed && f.box === "signed_in") lanes.push({ kind: "box" });
  if (f.key && (!planConnected || f.key.backup)) lanes.push({ kind: "key", key: f.key });
  const own = planConnected || f.key !== null;
  if (!own && f.included.on && (f.included.who === "everyone" || f.plan.kind === "included")) lanes.push({ kind: "included", included: f.included });
  return { lanes, whenEmpty: planConnected ? "box_not_ready" : "nothing" };
}

export type CallRecord = { readonly lane: Lane["kind"]; readonly model: ModelRef; readonly costMicro: MicroUsd };

export type OverCap = SpendScope | "included_ceiling";

export type Served<P extends Purpose> =
  | { readonly kind: "ok"; readonly value: Output<P>; readonly call: CallRecord }
  /** Invalid output or a refusal, after the one repair in loose mode. */
  | { readonly kind: "failed"; readonly call: CallRecord }
  /** Some lane is down for now; retry the batch later. */
  | { readonly kind: "unavailable" }
  | { readonly kind: "over_cap"; readonly scope: OverCap }
  /** Nothing is connected, the plan's box isn't signed in, or every lane rests on a fault the person was told about. */
  | { readonly kind: "no_access"; readonly why: Access["whenEmpty"]; readonly told: boolean };

export type BoxAnswer = { readonly kind: "reply"; readonly reply: Extract<WireResult, { kind: "reply" }> } | { readonly kind: "moved_on"; readonly transient: boolean; readonly told: boolean };

/** The box as access sees it; the agent implements it, because the box's state machine lives there. */
export interface BoxLane {
  state(): BoxState | null;
  parse(req: { readonly purpose: CallPurpose; readonly model: string; readonly system: string; readonly user: string; readonly jsonSchema: JsonSchema }): Promise<BoxAnswer>;
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

export type CallRequest<P extends Purpose> = { readonly purpose: P; readonly system: string; readonly prompt: PromptParts; readonly plan: Plan };

type Next = { readonly kind: "next"; readonly transient?: boolean; readonly overCap?: OverCap; readonly told?: boolean };
type LaneResult<P extends Purpose> = { readonly kind: "served"; readonly served: Served<P> } | Next;

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

const HOUR_MS = 60 * 60_000;
const MIN_MS = 60_000;

/** How long a key rests after a fault, before it is tried again; null rests it until the person replaces it. */
function restFor(fault: KeyFault, failures: number, retryAfterMs: number | null): number | null {
  const doubling = (base: number, max: number) => Math.min(base * 2 ** Math.min(failures, 10), max);
  switch (fault) {
    case "credential":
    case "payment":
      return doubling(HOUR_MS, 24 * HOUR_MS);
    case "model":
      return 24 * HOUR_MS;
    case "rate":
      return retryAfterMs ?? doubling(15 * MIN_MS, 6 * HOUR_MS);
    case "unreadable":
      return null;
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
    const { store } = this.deps;
    const access = accessOf({
      admitted: mayspend(store.admission()),
      plan: req.plan,
      box: this.deps.box.state(),
      key: store.key(),
      included: this.deps.included,
    });
    let transient = false;
    let overCap: OverCap | null = null;
    let told = false;
    for (const lane of access.lanes) {
      const r = await this.#lane(lane, req);
      if (r.kind === "served") return r.served;
      transient ||= r.transient ?? false;
      told ||= r.told ?? false;
      overCap ??= r.overCap ?? null;
    }
    if (transient) return { kind: "unavailable" };
    if (overCap) return { kind: "over_cap", scope: overCap };
    const boxWaiting = access.whenEmpty === "box_not_ready" || (access.lanes.length > 0 && access.lanes.every((l) => l.kind === "box"));
    return { kind: "no_access", why: boxWaiting ? "box_not_ready" : "nothing", told };
  }

  /**
   * One tiny call that decides whether a key works and which schema mode its endpoint honours: strict first, then loose
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

  /** The prompt fitted to the route, or null when even the kept parts don't fit, which a renderer bug would cause. */
  #fit(route: Route, mode: SchemaMode, req: CallRequest<Purpose>): string | null {
    const schemaBytes = mode === "loose" ? bytesOf(looseUser("", jsonSchemaOf(OUTPUTS[req.purpose]))) : 0;
    const budget = route.promptBytes - bytesOf(req.system) - schemaBytes;
    const user = fitPrompt(req.prompt, budget);
    return bytesOf(user) <= budget ? user : null;
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
      [modelCallRow({ id: crypto.randomUUID(), agent: this.#agent(), purpose: route.purpose, model: route.ref, backend, status, estimate: est, cost, usage: u, at: now })],
      now,
    );
  }

  /** A guard against a renderer bug: a prompt that can't fit is never sent, so no route reaches its long-prompt tier. */
  #oversized<P extends Purpose>(route: Route, backend: Backend, lane: Lane["kind"]): LaneResult<P> {
    this.#log(route, backend, "rejected", 0 as MicroUsd, 0 as MicroUsd, null);
    return { kind: "served", served: { kind: "failed", call: { lane, model: route.ref, costMicro: 0 as MicroUsd } } };
  }

  async #box<P extends Purpose>(req: CallRequest<P>): Promise<LaneResult<P>> {
    const route = routeFor({ kind: "box", provider: "claude" }, req.purpose);
    const user = this.#fit(route, "strict", req);
    if (user === null) return this.#oversized(route, "box", "box");
    const answer = await this.deps.box.parse({ purpose: req.purpose, model: route.model, system: req.system, user, jsonSchema: jsonSchemaOf(OUTPUTS[req.purpose]) });
    if (answer.kind === "moved_on") return { kind: "next", transient: answer.transient, told: answer.told };
    const attempt = readAttempt(answer.reply, outputOf(req.purpose));
    this.#log(route, "box", "settled", 0 as MicroUsd, 0 as MicroUsd, attempt);
    const call: CallRecord = { lane: "box", model: route.ref, costMicro: 0 as MicroUsd };
    return { kind: "served", served: attempt.kind === "ok" ? { kind: "ok", value: attempt.value, call } : { kind: "failed", call } };
  }

  async #key<P extends Purpose>(k: StoredKey, req: CallRequest<P>): Promise<LaneResult<P>> {
    const { store, clock, keys } = this.deps;
    const now = clock.now();
    if (k.health.kind === "resting" && (k.health.until === null || k.health.until > now)) {
      return { kind: "next", told: k.health.toldAt !== null, transient: k.health.fault === "rate" };
    }
    const agent = this.#agent();
    const opened = keys.on ? await open(keys.secrets, agent, k) : ({ kind: "unreadable" } as const);
    if (opened.kind === "unreadable") {
      this.#rest(k, "unreadable", null);
      return { kind: "next", told: true };
    }
    if (opened.kind === "resealed") store.reseal(opened.again);
    const route = routeFor({ kind: "key", provider: k.provider, model: k.model }, req.purpose);
    const user = this.#fit(route, k.mode, req);
    if (user === null) return this.#oversized(route, "key", "key");
    const client = this.deps.connect(endpointOf(k, opened.key, await sessionOf(agent)));
    const meter = this.#meter("byok", k.capMicro, "key");
    const out = await runParse(client, { route, mode: k.mode, system: req.system, user, schema: outputOf(req.purpose) }, meter);
    const last = out.last;
    if (last?.kind === "fault") {
      this.#rest(k, last.fault, last.retryAfterMs);
      return { kind: "next", told: true, transient: last.fault === "rate" };
    }
    if (last?.kind === "ok" || last?.kind === "invalid" || last?.kind === "refused_by_model") store.keyHealthy();
    return this.#outcome(out, route, "key", "byok", meter.spent);
  }

  async #included<P extends Purpose>(inc: IncludedOn, req: CallRequest<P>): Promise<LaneResult<P>> {
    const route = routeFor(inc.source, req.purpose);
    const user = this.#fit(route, inc.mode, req);
    if (user === null) return this.#oversized(route, "included", "included");
    const meter = this.#meter("included", inc.capMicro, "included");
    const out = await runParse(this.deps.connect(inc.endpoint), { route, mode: inc.mode, system: req.system, user, schema: outputOf(req.purpose) }, meter);
    const last = out.last;
    if (last?.kind === "fault") {
      console.error("the included tier's provider refused our key", inc.endpoint.provider, last.fault);
      return last.fault === "payment" ? { kind: "next", overCap: "included_ceiling" } : { kind: "next", transient: true };
    }
    return this.#outcome(out, route, "included", "included", meter.spent);
  }

  #outcome<P extends Purpose>(out: Parsed<Output<P>>, route: Route, lane: Lane["kind"], scope: SpendScope, spent: () => MicroUsd): LaneResult<P> {
    const last = out.last;
    const call: CallRecord = { lane, model: route.ref, costMicro: spent() };
    if (last === null) return { kind: "next", overCap: scope };
    switch (last.kind) {
      case "ok":
        return { kind: "served", served: { kind: "ok", value: last.value, call } };
      case "invalid":
      case "refused_by_model":
        return { kind: "served", served: { kind: "failed", call } };
      case "turned_away":
      case "in_doubt":
      case "rejected":
      case "fault":
        return { kind: "next", transient: true };
      default:
        return assertNever(last);
    }
  }

  #rest(k: StoredKey, fault: KeyFault, retryAfterMs: number | null): void {
    const { store, clock } = this.deps;
    const now = clock.now();
    const failures = k.health.kind === "resting" ? k.health.failures : 0;
    const rest = restFor(fault, failures, retryAfterMs);
    const until = rest === null ? null : ((now + rest) as EpochMs);
    const a = store.agent();
    const lang = a?.language ?? "en";
    const t = NOTICES[lang];
    const label = PROVIDERS[k.provider].label;
    const text =
      fault === "credential"
        ? t.keyRefused(label)
        : fault === "payment"
          ? t.keyNoCredit(label)
          : fault === "model"
            ? t.keyNoModel(label, k.model)
            : fault === "rate"
              ? t.keyRateLimited(label, until === null || !a ? "" : toLocal(until, a.tz).slice(11))
              : t.keyUnreadable;
    store.restKey(fault, until, { key: eventKey.access(`fault:${now}`), message: { texts: [text], note: text } }, now);
  }

  /** Every billed attempt passes through its own reservation, and is settled and logged the moment it returns. */
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
        const cost =
          outcome.kind === "ok" || outcome.kind === "invalid" || outcome.kind === "refused_by_model"
            ? costOf(route, outcome.usage, outcome.reported)
            : outcome.kind === "in_doubt"
              ? r.estimate
              : (0 as MicroUsd);
        spent += cost;
        const usage = "usage" in outcome ? outcome.usage : null;
        store.settle(
          r,
          cost,
          [modelCallRow({ id: r.id, agent: this.#agent(), purpose: r.purpose, model: r.model, backend, status: STATUS[outcome.kind], estimate: r.estimate, cost, usage, at: now })],
          now,
        );
      },
    };
  }
}
