import { diagnostic, type DrainPhase } from "../diagnostics";
import { DurableObject } from "cloudflare:workers";
import { draftKey, issueTicket, redactSecrets, seal, type KeyFields } from "../access/key";
import {
  accessOf,
  devLane,
  DEV_URL_SCRIPTED,
  ModelAccess,
  type BoxAnswer,
  type BoxLane,
  type IncludedConfig,
  type KeysConfig,
  type Served,
} from "../access/access";
import { NO_STANDING, planAllowsBox, planOf, trialEnd, type PaidPlan, type Plan, type Standing, type SubscriptionId } from "../billing/plan";
import { INVITE_FOR_MS, MANAGE_NOTE, planChanged, planChoices, planStatus, type Links } from "../billing/say";
import { d1Billing, type BillingStore } from "../billing/store";
import { offeredPlans, parseSubscription, stripeApi, type BillingEvent, type StripeApi } from "../billing/stripe";
import { boxClient, type BoxAt, type BoxClient, type BoxReply } from "../box/client";
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
  onRemove,
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
import { loadConfig, OWN_CAP_RANGE_USD, type BillingConfig, type BoxConfig, type Env } from "../config";
import {
  assertNever,
  CHANNEL_LANGUAGE,
  choiceToken,
  eventKey,
  intentOf,
  mayspend,
  newInviteCode,
  type Admission,
  type AgentKey,
  type EpochMs,
  type EventKey,
  type ForgetEpoch,
  type InboundEnvelope,
  type InviteCode,
  type Language,
  type MicroUsd,
  type PersonStatus,
  type Seat,
  type TimeZone,
  type WakeupKey,
} from "../domain";
import { d1Ledger, modelCallRow, type Ledger, type LogRow, type UnaskedStatus } from "../ledger/ledger";
import { NOTICES, type KeyPageError } from "../notices";
import { scripted, scriptedConnect, type ScriptedModel, type ScriptStep } from "../model/scripted";
import { connect, type Connect } from "../model/client";
import { bytesOf, renderPrompt, type PromptParts } from "../model/prompt";
import { PROVIDERS } from "../model/providers";
import { routeFor, type CallPurpose, type Purpose } from "../model/routes";
import { admitUnasked, OUTREACH, type UnaskedVerdict } from "../policy/outreach";
import { inLineReserve, type QuotaReading } from "../policy/quota";
import { checkinWakeup, fireAt, nextAlarm, planFiring, SCHEDULE, type PendingWakeup } from "../policy/schedule";
import { DEFAULT_TIME_ZONE, localDate, startOfLocalDay, utcMonth } from "../policy/time";
import { ADMISSION, planAdmission, type AdmissionAnswer, type AdmissionMode, type AdmissionStep } from "./admission";
import { COMPACTION, compactionCommit, planCompaction } from "./compaction";
import { COMPACTION_SYSTEM, TURN_SYSTEM } from "./prompt";
import type { Claim, ProviderOrder } from "./forget";
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
  memoryHeldAfter,
  planTurn,
  planWithoutModel,
  renderBoxTurn,
  renderUser,
  TURN,
  type Batch,
  type BoxSessionSeen,
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
const KEY_TICKET_MS = 15 * 60_000;
const KEY_LINK_NOTE = "<key link>";

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
  readonly connect: Connect;
  readonly keys: KeysConfig;
  readonly included: IncludedConfig;
  readonly ledger: Ledger;
  readonly channels: ChannelRegistry;
  readonly clock: Clock;
  readonly box: BoxDeps | null;
  readonly billing: BillingDeps;
  readonly admission: AdmissionMode;
  readonly privacyUrl: string;
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

export type ConnectResult = { readonly ok: true; readonly provider: string; readonly model: string } | { readonly ok: false; readonly error: KeyPageError };

type CatchUpAccess = { readonly plan: Plan; readonly budget: string };

