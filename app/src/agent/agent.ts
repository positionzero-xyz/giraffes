import { DurableObject } from "cloudflare:workers";
import type { z } from "zod";
import { apiCapOf, NO_STANDING, PAID_PLANS, planAllowsBox, planOf, trialEnd, type PaidPlan, type Plan } from "../billing/plan";
import {
  BILLING_BUSY,
  BILLING_OFF,
  INVITE_FOR_MS,
  INVITE_NOT_OWNER,
  inviteFull,
  inviteText,
  JOIN,
  LEFT,
  NO_LINKS,
  NOT_SEATED,
  planChanged,
  planChoices,
  planStatus,
  type Links,
} from "../billing/say";
import { d1Billing, type BillingStore } from "../billing/store";
import { stripeApi, type BillingEvent, type StripeApi } from "../billing/stripe";
import { boxClient, type BoxClient } from "../box/client";
import { flyHost } from "../box/fly";
import { staticHost, type BoxHost, type BoxHostKind, type Fetch } from "../box/host";
import {
  afterEnsure,
  afterProbe,
  beginStep,
  BOX,
  boxMessage,
  goneMessage,
  needsEnsure,
  needsLink,
  newBox,
  onCommand,
  onPlan,
  onSignedOut,
  type Box,
  type BoxSay,
  type BoxState,
  type EnsureStep,
  type Probe,
  type ProbeStep,
  type Step,
} from "../box/machine";
import { boxToken, signinTicket, signinUrl, type BoxToken } from "../box/names";
import { makeChannels, type ChannelRegistry } from "../channels/channel";
import { commandOf, type Command } from "./commands";
import { loadConfig, type BillingConfig, type BoxConfig, type Env } from "../config";
import { assertNever, eventKey, intentOf, type AgentKey, type EpochMs, type EventKey, type InboundEnvelope, type MicroUsd, type PersonStatus, type TimeZone } from "../domain";
import { d1Ledger, modelCallRow, type LeaseAnswer, type Ledger, type LogRow, type UnaskedStatus } from "../ledger/ledger";
import { makeModelClient, routeOf, type ModelClient, type ModelId, type ModelResult, type Purpose, type Usage } from "../model/model";
import { admitUnasked, OUTREACH } from "../policy/outreach";
import { checkinWakeup, fireAt, nextAlarm, planFiring, SCHEDULE, type PendingWakeup } from "../policy/schedule";
import { costOf, decideReservation, estimate, SPEND } from "../policy/spend";
import { DEFAULT_TIME_ZONE, localDate, startOfLocalDay, utcMonth } from "../policy/time";
import { compactionCommit, CompactionOutputSchema, planCompaction } from "./compaction";
import { COMPACTION_SYSTEM, TURN_SYSTEM } from "./prompt";
import { migrate } from "./schema";
import { AgentStore, type AgentRow, type NoteMessage, type OutboxRow, type OutboxView, type Reservation, type Settlement } from "./store";
import {
  bypassModel,
  logsForTurn,
  NOTICE,
  planTurn,
  planWithoutModel,
  renderUser,
  TURN,
  TurnOutputSchema,
  type Batch,
  type TurnCall,
  type TurnCommit,
  type TurnRow,
  type TurnView,
} from "./turn";

const DRAIN_BUDGET_MS = 60_000;
const MAX_DELIVERY_ATTEMPTS = 5;
const DELIVERY_BATCH = 20;
const LOG_BATCH = 100;
const LOG_BATCHES_PER_DRAIN = 10;
const MODEL_RETRY_BASE_MS = 30_000;
const NO_COST = 0 as MicroUsd;
const BOX_STEPS_PER_DRAIN = 3;
const utf8 = new TextEncoder();

export type Clock = { now(): EpochMs };

export type BoxDeps = {
  readonly host: BoxHost;
  readonly client: BoxClient;
  readonly secret: string;
  readonly maxBoxes: number;
  /** The one person the shared static box serves; null serves everyone. */
  readonly onlyFor: AgentKey | null;
};

const boxServes = (deps: BoxDeps | null, agent: AgentKey): deps is BoxDeps => deps !== null && (deps.onlyFor === null || deps.onlyFor === agent);

export type AgentDeps = {
  readonly model: ModelClient;
  readonly ledger: Ledger;
  readonly channels: ChannelRegistry;
  readonly clock: Clock;
  readonly box: BoxDeps | null;
  readonly billing: BillingDeps;
};

export type BillingDeps = {
  readonly config: BillingConfig;
  readonly store: BillingStore;
  readonly stripe: StripeApi | null;
};

const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function inviteCode(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => INVITE_ALPHABET[b % INVITE_ALPHABET.length]).join("");
}

