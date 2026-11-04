import { DurableObject } from "cloudflare:workers";
import { accessOf, ModelAccess, type BoxAnswer, type BoxLane, type IncludedConfig, type KeysConfig, type Served } from "../access/access";
import { NO_STANDING, planAllowsBox, planOf, trialEnd, type PaidPlan, type Plan, type Standing, type SubscriptionId } from "../billing/plan";
import { INVITE_FOR_MS, MANAGE_NOTE, planChanged, planChoices, planStatus, type Links } from "../billing/say";
import { d1Billing, type BillingStore } from "../billing/store";
import { offeredPlans, parseSubscription, stripeApi, type BillingEvent, type StripeApi } from "../billing/stripe";
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
import {
  assertNever,
  CHANNEL_LANGUAGE,
  eventKey,
  intentOf,
  mayspend,
  newInviteCode,
  type Admission,
  type AgentKey,
  type EpochMs,
  type EventKey,
  type InboundEnvelope,
  type InviteCode,
  type Language,
  type MicroUsd,
  type PersonStatus,
  type Seat,
  type TimeZone,
} from "../domain";
import { d1Ledger, modelCallRow, type Ledger, type LogRow, type UnaskedStatus } from "../ledger/ledger";
import { NOTICES } from "../notices";
import { scripted, scriptedConnect, type ScriptStep } from "../model/scripted";
import { connect, type Connect } from "../model/client";
import type { PromptParts } from "../model/prompt";
import { PROMPT_FLOOR_BYTES, type Purpose } from "../model/routes";
import { devLane, DEV_URL_SCRIPTED } from "../access/access";
import { admitUnasked, OUTREACH, type UnaskedVerdict } from "../policy/outreach";
import { inLineReserve, type QuotaReading } from "../policy/quota";
import { checkinWakeup, fireAt, nextAlarm, planFiring, SCHEDULE, type PendingWakeup } from "../policy/schedule";
import { DEFAULT_TIME_ZONE, localDate, startOfLocalDay, utcMonth } from "../policy/time";
import { ADMISSION, planAdmission, type AdmissionAnswer, type AdmissionMode, type AdmissionStep } from "./admission";
import { COMPACTION, compactionCommit, planCompaction } from "./compaction";
import { COMPACTION_SYSTEM, TURN_SYSTEM } from "./prompt";
import { migrate } from "./schema";
import {
  AgentStore,
  globalTaskId,
  type AgentRow,
  type NoteMessage,
  type OutboxRow,
  type OutboxView,
  type TaskSnapshot,
} from "./store";
import {
  bypassModel,
  logsForTurn,
  planTurn,
  planWithoutModel,
  renderUser,
  TURN,
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
  /** Builds a wire client for an endpoint: a person's key, our included tier, or the dev bridge. */
  readonly connect: Connect;
  readonly keys: KeysConfig;
  readonly included: IncludedConfig;
  readonly ledger: Ledger;
  readonly channels: ChannelRegistry;
  readonly clock: Clock;
  readonly box: BoxDeps | null;
  readonly billing: BillingDeps;
  readonly admission: AdmissionMode;
};

export type BillingDeps = {
  readonly config: BillingConfig;
  readonly store: BillingStore;
  readonly stripe: StripeApi | null;
};

const STAFF: Seat = { cohort: "staff", half: null, code: null, inviter: null };

/** A model call a group asks its owner to serve; the group names the ownership version it was told. */
export type ServeRequest = {
  readonly group: AgentKey;
  readonly ownershipVersion: number;
  readonly purpose: Purpose;
  readonly system: string;
  readonly prompt: PromptParts;
};

export type AccessView = {
  readonly lanes: readonly ("box" | "key" | "included")[];
  /** What the person's key is, never the key: the snapshot proves it stays sealed. */
  readonly key: {
    readonly provider: string;
    readonly model: string;
    readonly hint: string;
    readonly mode: "strict" | "loose";
    readonly sealedBytes: number;
    readonly capMicro: MicroUsd;
    readonly backup: boolean;
    readonly health: string;
  } | null;
  readonly spentMicro: { readonly byok: MicroUsd; readonly included: MicroUsd };
};

export type AgentSnapshot = {
  readonly agent: { readonly key: AgentKey; readonly status: PersonStatus; readonly tz: TimeZone; readonly language: Language } | null;
  readonly turns: readonly TurnRow[];
  readonly outbox: readonly OutboxView[];
  readonly pendingWakeups: readonly PendingWakeup[];
  readonly unaskedSentToday: number;
  readonly spendThisMonthMicro: MicroUsd;
  readonly box: { readonly host: BoxHostKind; readonly state: BoxState } | null;
  readonly plan: Plan;
  readonly tasks: readonly TaskSnapshot[];
  readonly admission: Admission;
  readonly access: AccessView;
};