export type AccessView = {
  readonly lanes: readonly ("box" | "key" | "included")[];
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
  /** Newest first. */
  readonly memoryNotes: readonly string[];
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
  readonly #instance = crypto.randomUUID();
  readonly #devSavedPages = new Map<string, string>();
  #devModel: ScriptedModel | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#store = new AgentStore(ctx.storage);
    void ctx.blockConcurrencyWhile(async () => migrate(ctx.storage));
    this.#deps = defaultDeps(env);
  }

  /** "stale": the person's last forget already covers this event, so nothing of it was stored. */
  async enqueue(given: InboundEnvelope): Promise<"queued" | "duplicate" | "stale"> {
    const now = this.#deps.clock.now();
    const envelope = withoutSecrets(given);
    const first = {
      tz: DEFAULT_TIME_ZONE,
      language: envelope.initialLanguage ?? CHANNEL_LANGUAGE[envelope.identity.channel],
      checkinLocal: SCHEDULE.defaultCheckinLocal,
      checkin: checkinWakeup(now, DEFAULT_TIME_ZONE, SCHEDULE.defaultCheckinLocal),
      trialEndsAt: this.#deps.billing.config.on ? trialEnd(now, this.#deps.billing.config.rules) : null,
      admit: this.#deps.admission === "open" || envelope.identity.channel === "dev" ? STAFF : null,
    };
    const stored = this.#store.enqueue(envelope, first, now);
    if (stored !== "inserted") return stored;
    await this.#armNoLaterThan(now);
    this.ctx.waitUntil(this.alarm());
    return "queued";
  }

  billingEvent(e: BillingEvent): Promise<"applied" | "duplicate" | "ignored"> {
    const run = this.#billing.then(() => this.#billingEvent(e)).catch(() => {
      throw new Error("billing event failed");
    });
    this.#billing = run.catch(() => undefined);
    return run;
  }

  async #billingEvent(e: BillingEvent): Promise<"applied" | "duplicate" | "ignored"> {
    if (this.#store.billingEventSeen(e.id)) return "duplicate";
    const { config, store, stripe } = this.#deps.billing;
    if (!config.on || !stripe) throw new Error("a Stripe event reached a DO with billing off");
    const fetched = await stripe.subscription(e.subscription);
    if (!fetched.ok) throw new Error("subscription read failed");
    const read = parseSubscription(fetched.value, config.rules);
    if (read.kind === "invalid") throw new Error("subscription unreadable");
    if (read.kind === "not_ours" || read.subscription.owner !== e.owner) {
      diagnostic("stripe_event_ignored");
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
    diagnostic("stripe_duplicate_subscription");
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
    const standing = await store.standing(agent, now).catch(() => {
      throw new Error("billing standing unavailable");
    });
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
    } catch {
      diagnostic("stripe_standing_unavailable");
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
      outbox: this.#store.recentOutbox(50).map((row) => {
        const page = this.#devSavedPages.get(row.id);
        return page === undefined ? row : { ...row, texts: [page] };
      }),
      pendingWakeups: this.#store.pendingWakeups(),
      memoryNotes: this.#store.memoryNotes(20),
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
      claudePlan: this.#store.claudePlan(),
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

  async serve(req: ServeRequest): Promise<Served<Purpose> | { readonly kind: "not_owner" }> {
    if (!this.#store.ownsGroup(req.group, req.ownershipVersion)) return { kind: "not_owner" };
    const refused = { kind: "no_access", why: "nothing", told: false, notice: null, waitForConnection: false } as const;
    const claim = this.#store.claim();
    if (!claim) return refused;
    const plan = await this.#planNow(this.#agent().key, this.#deps.clock.now());
    if (plan.kind === "lapsed") return refused;
    return this.#access().call({ purpose: req.purpose, system: req.system, prompt: req.prompt, plan, claim });
  }

  /**
   * The key page's submission. The ticket moves to validating before any provider call, so a repeat submission gets the
   * stored outcome instead of a second probe, and the save is refused if the access revision moved since the link went out.
   */
  async connectKey(nonceHash: string, fields: KeyFields): Promise<ConnectResult> {
    const now = this.#deps.clock.now();
    const keys = this.#deps.keys;
    const t = this.#store.ticket(nonceHash);
    const a = this.#store.agent();
    if (!keys.on || !a || !t || t.expiresAt <= now || !mayspend(this.#store.admission())) return { ok: false, error: "expired" };
    if (t.status === "validating") return { ok: false, error: "busy" };
    if (t.status !== "issued") return this.#storedOutcome(t.outcome);
    const draft = draftKey(fields, { devMode: loadConfig(this.env).devMode });
    if (!draft.ok) return draft;
    if (!this.#store.startValidating(nonceHash, now)) return { ok: false, error: "busy" };
    const existing = this.#store.key();
    const capMicro = existing?.capMicro ?? keys.defaultCapMicro;
    const probe = await this.#access().probe(draft.value, capMicro);
    const after = this.#deps.clock.now();
    if (!probe.ok) {
      this.#store.finishTicket(nonceHash, "failed", probe.error);
      return probe;
    }
    const d = draft.value;
    const label = PROVIDERS[d.provider].label;
    const text = NOTICES[a.language].keyConnected(label, d.model);
    const sealed = await seal(keys.secrets.current, a.key, d);
    const saved = this.#store.saveKey(
      { provider: d.provider, baseUrl: d.baseUrl, model: d.model, auth: d.auth, mode: probe.mode, sealed, hint: d.key.hint, capMicro, connectedAt: after },
      t.revision,
      { key: eventKey.access(`connected:${after}`), message: { texts: [text], note: text } },
      [],
      after,
      nonceHash,
    );
    if (!saved) {
      this.#store.finishTicket(nonceHash, "failed", "superseded");
      return { ok: false, error: "superseded" };
    }
    this.#askBackupIfDue(after);
    await this.#armNoLaterThan(after);
    this.ctx.waitUntil(this.alarm());
    return { ok: true, provider: label, model: d.model };
  }

  #storedOutcome(outcome: string | null): ConnectResult {
    if (outcome === "saved") {
      const k = this.#store.key();
      return k ? { ok: true, provider: PROVIDERS[k.provider].label, model: k.model } : { ok: false, error: "used" };
    }
    return { ok: false, error: (outcome as KeyPageError | null) ?? "used" };
  }

  async #keyLink(lang: Language): Promise<string | null> {
    const keys = this.#deps.keys;
    if (!keys.on) return null;
    const now = this.#deps.clock.now();
    const t = await issueTicket(keys.secrets.current, this.ctx.id.toString(), (now + KEY_TICKET_MS) as EpochMs);
    this.#store.issueTicket(t.nonceHash, t.expiresAt, now);
    return `${keys.publicUrl}/key#t=${t.token}&l=${lang}`;
  }

  /** `again`: the plan's box was just reclaimed, so a key that wasn't a backup is asked about once more. */
  #askBackupIfDue(now: EpochMs, again: boolean = false): void {
    const k = this.#store.key();
    const a = this.#store.agent();
    if (!k || k.backup || (k.backupAskedAt !== null && !again) || !a || !this.#store.claudePlan()) return;
    const text = NOTICES[a.language].backupAsk(PROVIDERS[k.provider].label);
    this.#store.askBackup({ texts: [text], note: text }, choiceToken({ kind: "backup", revision: k.revision }), eventKey.access(`backup:${now}`), now, k.revision, again);
  }

  async recordGroup(group: AgentKey, version: number): Promise<void> {
    this.#store.recordGroup(group, version);
  }

  /** The operator takes this person out of the beta: their wake-ups are skipped and every message gets a fixed reply. */
  async remove(): Promise<void> {
    const now = this.#deps.clock.now();
    this.#store.remove(now);
    await this.#armNoLaterThan(now);
  }

  /**
   * Opens a forget at `trigger`, the place in the provider's order of the request that asked for it. From here until
   * `endForget` with the same `op`, nothing ordinary runs, and nothing begun before it may send, save or call out.
   */
  async beginForget(trigger: ProviderOrder): Promise<{ readonly op: string; readonly epoch: ForgetEpoch }> {
    return this.#store.beginForget(trigger, this.#deps.clock.now());
  }

  async endForget(op: string): Promise<boolean> {
    const now = this.#deps.clock.now();
    if (!this.#store.endForget(op)) return false;
    await this.#armNoLaterThan(now);
    this.ctx.waitUntil(this.alarm());
    return true;
  }

  /** Dev only: the pending wake-up `key` falls due now and fires through the alarm, as it would at its time. */
  async fireNow(key: WakeupKey): Promise<boolean> {
    const now = this.#deps.clock.now();
    if (!this.#store.makeDue(key, now)) return false;
    await this.#armNoLaterThan(now);
    return true;
  }

  withDeps(over: Partial<AgentDeps>): void {
    if (loadConfig(this.env).model.backend !== "scripted") throw new Error("withDeps is test-only");
    this.#deps = { ...this.#deps, ...over };
  }

  /**
   * Dev only: this person gets a dev lane whose next turns and compactions return these outputs, so a `wrangler dev`
   * run can prove model-driven paths without a model. Until a script is posted, a dev person has no access at all. An
   * entry `{"hold": output}` stays in flight until `releaseScript`.
   */
  script(turns: readonly unknown[], compaction: readonly unknown[]): void {
    const output = (value: unknown): ScriptStep => ({ kind: "output", value });
    const step = (value: unknown): ScriptStep =>
      typeof value === "object" && value !== null && "hold" in value ? { kind: "hold", then: output(value.hold) } : output(value);
    const model = scripted(turns.map(step), { compaction: compaction.map(step) });
    this.#devModel = model;
    this.withDeps({ connect: scriptedConnect(model, this.#deps.connect), included: devLane(DEV_URL_SCRIPTED) });
  }

  releaseScript(): void {
    this.#devModel?.release();
  }

  async #runDrain(): Promise<void> {
    const clock = this.#deps.clock;
    const started = clock.now();
    try {
      await this.#phase("drain_turns_failed", async () => {
        if (this.#store.held()) return;
        const poisoned = this.#store.recover(started, this.#instance);
        if (poisoned) this.#commitPoison(poisoned);
        this.#fireDueWakeups();
        while (clock.now() - started < DRAIN_BUDGET_MS) {
          const now = clock.now();
          const catchUp = await this.#catchUpAccess(now);
          const claimed = this.#store.claimBatch(clock.now(), catchUp?.budget ?? null);
          if (!claimed) break;
          await this.#turn(claimed.batch, claimed.claim, catchUp?.plan ?? null);
          await this.#deliverReady();
          this.#fireDueWakeups();
        }
      });
      await this.#phase("drain_box_failed", () => this.#stepBox());
      await this.#phase("drain_delivery_failed", () => this.#deliverReady());
      await this.#phase("drain_log_flush_failed", () => this.#flushLogs());
      await this.#phase("drain_compaction_failed", () => this.#compactIfDue());
      await this.#phase("drain_prune_failed", async () => {
        if (!this.#store.held()) this.#store.prune(clock.now());
      });
    } finally {
      await this.#rearm();
    }
  }

  async #phase(name: DrainPhase, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch {
      // Not rethrown: our re-arm is the retry policy, not Cloudflare's alarm backoff.
      diagnostic(name);
    }
  }

  #fireDueWakeups(): void {
    const now = this.#deps.clock.now();
    const a = this.#store.agent();
    if (!a || this.#store.held() || this.#store.channelEventWaiting()) return;
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

  async #turn(batch: Batch, claim: Claim, catchUpPlan: Plan | null): Promise<void> {
    const a = this.#agent();
    const item = batch.items[0];
    const first = item.event;
    const command = commandOf(first);
    if (command?.kind === "memory" || command?.kind === "memory_next") {
      return this.#store.queueSavedPage({
        key: item.key, restart: command.kind === "memory", now: this.#deps.clock.now(),
        reply: first.kind === "message" ? first.reply : undefined,
        replyOnly: a.identity.channel === "line" && !mayspend(this.#store.admission()),
      });
    }
    const view = this.#view(batch, a);
    const bypass = bypassModel(view);
    if (bypass) return this.#commit(planWithoutModel(view, bypass), view, a.key, { kind: "none" });
    if (command?.kind === "key_remove") return this.#keyCommand(command, view, a.key);
    if (!mayspend(view.admission)) return this.#admission(view, a);
    if (first.kind === "choice" && first.choice.kind === "consent") {
      return this.#commit(planWithoutModel(view, { kind: "ignored" }), view, a.key, { kind: "none" });
    }
    if (first.kind === "choice" && first.choice.kind === "backup") return this.#backupTap(first.choice.revision, view, a.key);
    if (command) return this.#command(command, view, a);
    const plan = (batch.items[0].catchUp ? catchUpPlan : null) ?? await this.#planNow(a.key, view.now);
    if (plan.kind === "lapsed") {
      const alreadyToldToday = this.#store.toldToday("lapsed", startOfLocalDay(view.now, view.tz));
      return this.#commit(planWithoutModel(view, { kind: "lapsed", alreadyToldToday }), view, a.key, { kind: "none" });
    }

    const shown = await this.#historyThatFits(batch, a, view, plan, claim);
    const box = renderBoxTurn(shown, this.#store.boxSession());
    const access = this.#access();
    const catchUpBudget = batch.items[0].catchUp ? access.catchUpBudget(plan, this.#deps.clock.now()) ?? "unavailable" : null;
    const served = await access.call({ purpose: "turn", system: TURN_SYSTEM, prompt: renderUser(shown), plan, box, claim });
    const historyTrimmed = shown.historyLeftOut > 0 || ((served.kind === "ok" || served.kind === "failed") && served.trimmed);
    switch (served.kind) {
      case "ok": {
        const commit = planTurn(served.value, shown);
        const answered = served.call.box;
        const seen = answered ? { id: answered.session, sentThrough: box.sentThrough, memory: memoryHeldAfter(shown, commit) } : null;
        return this.#commit(commit, shown, a.key, { kind: "served", costMicro: served.call.costMicro, historyTrimmed }, null, [], seen);
      }
      case "failed":
        return this.#commit(planWithoutModel(shown, { kind: "model_failed" }), shown, a.key, { kind: "served", costMicro: served.call.costMicro, historyTrimmed });
      case "too_long":
        return this.#commit(planWithoutModel(shown, { kind: "too_long" }), shown, a.key, { kind: "none" });
      case "over_cap": {
        const alreadyToldToday = this.#store.toldToday("refused_budget", startOfLocalDay(view.now, view.tz));
        const capUsd = usd(this.#store.key()?.capMicro ?? (0 as MicroUsd));
        return this.#commit(planWithoutModel(view, { kind: "over_cap", scope: served.scope, capUsd, alreadyToldToday, catchUpBudget }), view, a.key, { kind: "none" });
      }
      case "no_access": {
        const waitForConnection = first.kind === "message" && (served.waitForConnection || batch.items[0].catchUp !== undefined);
        const notices = NOTICES[view.language];
        const signedOutWithRequest = waitForConnection && this.#boxLane().state() === "signed_out";
        const offer = served.why === "box_not_ready"
          ? (signedOutWithRequest ? notices.boxSignedOut : notices.boxNotReady)
          : this.#onboarding(view.language, plan, a.key);
        const text = served.notice ?? offer;
        const alreadyToldToday = served.told || (served.notice === null && this.#store.toldToday("no_access", startOfLocalDay(view.now, view.tz)));
        return this.#commit(planWithoutModel(view, { kind: "no_access", text, alreadyToldToday, waitForConnection }), view, a.key, { kind: "none" });
      }
      case "unavailable":
        return this.#modelUnavailable(view, a.key);
      case "fenced":
        return;
      default:
        return assertNever(served);
    }
  }

  /**
   * When the history not yet in the summary doesn't fit the smallest budget among the person's lanes, one compaction
   * step runs first, in this drain. If compaction is backing off or fails, the turn shows the newest history that fits.
   */
  async #historyThatFits(batch: Batch, a: AgentRow, view: TurnView, plan: Plan, claim: Claim): Promise<TurnView> {
    const budget = this.#access().budget("turn", TURN_SYSTEM, plan);
    const fits = view.historyLeftOut === 0 && bytesOf(renderPrompt(renderUser(view))) <= (budget ?? Infinity);
    if (fits || view.recent.length === 0) return view;
    try {
      if (!(await this.#compactStep(plan, true, claim))) return view;
    } catch {
      diagnostic("turn_compaction_failed");
      return view;
    }
    return this.#view(batch, a);
  }

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

  async #catchUpAccess(now: EpochMs): Promise<CatchUpAccess | null> {
    if (this.#store.held() || !this.#store.hasWaitingRequests(now)) return null;
    const a = this.#store.agent();
    if (a?.status !== "active") return null;
    const plan = await this.#planNow(a.key, now);
    const budget = this.#access().catchUpBudget(plan, now);
    return budget !== null && this.#store.hasWaitingRequests(now, budget) ? { plan, budget } : null;
  }

  #boxLane(): BoxLane {
    return {
      state: () => {
        const box = this.#store.box();
        const a = this.#store.agent();
        return box && a && boxServes(this.#deps.box, a.key) ? box.state : null;
      },
      parse: (req, claim) =>
        this.#onBox(req.purpose, claim, (client, url, token, at) => client.parse(url, token, { model: req.model, system: req.system, user: req.user, jsonSchema: req.jsonSchema, at })),
      agent: (req, claim) => this.#onBox("turn", claim, (client, url, token, at) => client.agent(url, token, { ...req, at })),
    };
  }

  #commit(
    commit: TurnCommit,
    view: TurnView,
    agent: AgentKey,
    call: TurnCall,
    box: Box | null = null,
    extraLogs: readonly LogRow[] = [],
    seen: BoxSessionSeen | null = null,
  ): void {
    const now = this.#deps.clock.now();
    const logs = logsForTurn({ agent, commit, view, call, startedAt: view.now, now });
    this.#store.commitTurn(commit, logs.concat(extraLogs), now, box, seen);
  }

  async #admission(view: TurnView, a: AgentRow): Promise<void> {
    if (this.#deps.admission === "open") {
      const now = this.#deps.clock.now();
      const admitted = { next: { state: "admitted", seat: STAFF, at: now }, change: "consented", ensureCheckin: checkinWakeup(now, a.tz, a.checkinLocal) } as const;
      this.#commit(planWithoutModel(view, { kind: "admission", commit: admitted, text: null, consent: false }), view, a.key, { kind: "none" });
      return;
    }
    const admission = { ...view, privacyUrl: this.#deps.privacyUrl };
    let step: AdmissionStep = planAdmission(admission, null);
    if (step.kind !== "commit") {
      const now = this.#deps.clock.now();
      let answer: AdmissionAnswer;
      try {
        answer =
          step.kind === "check"
            ? { kind: "checked", check: await this.#deps.ledger.checkInvite({ code: step.code, agent: a.key, caps: ADMISSION.caps }) }
            : { kind: "claimed", seat: await this.#deps.ledger.claimSeat({ agent: a.key, code: step.code, channel: a.identity.channel, at: now, caps: ADMISSION.caps }) };
      } catch {
        diagnostic("admission_failed");
        return this.#admissionUnavailable(view, a.key);
      }
      step = planAdmission(admission, answer);
      if (step.kind !== "commit") throw new Error(`planAdmission asked D1 twice: ${step.kind}`);
    }
    const why = { kind: "admission", commit: step.commit, text: step.text, consent: step.consent } as const;
    this.#commit(planWithoutModel(view, why), view, a.key, { kind: "none" });
  }

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

  async #command(command: Exclude<Command, { kind: "memory" | "memory_next" }>, view: TurnView, a: AgentRow): Promise<void> {
    const agent = a.key;
    if (this.#deps.admission === "beta" && (command.kind === "invite" || command.kind === "join")) return this.#betaCommand(command, view, agent);
    switch (command.kind) {
      case "claude":
        return this.#boxCommand(view, agent);
      case "claude_remove":
        return this.#claudeRemove(view, agent);
      case "key":
      case "key_remove":
      case "key_cap":
      case "key_backup":
      case "pasted_key":
        return this.#keyCommand(command, view, agent);
      case "feedback":
        return this.#feedback(command.submitted, view, a);
      case "plan":
      case "invite":
      case "join":
      case "leave": {
        const t = NOTICES[view.language];
        if (!this.#deps.billing.config.on && command.kind !== "plan") return this.#reply(view, agent, t.billingOff);
        let reply: { readonly text: string; readonly note: string };
        try {
          reply = await this.#billingCommand(command, view, agent);
        } catch {
          diagnostic("billing_command_failed");
          reply = { text: t.billingBusy, note: t.billingBusy };
        }
        return this.#reply(view, agent, reply.text, reply.note);
      }
      default:
        return assertNever(command);
    }
  }

  #feedback(submitted: boolean, view: TurnView, a: AgentRow): void {
    const t = NOTICES[view.language];
    const item = view.batch.items[0];
    const logs: LogRow[] = submitted ? [
      {
        stream: "feedback",
        id: `${a.key}|${item.key}`,
        agent: a.key,
        channel: a.identity.channel,
        at: item.receivedAt,
        cohort: mayspend(view.admission) ? view.admission.seat.cohort : null,
      },
    ] : [];
    const commit = planWithoutModel(view, { kind: "feedback", text: submitted ? t.feedbackThanks : t.feedbackUsage });
    this.#commit(commit, view, a.key, { kind: "none" }, null, logs);
  }

  async #keyCommand(command: Extract<Command, { kind: "key" | "key_remove" | "key_cap" | "key_backup" | "pasted_key" }>, view: TurnView, agent: AgentKey): Promise<void> {
    const t = NOTICES[view.language];
    const now = this.#deps.clock.now();
    const k = this.#store.key();
    switch (command.kind) {
      case "pasted_key": {
        const link = await this.#keyLink(view.language);
        return this.#reply(view, agent, t.pastedKey(link), t.pastedKey(link && KEY_LINK_NOTE));
      }
      case "key": {
        const link = await this.#keyLink(view.language);
        if (link === null) return this.#reply(view, agent, t.keysOff);
        if (!k) return this.#reply(view, agent, t.keyLink(link), t.keyLink(KEY_LINK_NOTE));
        const claudePlan = this.#store.claudePlan();
        const status = (l: string) =>
          [
            t.keyStatus({
              provider: PROVIDERS[k.provider].label,
              model: k.model,
              hint: k.hint,
              spentUsd: usd(this.#store.spend("byok", utcMonth(now)).spent),
              capUsd: usd(k.capMicro),
              approximate: !routeFor({ kind: "key", provider: k.provider, model: k.model }, "turn").priced,
              backup: claudePlan ? k.backup : null,
              link: l,
            }),
            ...(k.health.kind === "resting" ? [t.keyResting] : []),
          ].join("\n");
        return this.#reply(view, agent, status(link), status(KEY_LINK_NOTE));
      }
      case "key_remove":
        return this.#reply(view, agent, this.#store.removeKey(k?.revision ?? null) ? t.keyRemoved : t.noKey);
      case "key_cap": {
        if (!k) return this.#reply(view, agent, t.noKey);
        if (command.usd < OWN_CAP_RANGE_USD.min || command.usd > OWN_CAP_RANGE_USD.max) {
          return this.#reply(view, agent, t.keyCapRange(OWN_CAP_RANGE_USD.min.toFixed(2), OWN_CAP_RANGE_USD.max.toFixed(2)));
        }
        const micro = Math.round(command.usd * 1_000_000) as MicroUsd;
        this.#store.setKeyCap(micro, k.revision);
        return this.#reply(view, agent, t.keyCapSet(usd(micro)));
      }
      case "key_backup":
        if (this.#store.setBackup(command.on, now, k?.revision ?? null) !== "set") return this.#reply(view, agent, t.noKey);
        return this.#reply(view, agent, command.on ? t.backupOn : t.backupOff);
      default:
        return assertNever(command);
    }
  }

  /** A tap on the backup question counts only for the key it asked about. */
  #backupTap(revision: number | null, view: TurnView, agent: AgentKey): void {
    const t = NOTICES[view.language];
    const set = this.#store.setBackup(true, this.#deps.clock.now(), revision);
    return this.#reply(view, agent, set === "set" ? t.backupOn : set === "stale" ? t.backupStale : t.noKey);
  }

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
    } catch {
      diagnostic("invite_failed");
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
      diagnostic("stripe_portal_failed");
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
        diagnostic("stripe_checkout_expiry_failed");
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
        diagnostic("stripe_checkout_failed");
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
    } catch {
      diagnostic("box_claim_failed");
      return this.#boxReply(view, agent, null, { box: null, say: "busy" });
    }
    if (claim === "full") return this.#boxReply(view, agent, deps, { box: null, say: "full" });
    return this.#boxReply(view, agent, deps, { box: newBox(name, deps.host.kind, deps.host.urlOf(name), deps.host.image, now), say: "setting_up" });
  }

  /** The person takes their plan away: its box is removed, if there is one, and from then on their key needs no yes. */
  #claudeRemove(view: TurnView, agent: AgentKey): void {
    this.#store.forgetClaudePlan();
    const current = this.#store.box();
    const t = current ? onRemove(current, this.#deps.clock.now()) : { box: null, say: "removed" as const };
    const m = boxMessage(t.say, view.language, null);
    this.#commit(planWithoutModel(view, { kind: "command", text: m.text, note: m.note }), view, agent, { kind: "none" }, t.box);
  }

  async #boxReply(view: TurnView, agent: AgentKey, deps: BoxDeps | null, t: { readonly box: Box | null; readonly say: BoxSay }): Promise<void> {
    const message = deps && t.box ? await this.#boxMessage(deps, t.box, t.say) : boxMessage(t.say, view.language, null);
    const commit = planWithoutModel(view, { kind: "command", text: message.text, note: message.note });
    this.#commit(commit, view, agent, { kind: "none" }, t.box);
    this.#askBackupIfDue(this.#deps.clock.now());
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
    await this.#advanceBox();
    this.#askBackupIfDue(this.#deps.clock.now());
  }

  async #advanceBox(): Promise<void> {
    const deps = this.#deps.box;
    const box = this.#store.box();
    if (!deps || !box || !mayspend(this.#store.admission())) return;
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
      diagnostic("box_reclaim_failed");
      return;
    }
    await this.#deps.ledger.releaseBox(this.#agent().key, this.#deps.clock.now());
    const m = goneMessage(step.box, this.#agent().language);
    this.#store.removeBox(step.box.name, { texts: [m.text], note: m.note }, this.#deps.clock.now());
    if (step.box.reason !== "removed") this.#askBackupIfDue(this.#deps.clock.now(), true);
  }

  async #ensure(deps: BoxDeps, step: EnsureStep): Promise<void> {
    const ensured = await deps.host.ensure(step.box.name, await boxToken(deps.secret, step.box.name));
    if (!ensured.ok) return diagnostic("box_ensure_failed");
    this.#store.applyBox(afterEnsure(step, deps.host.image), null, [], this.#deps.clock.now());
    this.#store.setBoxVolume(step.box.name, null);
  }

  async #probe(deps: BoxDeps, step: ProbeStep): Promise<Probe> {
    const token = await boxToken(deps.secret, step.box.name);
    if (step.kind === "provision") {
      const ensured = await deps.host.ensure(step.box.name, token);
      if (!ensured.ok) return { kind: "down", retryable: ensured.retryable, detail: ensured.detail };
    }
    const health = await deps.client.health(step.box.url, token);
    if (health.kind === "up") this.#store.setBoxVolume(step.box.name, health.box ?? "");
    return health.kind === "unavailable" ? { kind: "down", retryable: true, detail: health.detail } : health;
  }

  /**
   * Every request names the box's volume, read once from /health, and the epoch of the work that sends it, so an image
   * with erase refuses work from before its last erase. The claim is checked again after each await, right before a fetch.
   */
  async #onBox(
    purpose: CallPurpose,
    claim: Claim,
    send: (client: BoxClient, url: string, token: BoxToken, at: BoxAt | undefined) => Promise<BoxReply>,
  ): Promise<BoxAnswer> {
    const deps = this.#deps.box;
    const box = this.#store.box();
    const agent = this.#agent().key;
    if (!boxServes(deps, agent) || box?.state !== "signed_in") return { kind: "moved_on", transient: false, told: false };
    if (this.#deps.clock.now() < this.#skipBoxUntil) return { kind: "moved_on", transient: true, told: false };
    const token = await boxToken(deps.secret, box.name);
    let volume = this.#store.boxVolume();
    if (volume === null) {
      if (!claim.live()) return { kind: "fenced" };
      const health = await deps.client.health(box.url, token);
      if (health.kind === "up") this.#store.setBoxVolume(box.name, (volume = health.box ?? ""));
    }
    if (!claim.live()) return { kind: "fenced" };
    const res = await send(deps.client, box.url, token, volume ? { box: volume, epoch: claim.epoch } : undefined);
    const now = this.#deps.clock.now();
    const missed = (status: "rejected" | "unavailable"): LogRow =>
      modelCallRow({ id: crypto.randomUUID(), agent, purpose, backend: "box", status, estimate: NO_COST, cost: NO_COST, usage: null, at: now });
    switch (res.kind) {
      case "reply":
        return { kind: "reply", reply: res.reply, session: res.session };
      case "signed_out": {
        const t = onSignedOut(box, now, this.#store.key()?.backup === true);
        const message = await this.#outboxMessage(deps, t.box, t.say);
        this.#store.applyBox(t.box, claim.live() ? message : null, [missed("rejected")], now);
        return { kind: "moved_on", transient: false, told: true };
      }
      case "stale":
        this.#store.setBoxVolume(box.name, null);
        this.#store.appendLogs([missed("rejected")], now);
        return { kind: "moved_on", transient: true, told: false };
      case "unauthorized":
        this.#store.applyBox(needsEnsure(box, now), null, [missed("rejected")], now);
        return { kind: "moved_on", transient: true, told: false };
      case "unavailable":
        diagnostic("box_unavailable");
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
    const claim = this.#store.claim();
    if (!claim) return;
    for (const row of this.#store.readyOutbox(this.#deps.clock.now(), DELIVERY_BATCH)) await this.#deliver(row, claim);
  }

  async #deliver(row: OutboxRow, claim: Claim): Promise<void> {
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
              status,
              day,
              at: now,
              taskId: row.taskId === null ? null : globalTaskId(a.key, row.taskId),
              purpose: row.purpose ?? "unlinked",
            },
          ]
        : [];

    if (row.saved === null && !row.replyOnly && !mayspend(this.#store.admission())) return this.#store.drop(row.id, "removed", now, unaskedLog("dropped_removed", null), "pending");
    if (row.attempts >= MAX_DELIVERY_ATTEMPTS) return this.#store.drop(row.id, "failed", now, unaskedLog("failed", row.admittedDay), "pending");
    if (a.status === "blocked") return this.#store.drop(row.id, "blocked", now, unaskedLog("dropped_blocked", null), "pending");

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
          return this.#store.reschedule(row.id, verdict.until, "pending");
        case "drop":
          return this.#store.drop(row.id, verdict.reason, now, unaskedLog(DROPPED[verdict.reason], null), "pending");
        case "send":
          day = verdict.day;
          break;
        default:
          return assertNever(verdict);
      }
    }

    const page = row.saved === null ? null : this.#store.savedPage(row.saved, a);
    const texts: readonly [string, ...string[]] | null = page ? [page.text] : row.saved === null ? row.texts : null;
    if (texts === null) return this.#store.drop(row.id, "failed", now, [], "pending");
    if (!this.#store.markSending(row.id, day, claim.epoch)) return;
    const delivery = await this.#deps.channels[row.to.channel].deliver({ ...row, texts }, now, claim.live);
    const after = this.#deps.clock.now();
    switch (delivery.kind) {
      case "sent":
        if (page && row.to.channel === "dev" && this.env.DEV_MODE === "1") {
          this.#devSavedPages.set(row.id, page.text);
          if (this.#devSavedPages.size > 50) {
            const oldest = this.#devSavedPages.keys().next();
            if (!oldest.done) this.#devSavedPages.delete(oldest.value);
          }
        }
        return this.#store.markSent(row.id, delivery.via, after, unaskedLog("sent", day), page?.next);
      case "retry":
      case "in_doubt": {
        const at = (after + delivery.afterMs) as EpochMs;
        if (row.attempts + 1 < MAX_DELIVERY_ATTEMPTS) {
          return delivery.kind === "in_doubt" ? this.#store.rescheduleInDoubt(row.id, at) : this.#store.reschedule(row.id, at, "sending");
        }
        diagnostic("delivery_exhausted");
        return this.#store.drop(row.id, "failed", after, unaskedLog("failed", day), "sending");
      }
      case "failed":
        diagnostic("delivery_failed");
        return this.#store.drop(row.id, "failed", after, unaskedLog("failed", day), "sending");
      case "recipient_gone":
        return this.#store.recipientGone(row.id, after, [
          ...unaskedLog("dropped_blocked", day),
          { stream: "lifecycle", id: `gone:${row.id}`, agent: a.key, change: "block", source: "delivery", at: after },
        ]);
      case "fenced":
        return;
      default:
        return assertNever(delivery);
    }
  }

  async #lineQuota(): Promise<QuotaReading | null> {
    try {
      return await this.#deps.ledger.lineQuota();
    } catch {
      diagnostic("line_quota_unavailable");
      return null;
    }
  }

  async #compactIfDue(): Promise<void> {
    const a = this.#store.agent();
    const claim = this.#store.claim();
    if (!a || !claim || !mayspend(this.#store.admission())) return;
    const person = this.#plan(this.#deps.clock.now());
    if (person.kind === "lapsed") return;
    await this.#compactStep(person, false, claim);
  }

  /**
   * One compaction page sized to the smallest budget among the person's lanes; true when it was committed. `force`:
   * the next turn's history doesn't fit, so fold even below the count that otherwise triggers it.
   */
  async #compactStep(person: Plan, force: boolean, claim: Claim): Promise<boolean> {
    if (this.#store.compactionRetryAt() > this.#deps.clock.now()) return false;
    const budget = this.#access().budget("compaction", COMPACTION_SYSTEM, person);
    if (budget === null) return false;
    const plan = planCompaction(this.#store.compactionInput(), budget, force);
    if (!plan) return false;
    let served: Served<"compaction">;
    try {
      served = await this.#access().call({ purpose: "compaction", system: COMPACTION_SYSTEM, prompt: plan.prompt, plan: person, claim });
    } catch (err) {
      this.#store.compactionFailed(this.#deps.clock.now());
      throw err;
    }
    const now = this.#deps.clock.now();
    if (served.kind === "fenced") return false;
    if (served.kind === "ok") return this.#store.commitCompaction(compactionCommit(plan, served.value), now, claim.epoch);
    if (served.kind !== "no_access") this.#store.compactionFailed(now);
    return false;
  }

  async #flushLogs(): Promise<void> {
    for (let i = 0; i < LOG_BATCHES_PER_DRAIN; i++) {
      const rows = this.#store.pendingLogs(this.#deps.clock.now(), LOG_BATCH);
      if (rows.length === 0) return;
      try {
        await this.#deps.ledger.append(rows);
      } catch {
        diagnostic("ledger_flush_failed");
        return this.#store.logsFailed(this.#deps.clock.now());
      }
      this.#store.logsShipped(rows);
      if (rows.length < LOG_BATCH) return;
    }
  }

  async #rearm(): Promise<void> {
    const now = this.#deps.clock.now();
    const catchUp = await this.#catchUpAccess(now);
    const r = this.#store.readiness(now);
    const a = this.#store.agent();
    const held = this.#store.held();
    const fireTimes = a && !held && !r.channelEventWaiting ? r.earliestWakeups.map((w) => fireAt(w, a.tz)) : [];
    const t = nextAlarm({
      now,
      inboxReadyAt: held ? null : (r.inboxReadyAt ?? (catchUp ? now : null)),
      wakeupFireAt: fireTimes.length > 0 ? (Math.min(...fireTimes) as EpochMs) : null,
      outboxReadyAt: held ? null : r.outboxReadyAt,
      logsReadyAt: r.logsReadyAt,
      compactionRetryAt: held ? null : r.compactionRetryAt,
      boxAt: this.#deps.box && mayspend(this.#store.admission()) ? r.boxAt : null,
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

function withoutSecrets(envelope: InboundEnvelope): InboundEnvelope {
  const e = envelope.event;
  if (e.kind !== "message") return envelope;
  const command = commandOf(e);
  if (command?.kind === "feedback") {
    return { ...envelope, event: { ...e, text: command.submitted ? "/feedback submitted" : "/feedback" } };
  }
  const r = redactSecrets(e.text);
  return r.found ? { ...envelope, event: { ...e, text: r.text, redacted: true } } : envelope;
}

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
    privacyUrl: config.privacy.url,
  };
}