type BoxCall<T> =
  | { readonly kind: "box_ok"; readonly value: T; readonly usage: Usage; readonly id: string; readonly model: ModelId }
  | { readonly kind: "box_failed"; readonly usage: Usage | null; readonly id: string; readonly model: ModelId };

type ModelCall<T> =
  | { readonly kind: "ok"; readonly value: T; readonly reservation: Reservation; readonly usage: Usage }
  | { readonly kind: "failed"; readonly reservation: Reservation; readonly usage: Usage | null }
  | { readonly kind: "unavailable"; readonly reservation: Reservation | null; readonly failure: "unavailable" | "rejected" | "in_doubt" }
  | { readonly kind: "refused"; readonly scope: "user_cap" | "global_ceiling"; readonly model: ModelId; readonly estimate: MicroUsd };

export type AgentSnapshot = {
  readonly agent: { readonly key: AgentKey; readonly status: PersonStatus; readonly tz: TimeZone } | null;
  readonly turns: readonly TurnRow[];
  readonly outbox: readonly OutboxView[];
  readonly pendingWakeups: readonly PendingWakeup[];
  readonly unaskedSentToday: number;
  readonly spendThisMonthMicro: MicroUsd;
  readonly box: { readonly host: BoxHostKind; readonly state: BoxState } | null;
  readonly plan: Plan;
};