export class Agent extends DurableObject<Env> {
  readonly #store: AgentStore;
  #deps: AgentDeps;
  // A DO interleaves requests during `await fetch`. The guard is in memory on purpose: there is one live
  // instance per DO, and if it dies the drain dies with it, so the guard never outlives the work it protects.
  #drain: Promise<void> | null = null;
  // Each event re-reads the subscription from Stripe; handling them one at a time keeps a slower, older read
  // from landing after a newer one. Like #drain, it lives and dies with this instance.
  #billing: Promise<unknown> = Promise.resolve();
  /** In memory on purpose: losing it on a restart costs one more try of a box that may still be wedged. */
  #skipBoxUntil = 0;
  /** Marks this instance's reservations, so recovery settles only those a dead instance left. */
  readonly #instance = crypto.randomUUID();

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
      language: CHANNEL_LANGUAGE[envelope.identity.channel],
      checkinLocal: SCHEDULE.defaultCheckinLocal,
      checkin: checkinWakeup(now, DEFAULT_TIME_ZONE, SCHEDULE.defaultCheckinLocal),
      trialEndsAt: this.#deps.billing.config.on ? trialEnd(now, this.#deps.billing.config.rules) : null,
      admit: this.#deps.admission === "open" || envelope.identity.channel === "dev" ? STAFF : null,
    };
    if (this.#store.enqueue(envelope, first, now) === "duplicate") return "duplicate";
    await this.#armNoLaterThan(now);
    this.ctx.waitUntil(this.alarm());
    return "queued";
  }

  billingEvent(e: BillingEvent): Promise<"applied" | "duplicate" | "ignored"> {
    const run = this.#billing.then(() => this.#billingEvent(e));
    this.#billing = run.catch(() => undefined);
    return run;
  }

  async #billingEvent(e: BillingEvent): Promise<"applied" | "duplicate" | "ignored"> {
    if (this.#store.billingEventSeen(e.id)) return "duplicate";
    const { config, store, stripe } = this.#deps.billing;
    if (!config.on || !stripe) throw new Error("a Stripe event reached a DO with billing off");
    const fetched = await stripe.subscription(e.subscription);
    if (!fetched.ok) throw new Error(`subscription read failed: ${fetched.detail}`);
    const read = parseSubscription(fetched.value, config.rules);
    if (read.kind === "invalid") throw new Error(`subscription read failed: ${read.reason}`);
    if (read.kind === "not_ours" || read.subscription.owner !== e.owner) {
      console.warn("stripe event ignored", e.id, read.kind === "not_ours" ? read.reason : "owner differs from the event's");
      this.#store.billingEventDone(e.id, this.#deps.clock.now());
      return "ignored";
    }
    const sub = read.subscription;
    await store.applySubscription(sub, this.#deps.clock.now());
    await this.refreshPlan(sub.owner);
    for (const member of await store.members(sub.id)) {
      await this.env.AGENT.get(this.env.AGENT.idFromName(member)).refreshPlan(member);
    }
    await this.#flagDuplicate(sub.owner);
    this.#store.billingEventDone(e.id, this.#deps.clock.now());
    return "applied";
  }

  /** Two paying subscriptions need a person to decide which to refund, so nothing is cancelled here. */
  async #flagDuplicate(owner: AgentKey): Promise<void> {
    const { store } = this.#deps.billing;
    const now = this.#deps.clock.now();
    const owned = await store.owned(owner, now);
    if (owned.length < 2) return;
    console.error("person owns more than one paying subscription", owner, owned.join(" "));
    await store.recordDuplicate(owner, owned, now);
    const a = this.#store.agent();
    const text = a ? NOTICES[a.language].duplicate : null;
    this.#store.notifyOnce(`duplicate:${owned.join(" ")}`, eventKey.billing("duplicate"), text ? { texts: [text], note: text } : null, now);
    await this.#armNoLaterThan(now);
    this.ctx.waitUntil(this.alarm());
  }

  async refreshPlan(agent: AgentKey): Promise<void> {
    const { config, store } = this.#deps.billing;
    const now = this.#deps.clock.now();
    const standing = await store.standing(agent, now);
    const before = this.#plan(now);
    const after = planOf({ trialEndsAt: this.#store.plan()?.trialEndsAt ?? null, ...standing }, now, config.on, config.rules);
    const a = this.#store.agent();
    const text = config.on && a ? planChanged(before, after, now, a.language) : null;
    const message = text ? { key: eventKey.billing("plan"), message: { texts: [text] as const, note: text } } : null;
    this.#store.applyStanding(standing, message, now);
    if (message) {
      await this.#armNoLaterThan(now);
      this.ctx.waitUntil(this.alarm());
    }
  }

  #plan(now: EpochMs): Plan {
    const { config } = this.#deps.billing;
    return planOf(this.#store.plan(), now, config.on, config.rules);
  }

  /** D1 is the truth; the projection a refresh keeps stands in only while D1 can't be read. */
  async #planNow(agent: AgentKey, now: EpochMs): Promise<Plan> {
    const { config, store } = this.#deps.billing;
    if (!config.on) return this.#plan(now);
    let standing: Standing;
    try {
      standing = await store.standing(agent, now);
    } catch (err) {
      console.warn("standing unreadable, using the last refreshed plan", err);
      return this.#plan(now);
    }
    return planOf({ trialEndsAt: this.#store.plan()?.trialEndsAt ?? null, ...standing }, now, true, config.rules);
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
    const month = utcMonth(now);
    const spent = { byok: this.#store.spend("byok", month).spent, included: this.#store.spend("included", month).spent };
    return {
      agent: a ? { key: a.key, status: a.status, tz: a.tz, language: a.language } : null,
      turns: this.#store.recentTurns(50),
      outbox: this.#store.recentOutbox(50),
      pendingWakeups: this.#store.pendingWakeups(),
      unaskedSentToday: a ? this.#store.unaskedAdmitted(localDate(now, a.tz)) : 0,
      spendThisMonthMicro: (spent.byok + spent.included) as MicroUsd,
      box: box ? { host: box.host, state: box.state } : null,
      plan: this.#plan(now),
      tasks: this.#store.tasks(),
      admission: this.#store.admission(),
      access: this.#accessView(now, spent),
    };
  }

  #accessView(now: EpochMs, spentMicro: AccessView["spentMicro"]): AccessView {
    const k = this.#store.key();
    const plan = this.#plan(now);
    const lanes = accessOf({
      admitted: mayspend(this.#store.admission()),
      plan,
      box: this.#boxLane().state(),
      key: k,
      included: this.#deps.included,
    }).lanes.map((l) => l.kind);
    return {
      lanes,
      key: k && {
        provider: k.provider,
        model: k.model,
        hint: k.hint,
        mode: k.mode,
        sealedBytes: k.sealed.ciphertext.length,
        capMicro: k.capMicro,
        backup: k.backup,
        health: k.health.kind === "ok" ? "ok" : `resting:${k.health.fault}`,
      },
      spentMicro,
    };
  }

  /** Runs one model call for a group this person owns, on this person's access and limits. Groups arrive in week 3. */
  async serve(req: ServeRequest): Promise<Served<Purpose> | { readonly kind: "not_owner" }> {
    if (!this.#store.ownsGroup(req.group, req.ownershipVersion)) return { kind: "not_owner" };
    const plan = await this.#planNow(this.#agent().key, this.#deps.clock.now());
    if (plan.kind === "lapsed") return { kind: "no_access", why: "nothing", told: false };
    return this.#access().call({ purpose: req.purpose, system: req.system, prompt: req.prompt, plan });
  }

  /** Records that this person owns `group` at `version`; the group DO that week 3 adds is its only caller. */
  async recordGroup(group: AgentKey, version: number): Promise<void> {
    this.#store.recordGroup(group, version);
  }

  /** The operator takes this person out of the beta: their wake-ups are skipped and every message gets a fixed reply. */
  async remove(): Promise<void> {
    const now = this.#deps.clock.now();
    this.#store.remove(now);
    await this.#armNoLaterThan(now);
  }

  withDeps(over: Partial<AgentDeps>): void {
    if (loadConfig(this.env).model.backend !== "scripted") throw new Error("withDeps is test-only");
    this.#deps = { ...this.#deps, ...over };
  }

  /**
   * Dev only: this person gets a dev lane whose next turns and compactions return these outputs, so a `wrangler dev`
   * run can prove model-driven paths without a model. Until a script is posted, a dev person has no access at all.
   */
  script(turns: readonly unknown[], compaction: readonly unknown[]): void {
    const output = (value: unknown): ScriptStep => ({ kind: "output", value });
    const model = scripted(turns.map(output), { compaction: compaction.map(output) });
    this.withDeps({ connect: scriptedConnect(model, this.#deps.connect), included: devLane(DEV_URL_SCRIPTED) });
  }

  async #runDrain(): Promise<void> {
    const clock = this.#deps.clock;
    const started = clock.now();
    try {
      await this.#phase("turns", async () => {
        const poisoned = this.#store.recover(started, this.#instance);
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
    if (!a || this.#store.channelEventWaiting()) return;
    const status = this.#store.admission().state === "removed" ? "blocked" : a.status;
    for (const firing of planFiring(now, a.tz, status, a.checkinLocal, this.#store.dueWakeups(now))) {
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
      language: a.language,
      status: a.status,
      statusAt: a.statusAt,
      checkinLocal: a.checkinLocal,
      admission: this.#store.admission(),
      batch,
      ...this.#store.turnContext(COMPACTION.promptTurns, TURN.recentNotes, batch),
      unaskedLeftToday: Math.max(0, OUTREACH.dailyUnaskedBudget - admitted),
    };
  }

  async #turn(batch: Batch): Promise<void> {
    const a = this.#agent();
    const view = this.#view(batch, a);
    const bypass = bypassModel(view);
    if (bypass) return this.#commit(planWithoutModel(view, bypass), view, a.key, { kind: "none" });
    if (!mayspend(view.admission)) return this.#admission(view, a);
    const first = batch.items[0].event;
    if (first.kind === "choice" && first.choice.kind === "consent") {
      return this.#commit(planWithoutModel(view, { kind: "ignored" }), view, a.key, { kind: "none" });
    }
    const command = commandOf(first);
    if (command) return this.#command(command, view, a.key);
    const plan = await this.#planNow(a.key, view.now);
    if (plan.kind === "lapsed") {
      const alreadyToldToday = this.#store.toldToday("lapsed", startOfLocalDay(view.now, view.tz));
      return this.#commit(planWithoutModel(view, { kind: "lapsed", alreadyToldToday }), view, a.key, { kind: "none" });
    }

    const served = await this.#access().call({ purpose: "turn", system: TURN_SYSTEM, prompt: renderUser(view), plan });
    switch (served.kind) {
      case "ok":
        return this.#commit(planTurn(served.value, view), view, a.key, { kind: "served", costMicro: served.call.costMicro });
      case "failed":
        return this.#commit(planWithoutModel(view, { kind: "model_failed" }), view, a.key, { kind: "served", costMicro: served.call.costMicro });
      case "over_cap": {
        const alreadyToldToday = this.#store.toldToday("refused_budget", startOfLocalDay(view.now, view.tz));
        const capUsd = usd(this.#store.key()?.capMicro ?? (0 as MicroUsd));
        return this.#commit(planWithoutModel(view, { kind: "over_cap", scope: served.scope, capUsd, alreadyToldToday }), view, a.key, { kind: "none" });
      }
      case "no_access": {
        const alreadyToldToday = served.told || this.#store.toldToday("no_access", startOfLocalDay(view.now, view.tz));
        const text = served.why === "box_not_ready" ? NOTICES[view.language].boxNotReady : this.#onboarding(view.language, plan, a.key);
        return this.#commit(planWithoutModel(view, { kind: "no_access", text, alreadyToldToday }), view, a.key, { kind: "none" });
      }
      case "unavailable":
        return this.#modelUnavailable(view, a.key);
      default:
        return assertNever(served);
    }
  }

  /** What someone with no access is offered: only what this deploy can give them. */
  #onboarding(lang: Language, plan: Plan, agent: AgentKey): string {
    const box = boxServes(this.#deps.box, agent) && planAllowsBox(plan.kind);
    const included = this.#deps.included.on && this.#deps.included.who === "plan" && this.#deps.billing.config.on;
    return NOTICES[lang].noAccess({ box, key: this.#deps.keys.on, included });
  }

  #access(): ModelAccess {
    return new ModelAccess({
      store: this.#store,
      connect: this.#deps.connect,
      box: this.#boxLane(),
      keys: this.#deps.keys,
      included: this.#deps.included,
      clock: this.#deps.clock,
      instance: this.#instance,
    });
  }

  #boxLane(): BoxLane {
    return {
      state: () => {
        const box = this.#store.box();
        const a = this.#store.agent();
        return box && a && boxServes(this.#deps.box, a.key) ? box.state : null;
      },
      parse: (req) => this.#parseOnBox(req),
    };
  }

  #commit(commit: TurnCommit, view: TurnView, agent: AgentKey, call: TurnCall, box: Box | null = null): void {
    const now = this.#deps.clock.now();
    this.#store.commitTurn(commit, logsForTurn({ agent, commit, view, call, startedAt: view.now, now }), now, box);
  }

  /**
   * Everything for someone not admitted runs here, and nothing here spends: a code is checked in D1, the seat is
   * claimed at consent, and every reply goes out only on the reply token.
   */
  async #admission(view: TurnView, a: AgentRow): Promise<void> {
    if (this.#deps.admission === "open") {
      const now = this.#deps.clock.now();
      const admitted = { next: { state: "admitted", seat: STAFF, at: now }, change: "consented", ensureCheckin: checkinWakeup(now, a.tz, a.checkinLocal) } as const;
      this.#commit(planWithoutModel(view, { kind: "admission", commit: admitted, text: null, consent: false }), view, a.key, { kind: "none" });
      return;
    }
    let step: AdmissionStep = planAdmission(view, null);
    if (step.kind !== "commit") {
      const now = this.#deps.clock.now();
      let answer: AdmissionAnswer;
      try {
        answer =
          step.kind === "check"
            ? { kind: "checked", check: await this.#deps.ledger.checkInvite({ code: step.code, agent: a.key, caps: ADMISSION.caps }) }
            : { kind: "claimed", seat: await this.#deps.ledger.claimSeat({ agent: a.key, code: step.code, channel: a.identity.channel, at: now, caps: ADMISSION.caps }) };
      } catch (err) {
        console.warn("admission check failed", err);
        return this.#admissionUnavailable(view, a.key);
      }
      step = planAdmission(view, answer);
      if (step.kind !== "commit") throw new Error(`planAdmission asked D1 twice: ${step.kind}`);
    }
    const why = { kind: "admission", commit: step.commit, text: step.text, consent: step.consent } as const;
    this.#commit(planWithoutModel(view, why), view, a.key, { kind: "none" });
  }

  /** D1 is out: retry on the model's backoff, then say to try again, changing nothing. */
  #admissionUnavailable(view: TurnView, agent: AgentKey): void {
    const now = this.#deps.clock.now();
    const attempts = Math.max(...view.batch.items.map((i) => i.attempts));
    if (attempts >= TURN.maxModelAttempts) {
      const unchanged = { next: view.admission, change: null, ensureCheckin: null };
      const why = { kind: "admission", commit: unchanged, text: NOTICES[view.language].billingBusy, consent: false } as const;
      return this.#commit(planWithoutModel(view, why), view, agent, { kind: "none" });
    }
    const keys = view.batch.items.map((i) => i.key);
    this.#store.releaseBatch(keys, (now + MODEL_RETRY_BASE_MS * 2 ** (attempts - 1)) as EpochMs, [], now);
  }

  async #command(command: Command, view: TurnView, agent: AgentKey): Promise<void> {
    if (this.#deps.admission === "beta" && (command.kind === "invite" || command.kind === "join")) return this.#betaCommand(command, view, agent);
    switch (command.kind) {
      case "claude":
        return this.#boxCommand(view, agent);
      case "plan":
      case "invite":
      case "join":
      case "leave": {
        const t = NOTICES[view.language];
        if (!this.#deps.billing.config.on && command.kind !== "plan") return this.#reply(view, agent, t.billingOff);
        let reply: { readonly text: string; readonly note: string };
        try {
          reply = await this.#billingCommand(command, view, agent);
        } catch (err) {
          console.warn("billing command failed", command.kind, err);
          reply = { text: t.billingBusy, note: t.billingBusy };
        }
        return this.#reply(view, agent, reply.text, reply.note);
      }
      default:
        return assertNever(command);
    }
  }

  /** The beta's two commands. Joining is admission's job, so someone already in is told so without asking D1. */
  async #betaCommand(command: Extract<Command, { kind: "invite" | "join" }>, view: TurnView, agent: AgentKey): Promise<void> {
    const t = NOTICES[view.language];
    if (command.kind === "join") return this.#reply(view, agent, t.alreadyIn);
    const now = this.#deps.clock.now();
    try {
      for (let tries = 0; tries < 3; tries++) {
        const code = newInviteCode();
        const r = await this.#deps.ledger.issueInvite({ issuer: agent, code, at: now, max: ADMISSION.invitesPerPerson });
        if (r === "issued") return this.#reply(view, agent, t.betaInvite(code), t.betaInvite("<code>"));
        if (r === "limit") return this.#reply(view, agent, t.inviteLimit(ADMISSION.invitesPerPerson));
        if (r === "not_enrolled") return this.#reply(view, agent, t.inviteNotEnrolled);
      }
    } catch (err) {
      console.warn("invite failed", err);
    }
    return this.#reply(view, agent, t.billingBusy);
  }

  #reply(view: TurnView, agent: AgentKey, text: string, note: string = text): void {
    this.#commit(planWithoutModel(view, { kind: "command", text, note }), view, agent, { kind: "none" });
  }

  async #standingNow(agent: AgentKey): Promise<{ readonly plan: Plan; readonly standing: Standing }> {
    const { config, store } = this.#deps.billing;
    const now = this.#deps.clock.now();
    const standing = config.on ? await store.standing(agent, now) : NO_STANDING;
    this.#store.applyStanding(standing, null, now);
    return { plan: this.#plan(now), standing };
  }

  async #billingCommand(
    command: Extract<Command, { kind: "plan" | "invite" | "join" | "leave" }>,
    view: TurnView,
    agent: AgentKey,
  ): Promise<{ readonly text: string; readonly note: string }> {
    const { config, store } = this.#deps.billing;
    const now = this.#deps.clock.now();
    const lang = view.language;
    const t = NOTICES[lang];
    const say = (text: string) => ({ text, note: text });
    switch (command.kind) {
      case "plan": {
        const { plan, standing } = await this.#standingNow(agent);
        const places = plan.kind === "plus" && plan.role === "owner" ? await store.places(agent, now) : null;
        const status = planStatus(plan, now, places, lang);
        if (config.on && standing.own) return this.#manageLink(status, standing.own.id, lang);
        if (!config.on || (plan.kind !== "trial" && plan.kind !== "lapsed")) return say(status);
        const links = await this.#checkoutLinks(agent, view.batch.items[0].key);
        if (!links) return say(`${status}\n${t.noLinks}`);
        const choices = planChoices(config.rules, offeredPlans(config.stripe), links, lang);
        return { text: `${status}\n${choices.text}`, note: `${status}\n${choices.note}` };
      }
      case "invite": {
        const code = newInviteCode();
        const r = await store.invite(agent, code, now, (now + INVITE_FOR_MS) as EpochMs);
        if (r.kind === "created") return { text: t.invite(code), note: t.invite("<code>") };
        return say(r.kind === "full" ? t.inviteFull(r.seats) : t.inviteNotOwner);
      }
      case "join": {
        const r = await store.join(command.code, agent, now);
        if (r === "joined") await this.#standingNow(agent);
        return say(t.join[r]);
      }
      case "leave": {
        const closed = await store.leave(agent, now);
        if (!closed && !this.#store.plan()?.seat) return say(t.notSeated);
        const { plan } = await this.#standingNow(agent);
        return say(`${t.left}\n${plan.kind === "lapsed" ? t.lapsed : planStatus(plan, now, null, lang)}`);
      }
      default:
        return assertNever(command);
    }
  }

  async #manageLink(status: string, id: SubscriptionId, lang: Language): Promise<{ readonly text: string; readonly note: string }> {
    const t = NOTICES[lang];
    const { store, stripe } = this.#deps.billing;
    const customer = await store.customer(id);
    const portal = stripe && customer ? await stripe.portal(customer) : null;
    if (!portal?.ok) {
      console.warn("portal link failed", id, portal ? portal.detail : "no customer");
      return { text: `${status}\n${t.noPortal}`, note: `${status}\n${t.noPortal}` };
    }
    return { text: `${status}\n${t.manage(portal.value.url)}`, note: `${status}\n${t.manage(MANAGE_NOTE)}` };
  }

  /**
   * Sessions an earlier /plan handed out are expired first, so at most one set can be paid. A retried turn
   * gets its own sessions back from the idempotency key, so those are left open.
   */
  async #checkoutLinks(agent: AgentKey, key: EventKey): Promise<Links | null> {
    const stripe = this.#deps.billing.stripe;
    if (!stripe) return null;
    const stale = this.#store.openCheckouts().filter((c) => c.eventKey !== key);
    const expiries = await Promise.all(stale.map(async (c) => ({ id: c.id, result: await stripe.expireCheckout(c.id) })));
    let expired = true;
    for (const { id, result } of expiries) {
      if (result.ok) this.#store.checkoutClosed(id);
      else {
        console.warn("checkout expiry failed", id, result.detail);
        expired = false;
      }
    }
    if (!expired) return null;

    const plans = this.#deps.billing.config.on ? offeredPlans(this.#deps.billing.config.stripe) : [];
    const results = await Promise.all(
      plans.map(async (plan) => ({ plan, result: await stripe.checkout({ agent, plan, idempotencyKey: `${agent}|${key}|${plan}` }) })),
    );
    const now = this.#deps.clock.now();
    const links: Partial<Record<PaidPlan, string>> = {};
    for (const { plan, result } of results) {
      if (!result.ok) {
        console.warn("checkout failed", plan, result.detail);
        continue;
      }
      this.#store.checkoutOpened(result.value.id, key, now);
      links[plan] = result.value.url;
    }
    return plans.every((p) => links[p]) ? links : null;
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
      return this.#boxReply(view, agent, null, { box: null, say: "busy" });
    }
    if (claim === "full") return this.#boxReply(view, agent, deps, { box: null, say: "full" });
    return this.#boxReply(view, agent, deps, { box: newBox(name, deps.host.kind, deps.host.urlOf(name), deps.host.image, now), say: "setting_up" });
  }

  async #boxReply(view: TurnView, agent: AgentKey, deps: BoxDeps | null, t: { readonly box: Box | null; readonly say: BoxSay }): Promise<void> {
    const message = deps && t.box ? await this.#boxMessage(deps, t.box, t.say) : boxMessage(t.say, view.language, null);
    const commit = planWithoutModel(view, { kind: "command", text: message.text, note: message.note });
    this.#commit(commit, view, agent, { kind: "none" }, t.box);
  }

  async #boxMessage(deps: BoxDeps, box: Box, say: BoxSay): Promise<{ readonly text: string; readonly note: string }> {
    const a = this.#agent();
    if (say === "retiring" && box.retireAt !== null) return boxMessage(say, a.language, null, longDate(box.retireAt, a.tz, a.language));
    if (!needsLink(say)) return boxMessage(say, a.language, null);
    const exp = (this.#deps.clock.now() + BOX.ticketForMs) as EpochMs;
    const ticket = await signinTicket(await boxToken(deps.secret, box.name), exp);
    return boxMessage(say, a.language, signinUrl(box.url, ticket));
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
    const m = goneMessage(step.box, this.#agent().language);
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

  /** The box lane: the person's own plan pays, so nothing is reserved. A box that can't answer moves the call on. */
  async #parseOnBox(req: Parameters<BoxLane["parse"]>[0]): Promise<BoxAnswer> {
    const deps = this.#deps.box;
    const box = this.#store.box();
    const agent = this.#agent().key;
    if (!boxServes(deps, agent) || box?.state !== "signed_in") return { kind: "moved_on", transient: false, told: false };
    if (this.#deps.clock.now() < this.#skipBoxUntil) return { kind: "moved_on", transient: true, told: false };
    const res = await deps.client.parse(box.url, await boxToken(deps.secret, box.name), { model: req.model, system: req.system, user: req.user, jsonSchema: req.jsonSchema });
    const now = this.#deps.clock.now();
    const missed = (status: "rejected" | "unavailable"): LogRow =>
      modelCallRow({ id: crypto.randomUUID(), agent, purpose: req.purpose, model: `claude-plan:${req.model}`, backend: "box", status, estimate: NO_COST, cost: NO_COST, usage: null, at: now });
    switch (res.kind) {
      case "reply":
        return { kind: "reply", reply: res.reply };
      case "signed_out": {
        const t = onSignedOut(box, now);
        this.#store.applyBox(t.box, await this.#outboxMessage(deps, t.box, t.say), [missed("rejected")], now);
        return { kind: "moved_on", transient: false, told: true };
      }
      case "unauthorized":
        this.#store.applyBox(needsEnsure(box, now), null, [missed("rejected")], now);
        return { kind: "moved_on", transient: true, told: false };
      case "unavailable":
        console.warn("box unavailable", res.detail);
        this.#skipBoxUntil = now + BOX.skipAfterUnavailableMs;
        this.#store.appendLogs([missed("unavailable")], now);
        return { kind: "moved_on", transient: true, told: false };
      default:
        return assertNever(res);
    }
  }

  #commitPoison(batch: Batch): void {
    const a = this.#agent();
    const view = this.#view(batch, a);
    this.#commit(planWithoutModel(view, { kind: "poison" }), view, a.key, { kind: "none" });
  }

  #modelUnavailable(view: TurnView, agent: AgentKey): void {
    const now = this.#deps.clock.now();
    const attempts = Math.max(...view.batch.items.map((i) => i.attempts));
    const requested = intentOf(view.batch.items[0].event) === "requested";
    if (attempts >= (requested ? TURN.maxRequestedModelAttempts : TURN.maxModelAttempts)) {
      return this.#commit(planWithoutModel(view, { kind: "model_failed" }), view, agent, { kind: "none" });
    }
    const keys = view.batch.items.map((i) => i.key);
    this.#store.releaseBatch(keys, (now + MODEL_RETRY_BASE_MS * 2 ** (attempts - 1)) as EpochMs, [], now);
  }

  async #deliverReady(): Promise<void> {
    for (const row of this.#store.readyOutbox(this.#deps.clock.now(), DELIVERY_BATCH)) await this.#deliver(row);
  }

  async #deliver(row: OutboxRow): Promise<void> {
    const now = this.#deps.clock.now();
    const a = this.#agent();
    const unaskedLog = (status: UnaskedStatus, day: OutboxRow["admittedDay"]): LogRow[] =>
      row.intent === "unasked"
        ? [
            {
              stream: "unasked",
              id: row.id,
              agent: a.key,
              triggerKind: row.triggerKind,
              text: row.texts.join("\n"),
              status,
              day,
              at: now,
              taskId: row.taskId === null ? null : globalTaskId(a.key, row.taskId),
              purpose: row.purpose ?? "unlinked",
            },
          ]
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
        inQuotaReserve: row.to.channel === "line" && inLineReserve(await this.#lineQuota(), now),
      });
      switch (verdict.verdict) {
        case "defer":
          return this.#store.reschedule(row.id, verdict.until);
        case "drop":
          return this.#store.drop(row.id, verdict.reason, now, unaskedLog(DROPPED[verdict.reason], null));
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

  /** An unreadable reading holds nothing back: the reserve is a margin, and the person's message matters more. */
  async #lineQuota(): Promise<QuotaReading | null> {
    try {
      return await this.#deps.ledger.lineQuota();
    } catch (err) {
      console.warn("LINE quota reading unavailable", err);
      return null;
    }
  }

  async #compactIfDue(): Promise<void> {
    const a = this.#store.agent();
    if (!a || !mayspend(this.#store.admission()) || this.#store.compactionRetryAt() > this.#deps.clock.now()) return;
    const person = this.#plan(this.#deps.clock.now());
    if (person.kind === "lapsed") return;
    const plan = planCompaction(this.#store.compactionInput(), PROMPT_FLOOR_BYTES.compaction - new TextEncoder().encode(COMPACTION_SYSTEM).length);
    if (!plan) return;
    let served: Served<"compaction">;
    try {
      served = await this.#access().call({ purpose: "compaction", system: COMPACTION_SYSTEM, prompt: plan.prompt, plan: person });
    } catch (err) {
      this.#store.compactionFailed(this.#deps.clock.now());
      throw err;
    }
    const now = this.#deps.clock.now();
    if (served.kind === "ok") this.#store.commitCompaction(compactionCommit(plan, served.value), now);
    else if (served.kind !== "no_access") this.#store.compactionFailed(now);
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
    const fireTimes = a && !r.channelEventWaiting ? r.earliestWakeups.map((w) => fireAt(w, a.tz)) : [];
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

const DROPPED: Readonly<Record<Extract<UnaskedVerdict, { verdict: "drop" }>["reason"], UnaskedStatus>> = {
  budget: "dropped_budget",
  blocked: "dropped_blocked",
  quota: "dropped_quota",
};

const usd = (micro: MicroUsd): string => (micro / 1_000_000).toFixed(2);

function longDate(t: EpochMs, tz: TimeZone, lang: Language): string {
  return new Intl.DateTimeFormat(NOTICES[lang].dateLocale, { day: "numeric", month: "long", year: "numeric", timeZone: tz }).format(t);
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
    connect: connect((input, init) => fetch(input, init)),
    keys: config.keys,
    included: config.included,
    ledger: d1Ledger(env.LEDGER),
    channels: makeChannels(config),
    clock: { now: () => Date.now() as EpochMs },
    box: boxDeps(config.box),
    billing: {
      config: config.billing,
      store: d1Billing(env.LEDGER),
      stripe: config.billing.on ? stripeApi(config.billing.stripe, config.billing.rules, (input, init) => fetch(input, init)) : null,
    },
    admission: config.admission,
  };
}