export class Agent extends DurableObject<Env> {
  readonly #store: AgentStore;
  #deps: AgentDeps;
  // A DO interleaves requests during `await fetch`. The guard is in memory on purpose: there is one live
  // instance per DO, and if it dies the drain dies with it, so the guard never outlives the work it protects.
  #drain: Promise<void> | null = null;
  /** In memory on purpose: losing it on a restart costs one more try of a box that may still be wedged. */
  #skipBoxUntil = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#store = new AgentStore(ctx.storage);
    void ctx.blockConcurrencyWhile(async () => migrate(ctx.storage));
    this.#deps = defaultDeps(env);
  }

  async enqueue(envelope: InboundEnvelope): Promise<"queued" | "duplicate"> {
    const now = this.#deps.clock.now();
    const first = {
      tz: DEFAULT_TIME_ZONE,
      checkinLocal: SCHEDULE.defaultCheckinLocal,
      checkin: checkinWakeup(now, DEFAULT_TIME_ZONE, SCHEDULE.defaultCheckinLocal),
      trialEndsAt: trialEnd(now, this.#deps.billing.config.rules),
    };
    if (this.#store.enqueue(envelope, first, now) === "duplicate") return "duplicate";
    await this.#armNoLaterThan(now);
    this.ctx.waitUntil(this.alarm());
    return "queued";
  }

  async billingEvent(e: BillingEvent): Promise<"applied" | "duplicate"> {
    if (this.#store.billingEventSeen(e.id)) return "duplicate";
    const { store } = this.#deps.billing;
    await store.applySubscription(e.subscription, this.#deps.clock.now());
    await this.refreshPlan(e.subscription.owner);
    if (e.subscription.plan === "plus") {
      for (const member of await store.members(e.subscription.id)) {
        await this.env.AGENT.get(this.env.AGENT.idFromName(member)).refreshPlan(member);
      }
    }
    this.#store.billingEventDone(e.id, this.#deps.clock.now());
    return "applied";
  }

  async refreshPlan(agent: AgentKey): Promise<void> {
    const { config, store } = this.#deps.billing;
    const standing = await store.standing(agent);
    const now = this.#deps.clock.now();
    const before = this.#plan(now);
    const trialEndsAt = this.#store.plan()?.trialEndsAt ?? trialEnd(now, config.rules);
    const after = planOf({ trialEndsAt, ...standing }, now, config.on, config.rules);
    const text = config.on ? planChanged(before, after, now) : null;
    const message = text ? { key: eventKey.billing("plan"), message: { texts: [text] as const, note: text } } : null;
    this.#store.applyStanding(standing, trialEndsAt, message, now);
    if (message) {
      await this.#armNoLaterThan(now);
      this.ctx.waitUntil(this.alarm());
    }
  }

  #plan(now: EpochMs): Plan {
    const { config } = this.#deps.billing;
    return planOf(this.#store.plan(), now, config.on, config.rules);
  }

  /** Cloudflare may invoke it more than once; joining the in-flight drain makes that harmless. */
  override async alarm(): Promise<void> {
    if (this.#drain) return this.#drain;
    this.#drain = this.#runDrain().finally(() => {
      this.#drain = null;
    });
    return this.#drain;
  }

  async snapshot(): Promise<AgentSnapshot> {
    const now = this.#deps.clock.now();
    const a = this.#store.agent();
    const box = this.#store.box();
    return {
      agent: a ? { key: a.key, status: a.status, tz: a.tz } : null,
      turns: this.#store.recentTurns(50),
      outbox: this.#store.recentOutbox(50),
      pendingWakeups: this.#store.pendingWakeups(),
      unaskedSentToday: a ? this.#store.unaskedAdmitted(localDate(now, a.tz)) : 0,
      spendThisMonthMicro: this.#store.monthSpend(utcMonth(now)).spent,
      box: box ? { host: box.host, state: box.state } : null,
      plan: this.#plan(now),
    };
  }

  withDeps(over: Partial<AgentDeps>): void {
    if (loadConfig(this.env).model.backend !== "scripted") throw new Error("withDeps is test-only");
    this.#deps = { ...this.#deps, ...over };
  }

  async #runDrain(): Promise<void> {
    const clock = this.#deps.clock;
    const started = clock.now();
    try {
      await this.#phase("turns", async () => {
        const poisoned = this.#store.recover(started);
        if (poisoned) this.#commitPoison(poisoned);
        this.#fireDueWakeups();
        while (clock.now() - started < DRAIN_BUDGET_MS) {
          const batch = this.#store.claimBatch(clock.now());
          if (!batch) break;
          await this.#turn(batch);
          await this.#deliverReady();
          this.#fireDueWakeups();
        }
      });
      await this.#phase("box", () => this.#stepBox());
      await this.#phase("delivery", () => this.#deliverReady());
      await this.#phase("log flush", () => this.#flushLogs());
      await this.#phase("compaction", () => this.#compactIfDue());
      await this.#phase("prune", async () => this.#store.prune(clock.now()));
    } finally {
      await this.#rearm();
    }
  }

  async #phase(name: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (err) {
      // Not rethrown: our re-arm is the retry policy, not Cloudflare's alarm backoff.
      console.error(`drain ${name} failed`, err);
    }
  }

  #fireDueWakeups(): void {
    const now = this.#deps.clock.now();
    const a = this.#store.agent();
    if (!a) return;
    for (const firing of planFiring(now, a.tz, a.status, a.checkinLocal, this.#store.dueWakeups(now))) {
      this.#store.applyFiring(firing, now);
    }
  }

  #agent(): AgentRow {
    const a = this.#store.agent();
    if (!a) throw new Error("inbox rows exist without an agent row");
    return a;
  }

  #view(batch: Batch, a: AgentRow): TurnView {
    const now = this.#deps.clock.now();
    const admitted = this.#store.unaskedAdmitted(localDate(now, a.tz));
    return {
      now,
      tz: a.tz,
      status: a.status,
      statusAt: a.statusAt,
      checkinLocal: a.checkinLocal,
      batch,
      ...this.#store.turnContext(TURN.recentTurns, TURN.recentNotes),
      unaskedLeftToday: Math.max(0, OUTREACH.dailyUnaskedBudget - admitted),
    };
  }

  async #turn(batch: Batch): Promise<void> {
    const a = this.#agent();
    const view = this.#view(batch, a);
    const bypass = bypassModel(view);
    if (bypass) return this.#commit(planWithoutModel(view, bypass), view, a.key, { kind: "none" }, null);
    const command = commandOf(batch.items[0].event);
    if (command) return this.#command(command, view, a.key);
    const plan = this.#plan(view.now);
    if (plan.kind === "lapsed") {
      const alreadyToldToday = this.#store.toldToday("lapsed", startOfLocalDay(view.now, view.tz));
      return this.#commit(planWithoutModel(view, { kind: "lapsed", alreadyToldToday }), view, a.key, { kind: "none" }, null);
    }

    const call = await this.#callModel(TURN_SYSTEM, renderUser(view), TurnOutputSchema, batch.items[0].key, a.key, plan);
    switch (call.kind) {
      case "box_ok":
      case "box_failed": {
        const commit = call.kind === "box_ok" ? planTurn(call.value, view) : planWithoutModel(view, { kind: "model_failed" });
        return this.#commit(commit, view, a.key, { kind: "box", id: call.id, model: call.model, usage: call.usage }, null);
      }
      case "ok": {
        const settle = { reservation: call.reservation, cost: costOf(call.reservation.model, call.usage) };
        return this.#commit(planTurn(call.value, view), view, a.key, settledCall(settle, call.usage), settle);
      }
      case "failed": {
        const settle = { reservation: call.reservation, cost: call.usage ? costOf(call.reservation.model, call.usage) : NO_COST };
        return this.#commit(planWithoutModel(view, { kind: "model_failed" }), view, a.key, settledCall(settle, call.usage), settle);
      }
      case "refused": {
        const alreadyToldToday = this.#store.toldToday("refused_budget", startOfLocalDay(view.now, view.tz));
        const commit = planWithoutModel(view, { kind: "refused_budget", alreadyToldToday });
        return this.#commit(commit, view, a.key, { kind: "refused", scope: call.scope, model: call.model, estimate: call.estimate }, null);
      }
      case "unavailable":
        return this.#modelUnavailable(view, a.key, call);
      default:
        return assertNever(call);
    }
  }

  #commit(
    commit: TurnCommit,
    view: TurnView,
    agent: AgentKey,
    call: TurnCall,
    settle: Settlement | null,
    extra: readonly LogRow[] = [],
    box: Box | null = null,
  ): void {
    const now = this.#deps.clock.now();
    const logs = [...logsForTurn({ agent, commit, view, call, startedAt: view.now, now }), ...extra];
    this.#store.commitTurn(commit, settle, logs, now, box);
  }

  async #command(command: Command, view: TurnView, agent: AgentKey): Promise<void> {
    switch (command.kind) {
      case "claude":
        return this.#boxCommand(view, agent);
      case "plan":
      case "invite":
      case "join":
      case "leave": {
        if (!this.#deps.billing.config.on && command.kind !== "plan") return this.#reply(view, agent, BILLING_OFF);
        let reply: { readonly text: string; readonly note: string };
        try {
          reply = await this.#billingCommand(command, view, agent);
        } catch (err) {
          console.warn("billing command failed", command.kind, err);
          reply = { text: BILLING_BUSY, note: BILLING_BUSY };
        }
        return this.#reply(view, agent, reply.text, reply.note);
      }
      default:
        return assertNever(command);
    }
  }

  #reply(view: TurnView, agent: AgentKey, text: string, note: string = text): void {
    this.#commit(planWithoutModel(view, { kind: "command", text, note }), view, agent, { kind: "none" }, null);
  }

  async #standingNow(agent: AgentKey): Promise<Plan> {
    const { config, store } = this.#deps.billing;
    const standing = config.on ? await store.standing(agent) : NO_STANDING;
    const now = this.#deps.clock.now();
    this.#store.applyStanding(standing, trialEnd(now, config.rules), null, now);
    return this.#plan(now);
  }

  async #billingCommand(
    command: Extract<Command, { kind: "plan" | "invite" | "join" | "leave" }>,
    view: TurnView,
    agent: AgentKey,
  ): Promise<{ readonly text: string; readonly note: string }> {
    const { config, store } = this.#deps.billing;
    const now = this.#deps.clock.now();
    const say = (text: string) => ({ text, note: text });
    switch (command.kind) {
      case "plan": {
        const plan = await this.#standingNow(agent);
        const places = plan.kind === "plus" && plan.role === "owner" ? await store.places(agent) : null;
        const status = planStatus(plan, now, places);
        if (!config.on || (plan.kind !== "trial" && plan.kind !== "lapsed")) return say(status);
        const links = await this.#checkoutLinks(agent, view.batch.items[0].key);
        if (!links) return say(`${status}\n${NO_LINKS}`);
        const choices = planChoices(config.rules, links);
        return { text: `${status}\n${choices.text}`, note: `${status}\n${choices.note}` };
      }
      case "invite": {
        const code = inviteCode();
        const r = await store.invite(agent, code, now, (now + INVITE_FOR_MS) as EpochMs);
        if (r.kind === "created") return { text: inviteText(code), note: inviteText("<code>") };
        return say(r.kind === "full" ? inviteFull(r.seats) : INVITE_NOT_OWNER);
      }
      case "join": {
        const r = await store.join(command.code, agent, now);
        if (r === "joined") await this.#standingNow(agent);
        return say(JOIN[r]);
      }
      case "leave": {
        if (!(await store.leave(agent, now))) return say(NOT_SEATED);
        const plan = await this.#standingNow(agent);
        return say(`${LEFT}\n${plan.kind === "lapsed" ? NOTICE.lapsed : planStatus(plan, now, null)}`);
      }
      default:
        return assertNever(command);
    }
  }

  async #checkoutLinks(agent: AgentKey, key: EventKey): Promise<Links | null> {
    const stripe = this.#deps.billing.stripe;
    if (!stripe) return null;
    const results = await Promise.all(
      PAID_PLANS.map(async (plan) => ({ plan, result: await stripe.checkout({ agent, plan, idempotencyKey: `${agent}|${key}|${plan}` }) })),
    );
    const links: Partial<Record<PaidPlan, string>> = {};
    for (const { plan, result } of results) {
      if (!result.ok) {
        console.warn("checkout failed", plan, result.detail);
        return null;
      }
      links[plan] = result.url;
    }
    return links as Links;
  }

  async #boxCommand(view: TurnView, agent: AgentKey): Promise<void> {
    const deps = this.#deps.box;
    if (!boxServes(deps, agent)) return this.#boxReply(view, agent, null, { box: null, say: "unavailable" });
    if (!planAllowsBox(this.#plan(view.now).kind)) return this.#boxReply(view, agent, null, { box: null, say: "not_in_plan" });
    const now = this.#deps.clock.now();
    const current = this.#store.box();
    if (current) return this.#boxReply(view, agent, deps, onCommand(current, now));

    const name = await deps.host.nameFor(agent);
    let claim: "granted" | "full";
    try {
      claim = await this.#deps.ledger.claimBox({ agent, name, host: deps.host.kind, at: now, max: deps.maxBoxes });
    } catch (err) {
      console.warn("box claim failed", err);
      return this.#modelUnavailable(view, agent, { kind: "unavailable", reservation: null, failure: "unavailable" });
    }
    if (claim === "full") return this.#boxReply(view, agent, deps, { box: null, say: "full" });
    return this.#boxReply(view, agent, deps, { box: newBox(name, deps.host.kind, deps.host.urlOf(name), deps.host.image, now), say: "setting_up" });
  }

  async #boxReply(view: TurnView, agent: AgentKey, deps: BoxDeps | null, t: { readonly box: Box | null; readonly say: BoxSay }): Promise<void> {
    const message = deps && t.box ? await this.#boxMessage(deps, t.box, t.say) : boxMessage(t.say, null);
    const commit = planWithoutModel(view, { kind: "command", text: message.text, note: message.note });
    this.#commit(commit, view, agent, { kind: "none" }, null, [], t.box);
  }

  async #boxMessage(deps: BoxDeps, box: Box, say: BoxSay): Promise<{ readonly text: string; readonly note: string }> {
    if (say === "retiring" && box.retireAt !== null) return boxMessage(say, null, longDate(box.retireAt, this.#agent().tz));
    if (!needsLink(say)) return boxMessage(say, null);
    const exp = (this.#deps.clock.now() + BOX.ticketForMs) as EpochMs;
    const ticket = await signinTicket(await boxToken(deps.secret, box.name), exp);
    return boxMessage(say, signinUrl(box.url, ticket));
  }

  async #outboxMessage(deps: BoxDeps, box: Box, say: BoxSay | null): Promise<NoteMessage | null> {
    if (say === null) return null;
    const m = await this.#boxMessage(deps, box, say);
    return { texts: [m.text], note: m.note };
  }

  async #stepBox(): Promise<void> {
    const deps = this.#deps.box;
    const box = this.#store.box();
    if (!deps || !box) return;
    const now = this.#deps.clock.now();
    const planned = onPlan(box, !this.#deps.billing.config.on || planAllowsBox(this.#plan(now).kind), now);
    const current = deps.host.image !== null && planned.box.image !== deps.host.image ? needsEnsure(planned.box, now) : planned.box;
    if (current !== box) this.#store.applyBox(current, await this.#outboxMessage(deps, current, planned.say), [], now);
    for (let i = 0; i < BOX_STEPS_PER_DRAIN; i++) {
      const stored = this.#store.box();
      const step = stored && beginStep(stored, this.#deps.clock.now());
      if (!step) return;
      this.#store.applyBox(step.box, null, [], this.#deps.clock.now());
      if (step.kind === "reclaim") {
        await this.#reclaim(deps, step);
        continue;
      }
      if (step.kind === "ensure") {
        await this.#ensure(deps, step);
        continue;
      }
      const probe = await this.#probe(deps, step);
      const t = afterProbe(step, probe, this.#deps.clock.now());
      this.#store.applyBox(t.box, await this.#outboxMessage(deps, t.box, t.say), [], this.#deps.clock.now());
    }
  }

  async #reclaim(deps: BoxDeps, step: Extract<Step, { kind: "reclaim" }>): Promise<void> {
    const destroyed = await deps.host.destroy(step.box.name);
    if (!destroyed.ok) {
      console.warn("box reclaim failed", step.box.name, destroyed.detail);
      return;
    }
    await this.#deps.ledger.releaseBox(this.#agent().key, this.#deps.clock.now());
    const m = goneMessage(step.box);
    this.#store.removeBox(step.box.name, { texts: [m.text], note: m.note }, this.#deps.clock.now());
  }

  async #ensure(deps: BoxDeps, step: EnsureStep): Promise<void> {
    const ensured = await deps.host.ensure(step.box.name, await boxToken(deps.secret, step.box.name));
    if (!ensured.ok) return console.warn("box ensure failed", step.box.name, ensured.detail);
    this.#store.applyBox(afterEnsure(step, deps.host.image), null, [], this.#deps.clock.now());
  }

  async #probe(deps: BoxDeps, step: ProbeStep): Promise<Probe> {
    const token = await boxToken(deps.secret, step.box.name);
    if (step.kind === "provision") {
      const ensured = await deps.host.ensure(step.box.name, token);
      if (!ensured.ok) return { kind: "down", retryable: ensured.retryable, detail: ensured.detail };
    }
    const health = await deps.client.health(step.box.url, token);
    return health.kind === "unavailable" ? { kind: "down", retryable: true, detail: health.detail } : health;
  }

  async #callBox<T>(system: string, user: string, schema: z.ZodType<T>, agent: AgentKey): Promise<BoxCall<T> | null> {
    const deps = this.#deps.box;
    const box = this.#store.box();
    if (!boxServes(deps, agent) || box?.state !== "signed_in" || this.#deps.clock.now() < this.#skipBoxUntil) return null;
    const id = crypto.randomUUID();
    const model = routeOf("turn").model;
    const res = await deps.client.parse(box.url, await boxToken(deps.secret, box.name), { purpose: "turn", system, user, schema });
    const now = this.#deps.clock.now();
    const missed = (status: "rejected" | "unavailable"): LogRow =>
      modelCallRow({ id, agent, purpose: "turn", model, backend: "box", status, estimate: NO_COST, cost: NO_COST, usage: null, at: now });
    switch (res.kind) {
      case "ok":
        return { kind: "box_ok", value: res.value, usage: res.usage, id, model };
      case "failed":
        return { kind: "box_failed", usage: res.usage, id, model };
      case "signed_out": {
        const t = onSignedOut(box, now);
        this.#store.applyBox(t.box, await this.#outboxMessage(deps, t.box, t.say), [missed("rejected")], now);
        return null;
      }
      case "unauthorized":
        this.#store.applyBox(needsEnsure(box, now), null, [missed("rejected")], now);
        return null;
      case "unavailable":
        console.warn("box unavailable", res.detail);
        this.#skipBoxUntil = now + BOX.skipAfterUnavailableMs;
        this.#store.appendLogs([missed("unavailable")], now);
        return null;
      default:
        return assertNever(res);
    }
  }

  async #callModel<T>(
    system: string,
    user: string,
    schema: z.ZodType<T>,
    eventKey: EventKey,
    agent: AgentKey,
    plan: Plan,
  ): Promise<ModelCall<T> | BoxCall<T>> {
    const box = planAllowsBox(plan.kind) ? await this.#callBox(system, user, schema, agent) : null;
    return box ?? this.#callApi("turn", system, user, schema, eventKey, agent, plan);
  }

  #commitPoison(batch: Batch): void {
    const a = this.#agent();
    const view = this.#view(batch, a);
    this.#commit(planWithoutModel(view, { kind: "poison" }), view, a.key, { kind: "none" }, null);
  }

  #modelUnavailable(view: TurnView, agent: AgentKey, call: Unavailable): void {
    const now = this.#deps.clock.now();
    const { settle, logs } = closeUnavailable(call, agent, now);
    const attempts = Math.max(...view.batch.items.map((i) => i.attempts));
    const requested = intentOf(view.batch.items[0].event) === "requested";
    if (attempts >= (requested ? TURN.maxRequestedModelAttempts : TURN.maxModelAttempts)) {
      return this.#commit(planWithoutModel(view, { kind: "model_failed" }), view, agent, { kind: "none" }, settle, logs);
    }
    const keys = view.batch.items.map((i) => i.key);
    this.#store.releaseBatch(keys, (now + MODEL_RETRY_BASE_MS * 2 ** (attempts - 1)) as EpochMs, settle, logs, now);
  }

  async #callApi<T>(
    purpose: Purpose,
    system: string,
    user: string,
    schema: z.ZodType<T>,
    eventKey: EventKey | null,
    agent: AgentKey,
    plan: Plan,
  ): Promise<ModelCall<T>> {
    const route = routeOf(purpose);
    const cap = apiCapOf(plan.kind, this.#deps.billing.config.rules);
    const now = this.#deps.clock.now();
    const month = utcMonth(now);
    const est = estimate(route.model, utf8.encode(system).length + utf8.encode(user).length, route.maxTokens);
    for (;;) {
      const decision = decideReservation(this.#store.monthSpend(month), est, cap);
      if (decision.kind === "reserve") break;
      if (decision.kind === "refuse") return { kind: "refused", scope: decision.scope, model: route.model, estimate: est };
      const seq = this.#store.beginLease(month);
      let answer: LeaseAnswer;
      try {
        answer = await this.#deps.ledger.requestLease({ agent, month, seq, micro: decision.chunk, at: now });
      } catch (err) {
        console.warn("lease request failed", err);
        return { kind: "unavailable", reservation: null, failure: "unavailable" };
      }
      if (answer.kind === "ceiling") {
        this.#store.denyLease(month, seq);
        return { kind: "refused", scope: "global_ceiling", model: route.model, estimate: est };
      }
      this.#store.grantLease(month, seq, answer.micro);
    }
    const reservation: Reservation = { id: crypto.randomUUID(), month, purpose, model: route.model, estimate: est };
    this.#store.reserve(reservation, eventKey, now);
    let res: ModelResult<T>;
    try {
      res = await this.#deps.model.parse({ purpose, system, user, schema });
    } catch (err) {
      const at = this.#deps.clock.now();
      this.#store.settle({ reservation, cost: reservation.estimate }, [callRow(agent, reservation, "in_doubt", reservation.estimate, null, at)], at);
      throw err;
    }
    if (res.ok) return { kind: "ok", value: res.value, reservation, usage: res.usage };
    if (res.failure === "unavailable" || res.failure === "rejected" || res.failure === "in_doubt") {
      return { kind: "unavailable", reservation, failure: res.failure };
    }
    return { kind: "failed", reservation, usage: res.usage };
  }

  async #deliverReady(): Promise<void> {
    for (const row of this.#store.readyOutbox(this.#deps.clock.now(), DELIVERY_BATCH)) await this.#deliver(row);
  }

  async #deliver(row: OutboxRow): Promise<void> {
    const now = this.#deps.clock.now();
    const a = this.#agent();
    const unaskedLog = (status: UnaskedStatus, day: OutboxRow["admittedDay"]): LogRow[] =>
      row.intent === "unasked"
        ? [{ stream: "unasked", id: row.id, agent: a.key, triggerKind: row.triggerKind, text: row.texts.join("\n"), status, day, at: now }]
        : [];

    if (row.attempts >= MAX_DELIVERY_ATTEMPTS) return this.#store.drop(row.id, "failed", now, unaskedLog("failed", row.admittedDay));
    if (a.status === "blocked") return this.#store.drop(row.id, "blocked", now, unaskedLog("dropped_blocked", null));

    let day = row.admittedDay;
    if (row.intent === "unasked") {
      const verdict = admitUnasked({
        now,
        tz: a.tz,
        admittedDay: day,
        sentToday: this.#store.unaskedAdmitted(localDate(now, a.tz)),
        dailyBudget: OUTREACH.dailyUnaskedBudget,
        status: a.status,
      });
      switch (verdict.verdict) {
        case "defer":
          return this.#store.reschedule(row.id, verdict.until);
        case "drop":
          return this.#store.drop(row.id, verdict.reason, now, unaskedLog(verdict.reason === "budget" ? "dropped_budget" : "dropped_blocked", null));
        case "send":
          day = verdict.day;
          break;
        default:
          return assertNever(verdict);
      }
    }

    this.#store.markSending(row.id, day);
    const delivery = await this.#deps.channels[row.to.channel].deliver(row, now);
    const after = this.#deps.clock.now();
    switch (delivery.kind) {
      case "sent":
        return this.#store.markSent(row.id, delivery.via, after, unaskedLog("sent", day));
      case "retry":
      case "in_doubt": {
        const at = (after + delivery.afterMs) as EpochMs;
        if (row.attempts + 1 < MAX_DELIVERY_ATTEMPTS) {
          return delivery.kind === "in_doubt" ? this.#store.rescheduleInDoubt(row.id, at) : this.#store.reschedule(row.id, at);
        }
        console.warn("delivery gave up", row.id, delivery.detail);
        return this.#store.drop(row.id, "failed", after, unaskedLog("failed", day));
      }
      case "failed":
        console.warn("delivery failed", row.id, delivery.detail);
        return this.#store.drop(row.id, "failed", after, unaskedLog("failed", day));
      case "recipient_gone":
        return this.#store.recipientGone(row.id, after, [
          ...unaskedLog("dropped_blocked", day),
          { stream: "lifecycle", id: `gone:${row.id}`, agent: a.key, change: "block", source: "delivery", at: after },
        ]);
      default:
        return assertNever(delivery);
    }
  }

  async #compactIfDue(): Promise<void> {
    const a = this.#store.agent();
    if (!a || this.#store.compactionRetryAt() > this.#deps.clock.now()) return;
    const person = this.#plan(this.#deps.clock.now());
    if (person.kind === "lapsed") return;
    const plan = planCompaction(this.#store.compactionInput());
    if (!plan) return;
    let call: ModelCall<z.infer<typeof CompactionOutputSchema>>;
    try {
      call = await this.#callApi("compaction", COMPACTION_SYSTEM, plan.user, CompactionOutputSchema, null, a.key, person);
    } catch (err) {
      this.#store.compactionFailed(this.#deps.clock.now(), null, []);
      throw err;
    }
    const now = this.#deps.clock.now();
    switch (call.kind) {
      case "ok": {
        const cost = costOf(call.reservation.model, call.usage);
        const logs = [callRow(a.key, call.reservation, "settled", cost, call.usage, now)];
        this.#store.commitCompaction(compactionCommit(plan, call.value), { reservation: call.reservation, cost }, logs, now);
        return;
      }
      case "failed": {
        const cost = call.usage ? costOf(call.reservation.model, call.usage) : NO_COST;
        this.#store.compactionFailed(now, { reservation: call.reservation, cost }, [callRow(a.key, call.reservation, "settled", cost, call.usage, now)]);
        return;
      }
      case "unavailable": {
        const { settle, logs } = closeUnavailable(call, a.key, now);
        return this.#store.compactionFailed(now, settle, logs);
      }
      case "refused":
        return this.#store.compactionFailed(now, null, []);
      default:
        return assertNever(call);
    }
  }

  async #flushLogs(): Promise<void> {
    for (let i = 0; i < LOG_BATCHES_PER_DRAIN; i++) {
      const rows = this.#store.pendingLogs(this.#deps.clock.now(), LOG_BATCH);
      if (rows.length === 0) return;
      try {
        await this.#deps.ledger.append(rows);
      } catch (err) {
        console.warn("log flush failed", err);
        return this.#store.logsFailed(this.#deps.clock.now());
      }
      this.#store.logsShipped(rows);
      if (rows.length < LOG_BATCH) return;
    }
  }

  async #rearm(): Promise<void> {
    const now = this.#deps.clock.now();
    const r = this.#store.readiness(now);
    const a = this.#store.agent();
    const fireTimes = a ? r.earliestWakeups.map((w) => fireAt(w, a.tz)) : [];
    const t = nextAlarm({
      now,
      inboxReadyAt: r.inboxReadyAt,
      wakeupFireAt: fireTimes.length > 0 ? (Math.min(...fireTimes) as EpochMs) : null,
      outboxReadyAt: r.outboxReadyAt,
      logsReadyAt: r.logsReadyAt,
      compactionRetryAt: r.compactionRetryAt,
      boxAt: this.#deps.box ? r.boxAt : null,
    });
    if (t === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(t);
  }

  async #armNoLaterThan(t: EpochMs): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > t) await this.ctx.storage.setAlarm(t);
  }
}

type Unavailable = Extract<ModelCall<unknown>, { kind: "unavailable" }>;

function closeUnavailable(call: Unavailable, agent: AgentKey, now: EpochMs): { settle: Settlement | null; logs: LogRow[] } {
  const r = call.reservation;
  if (!r) return { settle: null, logs: [] };
  const cost = call.failure === "in_doubt" ? r.estimate : NO_COST;
  return { settle: { reservation: r, cost }, logs: [callRow(agent, r, call.failure, cost, null, now)] };
}

function settledCall(settle: Settlement, usage: Usage | null): TurnCall {
  const { reservation, cost } = settle;
  return { kind: "settled", reservationId: reservation.id, model: reservation.model, estimate: reservation.estimate, cost, usage };
}

function callRow(
  agent: AgentKey,
  r: Reservation,
  status: "settled" | Unavailable["failure"],
  cost: MicroUsd,
  usage: Usage | null,
  at: EpochMs,
): LogRow {
  return modelCallRow({ id: r.id, agent, purpose: r.purpose, model: r.model, backend: "api", status, estimate: r.estimate, cost, usage, at });
}

function longDate(t: EpochMs, tz: TimeZone): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: tz }).format(t);
}

function boxDeps(c: BoxConfig): BoxDeps | null {
  const f: Fetch = (input, init) => fetch(input, init);
  switch (c.host) {
    case "none":
      return null;
    case "fly":
      return {
        host: flyHost({ ...c.fly, appPrefix: c.appPrefix, secret: c.secret }, f),
        client: boxClient(f),
        secret: c.secret,
        maxBoxes: c.maxBoxes,
        onlyFor: null,
      };
    case "static":
      return {
        host: staticHost({ url: c.staticUrl, appPrefix: c.appPrefix }),
        client: boxClient(f),
        secret: c.secret,
        maxBoxes: c.maxBoxes,
        onlyFor: c.owner,
      };
    default:
      return assertNever(c);
  }
}

function defaultDeps(env: Env): AgentDeps {
  const config = loadConfig(env);
  return {
    model: makeModelClient(config.model),
    ledger: d1Ledger(env.LEDGER, SPEND.globalCeilingMicro),
    channels: makeChannels(config),
    clock: { now: () => Date.now() as EpochMs },
    box: boxDeps(config.box),
    billing: {
      config: config.billing,
      store: d1Billing(env.LEDGER),
      stripe: config.billing.on ? stripeApi(config.billing.stripe, config.billing.rules, (input, init) => fetch(input, init)) : null,
    },
  };
}
