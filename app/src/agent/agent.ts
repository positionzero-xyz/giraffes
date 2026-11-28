import { diagnostic, operatorAlertChatMigrated, type Diagnostic, type DrainPhase } from "../diagnostics";
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
import { offeredPlans, parseSubscription, stripeApi, type BillingEvent, type StripeApi, type StripeErasure } from "../billing/stripe";
import { boxClient, type BoxAt, type BoxClient, type BoxReply } from "../box/client";
import { flyHost } from "../box/fly";
import { staticHost, type BoxHost, type BoxHostKind, type Fetch, type FlyBoxRetirement } from "../box/host";
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
  onConnected,
  onPlan,
  onRemove,
  onSignedOut,
  reclaimBackoff,
  type Box,
  type BoxSay,
  type BoxState,
  type EnsureStep,
  type Probe,
  type ProbeStep,
} from "../box/machine";
import { boxSessionOwner, boxToken, newBoxSetup, signinTicket, signinUrl, type BoxName, type BoxToken } from "../box/names";
import { CHANNEL_RETRY_MS, makeChannels, whileWorking, type ChannelRegistry } from "../channels/channel";
import { commandOf, type Command } from "./commands";
import { loadConfig, OWN_CAP_RANGE_USD, type BillingConfig, type BoxConfig, type Env, type OperatorChat } from "../config";
import {
  assertNever,
  buttonData,
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
  type OutboundMessage,
  type OutboxId,
  type PersonStatus,
  type Seat,
  type TimeZone,
  type WakeupKey,
} from "../domain";
import { erasePersonLedger, prepareLedgerErasure } from "../ledger/erase";
import { d1Ledger, modelCallRow, type Ledger, type LogRow, type UnaskedStatus } from "../ledger/ledger";
import { NOTICES, type KeyPageError } from "../notices";
import { scripted, scriptedConnect, type ScriptedModel, type ScriptStep } from "../model/scripted";
import { connect, type Connect } from "../model/client";
import type { PromptParts } from "../model/prompt";
import { PROVIDERS } from "../model/providers";
import { routeFor, type CallPurpose, type Purpose } from "../model/routes";
import { estimate, fits } from "../policy/spend";
import { admitUnasked, OUTREACH, type UnaskedVerdict } from "../policy/outreach";
import { inLineReserve, type QuotaReading } from "../policy/quota";
import { checkinWakeup, fireAt, nextAlarm, planFiring, SCHEDULE, type PendingWakeup } from "../policy/schedule";
import { DEFAULT_TIME_ZONE, localDate, startOfLocalDay, utcMonth } from "../policy/time";
import { ADMISSION, inviteIn, planAdmission, type AdmissionAnswer, type AdmissionMode, type AdmissionStep } from "./admission";
import { COMPACTION, compactionCommit, planCompaction } from "./compaction";
import { COMPACTION_SYSTEM, TURN_SYSTEM } from "./prompt";
import {
  ACCOUNT_COPY, ACCOUNT_RECEIPT_MS, ACCOUNT_RETRY_MS, ACCOUNT_WIPE_GRACE_MS, ACCOUNT_WIPE_RETRY_MAX_MS, ERASE_CHALLENGE, ERASE_DIAGNOSTIC_MS, ERASE_JOB, START_CHALLENGE,
  digestChallenge, newAccountChallenge, type AccountChallenge, type EraseBilling, type EraseBox,
  type EraseBoxReference, type EraseBoxTarget, type Erasure, type StartChallenge,
} from "./account";
import { coveredByForget, forgetCommandOf, providerOrder, type Claim, type ProviderOrder } from "./forget";
import { backupsWithin, HOST_BACKUP_DAYS } from "./backups";
import type { Backups } from "./forget-text";
import { migrate } from "./schema";
import {
  AgentStore,
  type BillingAlertSettlement,
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
  type BoxTurnPrompt,
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
const BOX_RETIREMENT = "box:retirement";
const FAILED_SETUP_MAX_WIPE_ATTEMPTS = 3;
const KEY_TICKET_MS = 15 * 60_000;
const KEY_LINK_NOTE = "<key link>";
const BILLING_ALERT_REFUSED_MS = 300_000;
const BILLING_ALERT_MAX_BACKOFF_MS = 3_600_000;
const BILLING_ALERT_UNAVAILABLE_MS = 86_400_000;

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
  readonly operatorChat: OperatorChat | null;
  readonly admission: AdmissionMode;
  readonly firstContactConsent: boolean;
};

export type BillingDeps = {
  readonly config: BillingConfig;
  readonly store: BillingStore;
  readonly stripe: (StripeApi & Partial<StripeErasure>) | null;
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
  readonly accountNotice?: { readonly texts: readonly string[]; readonly button?: OutboundMessage["button"] };
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
  #billingAlertSettlement: BillingAlertSettlement | null = null;
  #billingAlertStorageRetryAt = 0;
  #eraseRun: Promise<void> | null = null;
  #accountVersion = 0;
  readonly #accountRpcWork = new Set<Promise<unknown>>();
  /** In memory on purpose: losing it on a restart costs one more try of a box that may still be wedged. */
  #skipBoxUntil = 0;
  readonly #instance = crypto.randomUUID();
  readonly #devSavedPages = new Map<string, string>();
  #devModel: ScriptedModel | null = null;
  #devAccountNotice: Pick<OutboundMessage, "texts" | "button"> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#store = new AgentStore(ctx.storage);
    this.#deps = defaultDeps(env);
    void ctx.blockConcurrencyWhile(async () => {
      migrate(ctx.storage);
      const billingAlertAt = this.#billingAlertAt();
      if (billingAlertAt !== null) await this.#armNoLaterThan(billingAlertAt);
    });
  }

  /** "stale": the person's last forget already covers this event, so nothing of it was stored. */
  async enqueue(given: InboundEnvelope): Promise<"queued" | "duplicate" | "stale"> {
    const now = this.#deps.clock.now();
    const control = await this.#accountControl(given, now);
    if (control === "handled") return "stale";
    if (this.#erasure()) return "stale";
    const e = given.event;
    const starting = typeof control === "object";
    const envelope = starting
      ? { ...given, event: { kind: "lifecycle", change: "follow", at: now, reply: e.reply, code: control.invite } as const }
      : withoutSecrets(given);
    const first = {
      tz: DEFAULT_TIME_ZONE,
      language: envelope.initialLanguage ?? CHANNEL_LANGUAGE[envelope.identity.channel],
      checkinLocal: SCHEDULE.defaultCheckinLocal,
      checkin: checkinWakeup(now, DEFAULT_TIME_ZONE, SCHEDULE.defaultCheckinLocal),
      trialEndsAt: this.#deps.billing.config.on ? trialEnd(now, this.#deps.billing.config.rules) : null,
      admit: this.#deps.admission === "open" || envelope.identity.channel === "dev" ? STAFF : null,
      startBoundary: starting ? now : undefined,
    };
    const m = envelope.event;
    const privacy = m.kind === "message" && !m.edited ? forgetCommandOf(m.text) : null;
    const stored = this.#store.enqueue(privacy && m.kind === "message" ? { ...envelope, event: { ...m, text: "/forget" } } : envelope, first, now, privacy);
    if (stored !== "inserted") return stored;
    if (privacy?.kind === "start" || privacy?.kind === "all") this.#devSavedPages.clear();
    await this.#armNoLaterThan(now);
    this.ctx.waitUntil(this.alarm());
    return "queued";
  }

  billingEvent(e: BillingEvent): Promise<"applied" | "duplicate" | "ignored" | "failed"> {
    const run = this.#runBilling(() => this.#billingEvent(e)).catch(() => {
      diagnostic("stripe_event_failed");
      return "failed" as const;
    });
    this.#billing = run;
    return run;
  }

  #runBilling<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#billing.then(work);
    this.#billing = run.catch(() => undefined);
    return run;
  }

  async #billingEvent(e: BillingEvent): Promise<"applied" | "duplicate" | "ignored"> {
    if (this.#erasure()) return "ignored";
    if (this.#store.billingEventSeen(e.id)) return "duplicate";
    if (this.#deps.firstContactConsent) {
      if (!this.#store.agent()) return "ignored";
      const checkout = e.checkout && this.#store.openCheckouts().some(({ id }) => id === e.checkout);
      if (!checkout) {
        const known = await this.env.LEDGER.prepare(
          "SELECT 1 FROM billing_subscription WHERE id = ? AND owner_key = ?",
        ).bind(e.subscription, e.owner).first();
        if (!known || this.#erasure()) return "ignored";
      }
    }
    const { config, store, stripe } = this.#deps.billing;
    if (!config.on || !stripe) throw new Error("a Stripe event reached a DO with billing off");
    const fetched = await stripe.subscription(e.subscription);
    if (this.#erasure()) return "ignored";
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
    if (this.#erasure()) return "ignored";
    if (e.checkout) this.#store.checkoutClosed(e.checkout);
    if (!(await this.refreshPlan(sub.owner))) throw new Error("owner refresh failed");
    for (const member of await store.members(sub.id)) {
      if (this.#erasure()) return "ignored";
      if (!(await this.env.AGENT.get(this.env.AGENT.idFromName(member)).refreshPlan(member))) throw new Error("member refresh failed");
    }
    if (this.#erasure()) return "ignored";
    await this.#flagDuplicate(sub.owner);
    if (this.#erasure()) return "ignored";
    this.#store.billingEventDone(e.id, this.#deps.clock.now());
    return "applied";
  }

  async #flagDuplicate(owner: AgentKey): Promise<void> {
    const { store } = this.#deps.billing;
    const now = this.#deps.clock.now();
    const owned = await store.owned(owner, now);
    if (this.#erasure() || owned.length < 2) return;
    const ids = owned.join(" ");
    diagnostic("stripe_duplicate_subscription");
    await store.recordDuplicate(owner, owned, now);
    await this.#armNoLaterThan(now);
    if (this.#erasure()) return;
    this.#store.queueBillingAlert(ids, now);
    await this.#deliverBillingAlert();
    this.ctx.waitUntil(this.alarm());
  }

  async #deliverBillingAlert(): Promise<void> {
    const { clock, operatorChat } = this.#deps;
    if (operatorChat === null || this.#store.held() || clock.now() < this.#billingAlertStorageRetryAt) return;
    try {
      this.#billingAlertSettlement ??= await this.#attemptBillingAlert(operatorChat);
      if (this.#billingAlertSettlement === null) return;
      this.#store.finishBillingAlertAttempt(this.#billingAlertSettlement, clock.now());
      this.#billingAlertSettlement = null;
    } catch {
      this.#billingAlertStorageRetryAt = clock.now() + CHANNEL_RETRY_MS;
      diagnostic("drain_billing_alert_failed");
    }
  }

  async #attemptBillingAlert(to: OperatorChat): Promise<BillingAlertSettlement | null> {
    const { billing, channels, clock } = this.#deps;
    const now = clock.now();
    const route = `${to.channel}:${to.channelUserId}`;
    const alert = this.#store.nextBillingAlert(route, now);
    if (alert === null || alert.ready_at > now) return null;
    const person = this.#store.agent();
    const notices = person ? NOTICES[person.language] : null;
    const backoffMs = Math.min(BILLING_ALERT_MAX_BACKOFF_MS, CHANNEL_RETRY_MS * 2 ** alert.attempts);
    this.#store.startBillingAlertAttempt(alert.subscription_ids, (now + backoffMs) as EpochMs, route);
    const destination = alert.telegram_redirect === null ? to : { ...to, channelUserId: alert.telegram_redirect };
    const migrationNote = alert.telegram_redirect === null ? "" : `\nTelegram moved this group. Update OPERATOR_CHAT to telegram:${alert.telegram_redirect}.`;
    const ownerKey = person?.key ?? this.ctx.id.name;
    const detectedAt = ownerKey === undefined ? null : await billing.store.duplicateDetectedAt(ownerKey, alert.subscription_ids).catch(() => {
      diagnostic("operator_alert_date_lookup_failed");
      return null;
    });
    const detectedDate = new Date(typeof detectedAt === "number" ? detectedAt : NaN);
    const dateLine = Number.isNaN(detectedDate.getTime()) ? "Detection date unavailable." : `Detected at: ${detectedDate.toISOString()}`;
    const message = {
      id: alert.delivery_id,
      to: destination,
      texts: [`Duplicate paid plans\n${dateLine}\nSubscriptions: ${alert.subscription_ids}\nReview the subscriptions and any extra charges.${migrationNote}`],
      intent: "requested",
    } as const;
    const channel = channels[to.channel];
    const result = await (channel.deliverOperatorAlert?.(message, now) ?? channel.deliver(message, now))
      .catch(() => ({ kind: "in_doubt", afterMs: CHANNEL_RETRY_MS } as const));
    const settlement = { subscriptionIds: alert.subscription_ids };
    if (result.kind === "sent") return { ...settlement, kind: "sent", text: notices?.duplicateAlerted };
    if (result.kind === "fenced") {
      return { ...settlement, kind: "retry", delayMs: backoffMs, text: undefined };
    }
    if (result.kind === "chat_migrated" && alert.telegram_redirect === null && result.chatId !== to.channelUserId) {
      operatorAlertChatMigrated(to.channelUserId, result.chatId);
      return { ...settlement, kind: "migrated", chatId: result.chatId, text: undefined };
    }
    if (result.kind === "recipient_gone" || result.kind === "chat_unavailable" || result.kind === "chat_migrated") {
      diagnostic("operator_alert_destination_unavailable");
      return { ...settlement, kind: "unavailable", delayMs: BILLING_ALERT_UNAVAILABLE_MS,
        text: alert.notified < 2 ? notices?.duplicateAlertDelayed : undefined };
    }

    const outcome = result.kind === "failed" ? "refused" : result.kind;
    diagnostic(outcome === "in_doubt" ? "operator_alert_unconfirmed" : "operator_alert_failed");
    const waitMs = Math.max(backoffMs, "afterMs" in result ? result.afterMs : BILLING_ALERT_REFUSED_MS);
    return {
      ...settlement,
      kind: "retry",
      delayMs: waitMs,
      text: alert.notified === 0 ? notices?.duplicateRetrying(outcome, Math.ceil(waitMs / 1000)) : undefined,
    };
  }

  #billingAlertAt(): EpochMs | null {
    const { clock, operatorChat } = this.#deps;
    if (operatorChat === null || this.#store.held()) return null;
    if (this.#billingAlertSettlement !== null) return this.#billingAlertStorageRetryAt as EpochMs;
    const next = this.#store.nextBillingAlert(`${operatorChat.channel}:${operatorChat.channelUserId}`, clock.now());
    return next && Math.max(next.ready_at, this.#billingAlertStorageRetryAt) as EpochMs;
  }

  async refreshPlan(agent: AgentKey): Promise<boolean> {
    if (this.#erasure()) return true;
    const version = this.#accountVersion;
    try {
      const { config, store } = this.#deps.billing;
      const now = this.#deps.clock.now();
      const standing = await store.standing(agent, now);
      if (version !== this.#accountVersion) return true;
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
      return true;
    } catch {
      diagnostic("stripe_refresh_failed");
      return false;
    }
  }

  #plan(now: EpochMs): Plan {
    const { config } = this.#deps.billing;
    return planOf(this.#store.plan(), now, config.on, config.rules);
  }

  #erasure(): Erasure | undefined {
    return this.ctx.storage.kv.get<Erasure>(ERASE_JOB);
  }

  async #accountControl(envelope: InboundEnvelope, now: EpochMs): Promise<"continue" | "handled" | { readonly invite?: InviteCode }> {
    const { event, identity } = envelope;
    const remove = event.kind === "message" && !event.edited && event.text.trim().toLowerCase() === "/erase";
    const erasing = this.#erasure();
    if (erasing) {
      if (remove) await this.#deliverAccountNotice({
        id: crypto.randomUUID() as OutboxId, to: identity, texts: [ACCOUNT_COPY[erasing.language].pending],
        intent: "reply", reply: event.reply, replyOnly: identity.channel === "line",
      }, now);
      return "handled";
    }
    const current = this.#store.agent();
    const language = current?.language ?? envelope.initialLanguage ?? CHANNEL_LANGUAGE[identity.channel];
    const copy = ACCOUNT_COPY[language];
    const state = this.#store.forget();
    const choice = event.kind === "choice" ? event.choice : null;
    const firstContact = this.#deps.firstContactConsent && !current;

    if (choice?.kind === "start" || choice?.kind === "erase") {
      const key = choice.kind === "erase" ? ERASE_CHALLENGE : START_CHALLENGE;
      const digest = await digestChallenge(choice.challenge);
      const challenge = this.ctx.storage.kv.get<StartChallenge>(key);
      if (this.#erasure() || !challenge || challenge.digest !== digest || challenge.expiresAt <= now ||
          challenge.epoch !== this.#store.forget().epoch || coveredByForget(envelope, this.#store.forget())) return "handled";
      this.ctx.storage.kv.delete(key);
      if (choice.kind === "start") {
        return firstContact && this.#store.agent() === null ? { invite: challenge.invite } : "handled";
      }
      const trigger = providerOrder(envelope) ?? { at: now, seq: null };
      this.ctx.storage.transactionSync(() => {
        const { epoch } = this.#store.beginForget(trigger, now);
        const job: Erasure = {
          kind: "starting", id: crypto.randomUUID() as OutboxId, person: envelope.agent, to: identity,
          language, epoch, reply: event.reply,
        };
        this.ctx.storage.kv.delete(START_CHALLENGE);
        this.ctx.storage.kv.put(ERASE_JOB, job);
      });
      this.#accountVersion++;
      await this.ctx.storage.setAlarm(now);
      this.ctx.waitUntil(this.alarm());
      return "handled";
    }

    if (!remove && !firstContact) return "continue";
    if (event.kind === "choice" || (event.kind === "lifecycle" && event.change === "block") || coveredByForget(envelope, state)) return "handled";
    const order = providerOrder(envelope);
    if (order && now - order.at > ACCOUNT_RECEIPT_MS) return "handled";
    if (firstContact && commandOf(event)?.kind === "claude_remove") {
      const { text } = boxMessage("removed", language, null);
      await this.#deliverAccountNotice({
        id: crypto.randomUUID() as OutboxId, to: identity, texts: [text],
        intent: "reply", reply: event.reply, replyOnly: identity.channel === "line",
      }, now);
      return "handled";
    }
    const { raw, record } = await newAccountChallenge(state.epoch, now);
    if (this.#erasure() || state.epoch !== this.#store.forget().epoch) return "handled";
    const action = remove ? "erase" : "start";
    const invite = !remove && this.#deps.admission === "beta" ? inviteIn(event) : null;
    this.ctx.storage.kv.put(remove ? ERASE_CHALLENGE : START_CHALLENGE, invite ? { ...record, invite } : record);
    await this.#armNoLaterThan(record.expiresAt);
    if (this.#erasure() || state.epoch !== this.#store.forget().epoch) return "handled";
    await this.#deliverAccountNotice({
      id: crypto.randomUUID() as OutboxId,
      to: identity,
      texts: [remove ? copy.confirm : copy.start],
      intent: "reply",
      reply: event.reply,
      replyOnly: identity.channel === "line" && !mayspend(this.#store.admission()),
      button: {
        data: buttonData(choiceToken({ kind: action, challenge: raw }), state.epoch),
        label: remove ? copy.confirmButton : copy.startButton,
      },
    }, now);
    return "handled";
  }

  async #runErasure(started: Erasure): Promise<void> {
    try {
      if (started.kind === "receipt") return await this.#sendErasureReceipt(started);
      await this.#drain;
      await this.#billing;
      await Promise.allSettled(this.#accountRpcWork);
      let current = this.#erasure();
      if (current?.kind === "starting") {
        const stored = this.#store.box();
        const box = stored && { name: stored.name, host: stored.host, url: stored.url, setup: stored.setup, incarnation: this.#store.boxVolume() };
        current = {
          ...current, kind: "preparing", box, checkouts: this.#store.checkoutIds(),
          startedAt: this.#deps.clock.now(), diagnosedAt: this.#deps.clock.now(),
        };
        this.#store.clearForErasure(current);
        this.#billingAlertSettlement = null;
        this.#billingAlertStorageRetryAt = 0;
        this.#devSavedPages.clear();
        this.#devModel = null;
      }
      if (current?.kind === "preparing") {
        const { box: stored, checkouts, ...identity } = current;
        const registered = await this.env.LEDGER.prepare("SELECT name, host, deleted_at FROM boxes WHERE agent_key = ?")
          .bind(identity.person).first<{ name: BoxName; host: EraseBoxReference["host"]; deleted_at: EpochMs | null }>();
        const boxLedgerKey = registered?.deleted_at === null ? `erasure:${crypto.randomUUID()}` : null;
        const box = this.ctx.storage.kv.get<EraseBox>(BOX_RETIREMENT) ?? this.#accountBoxTarget(identity.person, stored, registered);
        const { invitees, members, subscriptions } = await prepareLedgerErasure(this.env.LEDGER, identity.person);
        current = {
          ...identity, kind: "cleaning", box, boxLedgerKey,
          ledger: { kind: "sweep", invitees, members },
          billing: { kind: "pending", checkouts, subscriptions, endedSubscription: false, stripeRetained: false },
        };
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.kv.put(ERASE_JOB, current);
          this.ctx.storage.kv.delete(BOX_RETIREMENT);
        });
      }
      if (current?.kind !== "cleaning") return;
      if (current.ledger.kind === "sweep") {
        await erasePersonLedger(this.env.LEDGER, current.person, current.boxLedgerKey);
        current = { ...current, ledger: { ...current.ledger, kind: "detach" } };
        this.ctx.storage.kv.put(ERASE_JOB, current);
      }
      if (current.ledger.kind === "detach") {
        for (const invitee of current.ledger.invitees) {
          await this.env.AGENT.get(this.env.AGENT.idFromName(invitee)).eraseInviterReference(current.person);
        }
        for (const member of current.ledger.members) {
          await this.env.AGENT.get(this.env.AGENT.idFromName(member)).refreshPlan(member).catch(() => undefined);
        }
        current = { ...current, ledger: { kind: "done" } };
        this.ctx.storage.kv.put(ERASE_JOB, current);
      }
      while (current.billing.kind === "pending") {
        const billing: EraseBilling | null = await this.#eraseBillingStep(current.person, current.billing).catch(() => null);
        if (billing === null) {
          current = this.#noteEraseHold(current, "erase_billing_hold");
          this.ctx.storage.kv.put(ERASE_JOB, current);
          break;
        }
        current = { ...current, billing };
        this.ctx.storage.kv.put(ERASE_JOB, current);
      }
      while ("box" in current.box) {
        const now = this.#deps.clock.now();
        if (current.boxRetry?.waitingFor !== undefined && now < current.boxRetry.nextAt) {
          const delay = current.boxRetry.nextAt - now;
          return await this.#retryErasure(current.billing.kind === "pending" ? Math.min(delay, ACCOUNT_RETRY_MS) : delay);
        }
        const box = await this.#retireBoxStep({ ...current, eraseAccount: true });
        const awaitingDiskConfirmation = box.kind === "remove-volume" && current.box.kind === "remove-volume";
        if (box.kind === "relocate" || box === current.box || awaitingDiskConfirmation) {
          return await this.#holdEraseBox({ ...current, box });
        }
        current = { ...current, box };
        this.ctx.storage.kv.put(ERASE_JOB, current);
      }
      const { box, boxLedgerKey, billing, id, person, to, language, epoch, reply } = current;
      if (billing.kind === "pending") {
        current = this.#noteEraseHold(current, "erase_billing_hold");
        this.ctx.storage.kv.put(ERASE_JOB, current);
        await this.#retryErasure();
        return;
      }
      if (boxLedgerKey !== null) {
        await this.env.LEDGER.prepare("DELETE FROM boxes WHERE agent_key = ?").bind(boxLedgerKey).run();
      }
      const receipt: Erasure = {
        kind: "receipt", id, person, to, language, epoch, reply,
        expiresAt: (this.#deps.clock.now() + ACCOUNT_RECEIPT_MS) as EpochMs,
        attempted: false, endedSubscription: billing.endedSubscription, stripeRetained: billing.stripeRetained,
        box: box.kind === "none" ? null : box,
      };
      this.ctx.storage.kv.put(ERASE_JOB, receipt);
      await this.#sendErasureReceipt(receipt);
    } catch {
      const held = this.#erasure();
      if (held?.kind === "cleaning") this.ctx.storage.kv.put(ERASE_JOB, this.#noteEraseHold(held, "erase_failed"));
      await this.#retryErasure();
    }
  }

  async #holdEraseBox(job: Extract<Erasure, { kind: "cleaning" }>): Promise<void> {
    const { box } = job;
    const now = this.#deps.clock.now();
    const wipeDeadline = "wipeFailedAt" in box && box.wipeFailedAt !== undefined
      ? box.wipeFailedAt + ACCOUNT_WIPE_GRACE_MS : null;
    const removingDisk = (box.kind === "remove-volume" || box.kind === "remove-app" ||
      (box.kind === "relocate" && box.resume !== "wipe-fly")) &&
      (box.target?.disk != null || (box.target?.disks?.length ?? 0) > 0);
    let delay = box.kind === "unverified" && job.billing.kind === "done" ? ACCOUNT_RECEIPT_MS : ACCOUNT_RETRY_MS;
    const wipingStaticBox = box.kind === "wipe-static";
    if (wipingStaticBox || wipeDeadline !== null || removingDisk) {
      const graceLeft = wipeDeadline === null ? 0 : wipeDeadline - now;
      const waitingFor = wipingStaticBox || graceLeft > 0 ? "box-wipe" : "disk-delete";
      const attempts = job.boxRetry?.waitingFor === waitingFor ? job.boxRetry.attempts : 0;
      delay = reclaimBackoff(attempts);
      if (graceLeft > 0) delay = Math.min(delay, ACCOUNT_WIPE_RETRY_MAX_MS, graceLeft);
      job = { ...job, boxRetry: { waitingFor, attempts: attempts + 1, nextAt: (now + delay) as EpochMs } };
      if (job.billing.kind === "pending") delay = Math.min(delay, ACCOUNT_RETRY_MS);
    }
    await this.#retryErasure(delay, this.#noteEraseHold(job, this.#eraseBoxHoldCode(job)));
  }

  /** At most one operator diagnostic a day per stuck erasure; the value is its age in hours. */
  #noteEraseHold(job: Extract<Erasure, { kind: "cleaning" }>, code: Diagnostic): Extract<Erasure, { kind: "cleaning" }> {
    const now = this.#deps.clock.now();
    // A job persisted before timestamps existed is at least one interval old; report that lower bound.
    const startedAt = job.startedAt ?? ((now - ERASE_DIAGNOSTIC_MS) as EpochMs);
    const last = job.diagnosedAt ?? startedAt;
    if (now - last < ERASE_DIAGNOSTIC_MS) return job;
    diagnostic(code, Math.floor((now - startedAt) / (60 * 60_000)));
    return { ...job, startedAt, diagnosedAt: now };
  }

  #eraseBoxHoldCode(job: Extract<Erasure, { kind: "cleaning" }>): Diagnostic {
    const step = job.box;
    const deps = this.#deps.box;
    if (!("box" in step)) return "erase_box_hold";
    if (!deps || !boxServes(deps, job.person)) return "erase_box_unverified";
    if (deps.host.kind !== step.box.host) return "erase_box_host_mismatch";
    return step.kind === "unverified" ? "erase_box_unverified" : "erase_box_hold";
  }

  async eraseInviterReference(inviter: AgentKey): Promise<void> {
    await this.#drain;
    this.#store.detachInviter(inviter);
  }

  async #eraseBillingStep(person: AgentKey, billing: Extract<EraseBilling, { kind: "pending" }>): Promise<EraseBilling | null> {
    const [checkout, ...checkouts] = billing.checkouts;
    const [subscription, ...subscriptions] = billing.subscriptions;
    const stripe = this.#deps.billing.stripe;
    if (checkout) {
      const closed = await stripe?.closeCheckout?.(checkout, person);
      if (!closed?.ok) return null;
      return {
        ...billing, checkouts, stripeRetained: billing.stripeRetained || closed.value.retained,
        subscriptions: closed.value.subscription && !billing.subscriptions.includes(closed.value.subscription)
          ? [...billing.subscriptions, closed.value.subscription] : billing.subscriptions,
      };
    }
    if (subscription) {
      const closed = await stripe?.closeSubscription?.(subscription, person);
      return closed?.ok
        ? { ...billing, subscriptions, endedSubscription: true, stripeRetained: billing.stripeRetained || closed.value.retained }
        : null;
    }
    return { kind: "done", endedSubscription: billing.endedSubscription, stripeRetained: billing.stripeRetained };
  }

  #resolveAccountBox(person: AgentKey, box: EraseBoxReference): EraseBox {
    const deps = this.#deps.box;
    if (!boxServes(deps, person) || box.host !== deps.host.kind || (box.host === "static" && deps.onlyFor !== person)) {
      return { kind: "unverified", box };
    }
    const target: EraseBoxTarget = { ...box, url: box.url ?? deps.host.urlOf(box.name) };
    return { kind: box.host === "fly" ? "locate" : "wipe-static", box: target };
  }

  #accountBoxTarget(
    person: AgentKey,
    stored: EraseBoxTarget | null,
    registered: { readonly name: BoxName; readonly host: EraseBoxReference["host"]; readonly deleted_at: EpochMs | null } | null,
  ): EraseBox {
    if (registered && registered.deleted_at !== null && (!stored || stored.name === registered.name)) {
      return { kind: "reclaimed", host: registered.host };
    }
    // A claim with no box row never ran a setup's ensure, so no machine holds a setup's key.
    const reference: EraseBoxReference | null = stored ?? (registered && registered.deleted_at === null
      ? { name: registered.name, host: registered.host, url: null, setup: null, incarnation: null }
      : null);
    if (!reference) return { kind: "none" };
    return this.#resolveAccountBox(person, reference);
  }

  async #retireBoxStep({ person, epoch, box: step, eraseAccount }: {
    readonly person: AgentKey; readonly epoch: ForgetEpoch; readonly box: EraseBox; readonly eraseAccount?: true;
  }): Promise<EraseBox> {
    const deps = this.#deps.box;
    if (!("box" in step)) return step;
    if (step.kind === "unverified") {
      const resolved = this.#resolveAccountBox(person, step.box);
      return resolved.kind === "unverified" ? step : resolved;
    }
    if (!boxServes(deps, person) || deps.host.kind !== step.box.host) return step;
    const fly = "retirementTarget" in deps.host ? deps.host as BoxHost & FlyBoxRetirement : null;
    const { box } = step;
    switch (step.kind) {
      case "locate": {
        const found = await fly?.retirementTarget(box.name);
        if (found && !found.ok && found.missing) return { kind: "reclaimed", host: "fly" };
        if (!found?.ok) return step;
        return found.target.disk === null
          ? { kind: "remove-volume", box, target: found.target }
          : { kind: "wipe-fly", box, target: found.target, verify: false };
      }
      case "relocate": {
        // A job persisted by the earlier relocate shape has no saved target. Hold rather than
        // re-select a volume that was never part of the original proof.
        if (!("target" in step) || !step.target || !step.resume) return step;
        const check = await fly?.retirementRecheck(box.name, step.target);
        if (check && !check.ok && check.missing) return { kind: "reclaimed", host: "fly" };
        if (!check?.ok) return step;
        if (check.state === "gone") {
          // A disk that disappears before the box acknowledged a wipe never becomes a wiped box.
          return step.resume === "wipe-fly"
            ? { kind: "reclaimed", host: "fly" }
            : { kind: "remove-app", box, target: step.target, wipeSkipped: step.wipeSkipped, diskDeleteAccepted: step.diskDeleteAccepted };
        }
        return step.resume === "wipe-fly"
          ? { kind: "wipe-fly", box, target: step.target, verify: true, wipeFailures: step.wipeFailures, wipeFailedAt: step.wipeFailedAt }
          : { kind: step.resume, box, target: step.target, wipeSkipped: step.wipeSkipped, diskDeleteAccepted: step.diskDeleteAccepted };
      }
      case "wipe-static":
      case "wipe-fly": {
        const token = await boxToken(deps.secret, box.name, box.setup);
        const fallback = step.kind === "wipe-fly"
          ? { kind: "relocate", box, target: step.target, resume: "wipe-fly", wipeFailures: step.wipeFailures, wipeFailedAt: step.wipeFailedAt } satisfies EraseBox
          : step;
        const failedWipe = (): EraseBox => {
          if (fallback.kind !== "relocate") return fallback;
          const now = this.#deps.clock.now();
          const wipeFailedAt = eraseAccount ? (fallback.wipeFailedAt ?? now) : undefined;
          const wipeFailures = box.neverServed === true ? (fallback.wipeFailures ?? 0) + 1 : undefined;
          if ((wipeFailures !== undefined && wipeFailures >= FAILED_SETUP_MAX_WIPE_ATTEMPTS) ||
            (wipeFailedAt !== undefined && now - wipeFailedAt >= ACCOUNT_WIPE_GRACE_MS)) {
            return { kind: "remove-volume", box, target: fallback.target, wipeSkipped: true };
          }
          return { ...fallback, wipeFailures, wipeFailedAt };
        };
        if (!box.incarnation) {
          const health = await deps.client.health(box.url, token);
          if (health.kind !== "up" || !health.box) return failedWipe();
          return { ...step, box: { ...box, incarnation: health.box } };
        }
        if (step.kind === "wipe-fly" && step.verify !== false) {
          // Identity must still be the saved disk and machine at the point of the destructive call.
          // A job persisted before this flag existed is verified; only a fresh locate skips it.
          const check = await fly?.retirementRecheck(box.name, step.target);
          if (check && !check.ok && check.missing) return { kind: "reclaimed", host: "fly" };
          if (!check?.ok || check.state !== "present") return fallback;
        }
        const incarnation = box.incarnation;
        const wipe = await deps.client.erase(box.url, token, { scope: "account", box: incarnation, epoch });
        if (wipe.kind !== "erased" || wipe.scope !== "account" || wipe.box !== incarnation || wipe.floor < epoch) return failedWipe();
        return step.kind === "wipe-fly" ? { kind: "remove-volume", box, target: step.target } : { kind: "wiped", host: "static" };
      }
      case "remove-volume": {
        const retired = await fly?.retireWipedDisk(box.name, step.target);
        const progress = eraseAccount && step.wipeSkipped && retired?.diskDeleteAccepted
          ? { ...step, diskDeleteAccepted: true } satisfies EraseBox
          : step;
        if (retired?.ok) return { ...progress, kind: "remove-app" };
        return retired?.missing
          ? { ...progress, kind: "relocate", resume: "remove-volume" }
          : progress;
      }
      case "remove-app": {
        const removed = await fly?.removeRetiredApp(box.name);
        if (removed?.ok) {
          if (eraseAccount && step.wipeSkipped && step.diskDeleteAccepted) {
            return { kind: "reclaimed", host: "fly", deletedWithoutWipe: true };
          }
          return step.target.disk === null || step.wipeSkipped
            ? { kind: "reclaimed", host: "fly" }
            : { kind: "wiped", host: "fly" };
        }
        return removed && !removed.ok && removed.missing
          ? { ...step, kind: "relocate", resume: "remove-app" }
          : step;
      }
    }
  }

  async #sendErasureReceipt(job: Extract<Erasure, { kind: "receipt" }>): Promise<void> {
    const now = this.#deps.clock.now();
    if (now >= job.expiresAt || (job.attempted && job.to.channel === "telegram")) return this.#finishErasure();
    const copy = ACCOUNT_COPY[job.language];
    this.ctx.storage.kv.put(ERASE_JOB, { ...job, attempted: true });
    const delivery = await this.#deliverAccountNotice({
      id: job.id, to: job.to, intent: "requested", reply: job.reply,
      texts: [[
        copy.receipt,
        ...(job.box?.kind === "reclaimed" ? [job.box.deletedWithoutWipe ? copy.deletedUnwipedBox : copy.reclaimedBox] : []),
        ...(job.box?.host === "fly" ? [copy.flyCopies] : []),
        ...(job.endedSubscription ? [copy.subscriptionEnded] : []),
        copy.stripeRecords,
        ...(job.stripeRetained ? [copy.stripeRetained] : []),
        copy.return,
      ].join("\n\n")],
    }, now);
    if (delivery.kind === "retry" || delivery.kind === "in_doubt") {
      if (delivery.kind === "retry") this.ctx.storage.kv.put(ERASE_JOB, { ...job, attempted: false });
      await this.#retryErasure(delivery.afterMs);
    } else {
      await this.#finishErasure();
    }
  }

  async #deliverAccountNotice(message: OutboundMessage, now: EpochMs) {
    const delivery = await this.#deps.channels[message.to.channel].deliver(message, now);
    if (message.to.channel === "dev" && delivery.kind === "sent") {
      this.#devAccountNotice = { texts: message.texts, button: message.button };
    }
    return delivery;
  }

  async #finishErasure(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      migrate(this.ctx.storage);
    });
  }

  async #retryErasure(delay = ACCOUNT_RETRY_MS, job = this.#erasure()): Promise<void> {
    const now = this.#deps.clock.now();
    if (job) this.ctx.storage.kv.put(ERASE_JOB, { ...job, nextAt: (now + delay) as EpochMs });
    await this.ctx.storage.setAlarm(now + delay);
  }

  async #trackAccountRpc<T>(work: Promise<T>): Promise<T> {
    this.#accountRpcWork.add(work);
    try {
      return await work;
    } finally {
      this.#accountRpcWork.delete(work);
    }
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
    const erase = this.#erasure();
    if (erase) {
      const now = this.#deps.clock.now();
      if (erase.nextAt !== undefined && now < erase.nextAt) {
        await this.ctx.storage.setAlarm(erase.nextAt);
        return;
      }
      if (!this.#eraseRun) {
        this.#eraseRun = this.#runErasure(erase).finally(() => { this.#eraseRun = null; });
      }
      return this.#eraseRun;
    }
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
      ...(this.#devAccountNotice ? { accountNotice: this.#devAccountNotice } : {}),
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
    return this.#trackAccountRpc(this.#serve(req));
  }

  async #serve(req: ServeRequest): Promise<Served<Purpose> | { readonly kind: "not_owner" }> {
    if (this.#erasure()) return { kind: "not_owner" };
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
    return this.#trackAccountRpc(this.#connectKey(nonceHash, fields));
  }

  async #connectKey(nonceHash: string, fields: KeyFields): Promise<ConnectResult> {
    if (this.#erasure()) return { ok: false, error: "expired" };
    const version = this.#accountVersion;
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
    if (version !== this.#accountVersion) return { ok: false, error: "superseded" };
    const after = this.#deps.clock.now();
    if (!probe.ok) {
      this.#store.finishTicket(nonceHash, "failed", probe.error);
      return probe;
    }
    const d = draft.value;
    const label = PROVIDERS[d.provider].label;
    const text = NOTICES[a.language].keyConnected(label, d.model);
    const sealed = await seal(keys.secrets.current, a.key, d);
    if (version !== this.#accountVersion) return { ok: false, error: "superseded" };
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
    if (this.#erasure()) return;
    this.#store.recordGroup(group, version);
  }

  async remove(): Promise<void> {
    if (this.#erasure()) return;
    // Let an in-flight provisioning or sign-in step finish before changing the box it would write back.
    while (this.#drain) await this.#drain;
    if (this.#erasure()) return;
    const now = this.#deps.clock.now();
    this.ctx.storage.transactionSync(() => {
      this.#store.remove(now);
      const box = this.#store.box();
      if (!box) return;
      this.#store.forgetClaudePlan();
      const retiring = onRemove(box, now).box;
      if (box.host === "fly" && box.state === "provisioning") this.#saveNeverServedRetirement(box, box.stateAt);
      if (retiring !== box) this.#store.applyBox(retiring, null, [], now);
    });
    await this.#armNoLaterThan(now);
  }

  /**
   * Opens a forget at `trigger`, the place in the provider's order of the request that asked for it. From here until
   * `endForget` with the same `op`, nothing ordinary runs, and nothing begun before it may send, save or call out.
   */
  async beginForget(trigger: ProviderOrder): Promise<{ readonly op: string; readonly epoch: ForgetEpoch }> {
    if (this.#erasure()) throw new Error("account erasure is in progress");
    return this.#store.beginForget(trigger, this.#deps.clock.now());
  }

  async endForget(op: string): Promise<boolean> {
    if (this.#erasure()) return false;
    const now = this.#deps.clock.now();
    if (!this.#store.endForget(op)) return false;
    await this.#armNoLaterThan(now);
    this.ctx.waitUntil(this.alarm());
    return true;
  }

  /** Dev only: the pending wake-up `key` falls due now and fires through the alarm, as it would at its time. */
  async fireNow(key: WakeupKey): Promise<boolean> {
    if (this.#erasure()) return false;
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
    if (this.#erasure()) return;
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
      if ((this.#billingAlertAt() ?? Infinity) <= started) {
        await this.#phase("drain_billing_alert_failed", () => this.#runBilling(() => this.#deliverBillingAlert()));
      }
      await this.#phase("drain_turns_failed", async () => {
        const poisoned = this.#store.recover(started, this.#instance);
        if (this.#store.held()) return;
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
      await this.#phase("drain_forget_failed", () => this.#stepForget());
      await this.#phase("drain_delivery_failed", () => this.#deliverReady());
      await this.#phase("drain_log_flush_failed", () => this.#flushLogs());
      await this.#phase("drain_compaction_failed", () => this.#compactIfDue());
      await this.#phase("drain_prune_failed", async () => {
        for (const key of [ERASE_CHALLENGE, START_CHALLENGE]) {
          const challenge = this.ctx.storage.kv.get<AccountChallenge>(key);
          if (challenge && challenge.expiresAt <= clock.now()) this.ctx.storage.kv.delete(key);
        }
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
    if (command?.kind === "claude_remove") return this.#claudeRemove(view, a.key);
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
    const box = this.#boxTurn(shown);
    const access = this.#access();
    const catchUpBudget = batch.items[0].catchUp ? access.catchUpBudget(plan, this.#deps.clock.now()) ?? "unavailable" : null;
    const call = () => access.call({ purpose: "turn", system: TURN_SYSTEM, prompt: renderUser(shown), plan, box, claim });
    const served = intentOf(first) === "reply" ? await whileWorking(this.#deps.channels[a.identity.channel], a.identity, call) : await call();
    const historyTrimmed = shown.historyLeftOut > 0 || ((served.kind === "ok" || served.kind === "failed") && served.trimmed);
    switch (served.kind) {
      case "ok": {
        const commit = planTurn(served.value, shown);
        const answered = served.call.box;
        const seen = answered ? { id: answered.session, sentThrough: answered.sentThrough, memory: memoryHeldAfter(shown, commit) } : null;
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

  #boxTurn(view: TurnView): BoxTurnPrompt {
    const held = this.#store.boxSession();
    let overflow: Parameters<typeof renderBoxTurn>[2];
    if (view.historyLeftOut > 0 && this.#boxLane().state() === "signed_in") {
      const fresh = this.#store.oldestBoxHistory(0);
      overflow = { fresh, unseen: held ? this.#store.oldestBoxHistory(held.seenSeq) : fresh };
    }
    return renderBoxTurn(view, held, overflow);
  }

  /**
   * When unsummarized turns are due to compact or don't fit the prompt the first lane would send, one compaction step
   * runs first, in this drain. If compaction is backing off or fails, each lane fits history to its own prompt.
   */
  async #historyThatFits(batch: Batch, a: AgentRow, view: TurnView, plan: Plan, claim: Claim): Promise<TurnView> {
    if (view.recent.length === 0) return view;
    const box = this.#boxTurn(view);
    const fits = this.#access().turnFitsWhole({ system: TURN_SYSTEM, prompt: renderUser(view), box, plan });
    const dueTurns = this.#store.compactionInput().turnCount > COMPACTION.triggerTurns;
    if (fits && !dueTurns) return view;
    try {
      if (!(await this.#compactStep(plan, !dueTurns, claim))) return view;
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
      agent: (req, claim) => this.#onBox("turn", claim, (client, url, token, at, sessionOwner) => client.agent(url, token, { ...req, sessionOwner, at })),
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
    if (this.#deps.admission === "open" && view.admission.state !== "removed") {
      const now = this.#deps.clock.now();
      const admitted = { next: { state: "admitted", seat: STAFF, at: now }, change: "consented", ensureCheckin: checkinWakeup(now, a.tz, a.checkinLocal) } as const;
      this.#commit(planWithoutModel(view, { kind: "admission", commit: admitted, text: null, consent: false }), view, a.key, { kind: "none" });
      return;
    }
    let step: AdmissionStep = planAdmission(view, null);
    if (step.kind !== "commit") {
      const now = this.#deps.clock.now();
      if (step.kind === "check" && this.#store.rateLimited("invite", now, 60 * 60_000, ADMISSION.inviteChecksPerHour)) {
        const unchanged = { next: view.admission, change: null, ensureCheckin: null };
        return this.#commit(planWithoutModel(view, { kind: "admission", commit: unchanged, text: null, consent: false }), view, a.key, { kind: "none" });
      }
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
      step = planAdmission(view, answer);
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

  async #command(command: Exclude<Command, { kind: "memory" | "memory_next" | "claude_remove" }>, view: TurnView, a: AgentRow): Promise<void> {
    const agent = a.key;
    if (this.#deps.admission === "beta" && (command.kind === "invite" || command.kind === "join")) return this.#betaCommand(command, view, agent);
    switch (command.kind) {
      case "claude":
        return this.#boxCommand(view, agent);
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
    const dayStart = startOfLocalDay(view.now, view.tz);
    const capped = submitted && this.#store.rateLimited("feedback", view.now, view.now - dayStart + 1, ADMISSION.feedbackPerDay);
    const logs: LogRow[] = submitted && !capped ? [
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
      if (!result.ok) {
        diagnostic("stripe_checkout_expiry_failed");
        expired = false;
      } else if (result.value === "expired" || !this.#deps.firstContactConsent) {
        this.#store.checkoutClosed(id);
      }
    }
    if (!expired || this.#erasure()) return null;

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
    const current = this.#store.box();
    if (current?.state === "signed_out") {
      const health = await deps.client.health(current.url, await boxToken(deps.secret, current.name, current.setup));
      if (health.kind === "up" && health.signedIn) return this.#boxReply(view, agent, deps, onConnected(current, this.#deps.clock.now()));
    }
    const now = this.#deps.clock.now();
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
    const setup = deps.host.kind === "static" ? null : newBoxSetup();
    return this.#boxReply(view, agent, deps, { box: newBox(name, deps.host.kind, deps.host.urlOf(name), setup, deps.host.image, now), say: "setting_up" });
  }

  /** The person takes their plan away: its box is removed, if there is one, and from then on their key needs no yes. */
  #claudeRemove(view: TurnView, agent: AgentKey): void {
    this.ctx.storage.transactionSync(() => {
      this.#store.forgetClaudePlan();
      const current = this.#store.box();
      const t = current ? onRemove(current, this.#deps.clock.now()) : { box: null, say: "removed" as const };
      const m = boxMessage(t.say, view.language, null);
      this.#commit(planWithoutModel(view, { kind: "command", text: m.text, note: m.note }), view, agent, { kind: "none" }, t.box);
      if (current?.host === "fly" && current.state === "provisioning" && this.#store.box()?.state === "reclaiming") {
        this.#saveNeverServedRetirement(current, current.stateAt);
      }
    });
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
    this.#store.noteBoxLink(exp);
    const ticket = await signinTicket(await boxToken(deps.secret, box.name, box.setup), exp);
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
    if (this.#erasure()) return;
    const deps = this.#deps.box;
    const box = this.#store.box();
    if (!box) return;
    if (box.state !== "reclaiming" || box.reason !== "removed") {
      if (!deps || !mayspend(this.#store.admission())) return;
      const now = this.#deps.clock.now();
      const planned = onPlan(box, !this.#deps.billing.config.on || planAllowsBox(this.#plan(now).kind), now);
      const current = deps.host.image !== null && planned.box.image !== deps.host.image ? needsEnsure(planned.box, now) : planned.box;
      if (current !== box) this.#store.applyBox(current, await this.#outboxMessage(deps, current, planned.say), [], now);
    }
    for (let i = 0; i < BOX_STEPS_PER_DRAIN; i++) {
      if (this.#erasure()) return;
      const stored = this.#store.box();
      const step = stored && beginStep(stored, this.#deps.clock.now());
      if (!step) return;
      if (step.kind === "reclaim") {
        this.#saveBoxStep(stored, step.box, null);
        await this.#reclaim(step.box);
        return;
      }
      if (!deps) return;
      this.#store.applyBox(step.box, null, [], this.#deps.clock.now());
      if (step.kind === "ensure") {
        await this.#ensure(deps, step);
        continue;
      }
      const probe = await this.#probe(deps, step);
      const t = afterProbe(step, probe, this.#deps.clock.now());
      this.#saveBoxStep(step.box, t.box, await this.#outboxMessage(deps, t.box, t.say));
    }
  }

  /** `before` is the box as the step found it, which still holds when its setup started. */
  #saveBoxStep(before: Box, box: Box, message: NoteMessage | null): void {
    const now = this.#deps.clock.now();
    if (box.state !== "reclaiming" || box.reason !== "failed") {
      this.#store.applyBox(box, message, [], now);
      return;
    }
    this.ctx.storage.transactionSync(() => {
      this.#saveNeverServedRetirement(box, before.state === "provisioning" ? before.stateAt : null);
      this.#store.applyBox(box, message, [], now);
    });
  }

  /**
   * Any sign-in link sent for this box's name opens it, and a sign-in made in time outlives the link. So only a box
   * whose setup began after every such link and its grace ran out is known never to have served the person. A null
   * `setupAt` is a setup start no longer known.
   */
  #saveNeverServedRetirement(box: Box, setupAt: EpochMs | null): void {
    if (this.ctx.storage.kv.get<EraseBox>(BOX_RETIREMENT) !== undefined) return;
    const linkExpiresAt = this.#store.boxLinkExpiresAt();
    if (linkExpiresAt !== null && (setupAt === null || linkExpiresAt + BOX.signinGraceMs > setupAt)) return;
    this.ctx.storage.kv.put(BOX_RETIREMENT, this.#resolveAccountBox(this.#agent().key, {
      name: box.name, host: box.host, url: box.url, setup: box.setup, incarnation: this.#store.boxVolume(), neverServed: true,
    }));
  }

  async #reclaim(box: Extract<Box, { state: "reclaiming" }>): Promise<void> {
    const { key: person, language } = this.#agent();
    const deps = this.#deps.box;
    const sharedDevBox = box.reason !== "removed" && box.host === "static" && deps?.host.kind === "static" && deps.onlyFor === null;
    if (!sharedDevBox) {
      const epoch = (this.#store.forget().epoch + 1) as ForgetEpoch;
      let progress = this.ctx.storage.kv.get<EraseBox>(BOX_RETIREMENT) ?? this.#resolveAccountBox(person, {
        name: box.name, host: box.host, url: box.url, setup: box.setup, incarnation: this.#store.boxVolume(),
      });
      while ("box" in progress) {
        this.ctx.storage.kv.put(BOX_RETIREMENT, progress);
        const next = await this.#retireBoxStep({ person, epoch, box: progress });
        if (next === progress || next.kind === "relocate") {
          this.ctx.storage.kv.put(BOX_RETIREMENT, next);
          return diagnostic("box_reclaim_failed");
        }
        progress = next;
      }
      this.ctx.storage.kv.put(BOX_RETIREMENT, progress);
    }
    await this.#deps.ledger.releaseBox(person, this.#deps.clock.now());
    const notice = mayspend(this.#store.admission()) ? goneMessage(box, language) : null;
    this.ctx.storage.transactionSync(() => {
      this.#store.removeBox(box.name, notice && { texts: [notice.text], note: notice.note }, this.#deps.clock.now());
      this.ctx.storage.kv.delete(BOX_RETIREMENT);
    });
    if (box.reason !== "removed") this.#askBackupIfDue(this.#deps.clock.now(), true);
  }

  async #ensure(deps: BoxDeps, step: EnsureStep): Promise<void> {
    const ensured = await deps.host.ensure(step.box.name, await boxToken(deps.secret, step.box.name, step.box.setup));
    if (!ensured.ok) return diagnostic("box_ensure_failed");
    this.#store.applyBox(afterEnsure(step, deps.host.image), null, [], this.#deps.clock.now());
    this.#store.setBoxVolume(step.box.name, null);
  }

  async #probe(deps: BoxDeps, step: ProbeStep): Promise<Probe> {
    const token = await boxToken(deps.secret, step.box.name, step.box.setup);
    if (step.kind === "provision") {
      const ensured = await deps.host.ensure(step.box.name, token);
      if (!ensured.ok) return { kind: "down", retryable: ensured.retryable, detail: ensured.detail };
    }
    const health = await deps.client.health(step.box.url, token);
    if (health.kind === "up") this.#store.setBoxVolume(step.box.name, health.box ?? "");
    return health.kind === "unavailable" ? { kind: "down", retryable: true, detail: health.detail } : health;
  }

  /** True only when the consented backup key is currently healthy and has unspent cap room. */
  #backupKeyCanServe(now: EpochMs, purpose: CallPurpose): boolean {
    const key = this.#store.key();
    if (!key?.backup || key.health.kind !== "ok") return false;
    const route = routeFor({ kind: "key", provider: key.provider, model: key.model }, purpose);
    return fits(this.#store.spend("byok", utcMonth(now)), estimate(route, route.promptBytes), key.capMicro);
  }

  /**
   * Every request names the box's volume, read once from /health, and the epoch of the work that sends it, so an image
   * with erase refuses work from before its last erase. The claim is checked again after each await, right before a fetch.
   */
  async #onBox(
    purpose: CallPurpose,
    claim: Claim,
    send: (client: BoxClient, url: string, token: BoxToken, at: BoxAt | undefined, sessionOwner: string) => Promise<BoxReply>,
  ): Promise<BoxAnswer> {
    const deps = this.#deps.box;
    const box = this.#store.box();
    const agent = this.#agent().key;
    if (!boxServes(deps, agent) || box?.state !== "signed_in") return { kind: "moved_on", transient: false, told: false };
    const startedAt = this.#deps.clock.now();
    if (startedAt < this.#skipBoxUntil && this.#backupKeyCanServe(startedAt, purpose)) return { kind: "moved_on", transient: true, told: false };
    const token = await boxToken(deps.secret, box.name, box.setup);
    const sessionOwner = await boxSessionOwner(deps.secret, agent);
    let volume = this.#store.boxVolume();
    if (volume === null) {
      if (!claim.live()) return { kind: "fenced" };
      const health = await deps.client.health(box.url, token);
      if (health.kind === "up") this.#store.setBoxVolume(box.name, (volume = health.box ?? ""));
    }
    if (!claim.live()) return { kind: "fenced" };
    const res = await send(deps.client, box.url, token, volume ? { box: volume, epoch: claim.epoch } : undefined, sessionOwner);
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
        if (this.#backupKeyCanServe(now, purpose)) this.#skipBoxUntil = now + BOX.skipAfterUnavailableMs;
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

  /** While a forget is open, only its own messages go out, each under the epoch it was written in. */
  async #deliverReady(): Promise<void> {
    const claim = this.#store.claim();
    for (const row of this.#store.readyOutbox(this.#deps.clock.now(), DELIVERY_BATCH)) {
      const epoch = row.epoch;
      const gate = epoch !== null ? { epoch, live: () => this.#store.forget().epoch === epoch } : claim;
      if (gate) await this.#deliver(row, gate);
    }
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

    if (row.privacy === null && row.saved === null && !row.replyOnly && !mayspend(this.#store.admission())) return this.#store.drop(row.id, "removed", now, unaskedLog("dropped_removed", null), "pending");
    if (row.attempts >= MAX_DELIVERY_ATTEMPTS) return this.#store.drop(row.id, "failed", now, unaskedLog("failed", row.admittedDay), "pending");
    if (a.status === "blocked") return this.#store.drop(row.id, "blocked", now, unaskedLog("dropped_blocked", null), "pending");
    if (row.privacy === "receipt" && row.inDoubt && row.to.channel === "telegram") return this.#store.drop(row.id, "failed", now, [], "pending");

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

    const page = row.saved === null ? null : this.#store.savedPage(row.saved, a, row.privacy === "page");
    const texts: readonly [string, ...string[]] | null = page ? [page.text] : row.saved === null ? row.texts : null;
    if (texts === null) return this.#store.drop(row.id, "failed", now, [], "pending");
    const routineAt = row.routine ? this.#deps.clock.now() : null;
    if (routineAt !== null && this.#store.routineSendsInLastDay(routineAt) >= OUTREACH.dailyRoutineBudget) {
      diagnostic("routine_delivery_budget");
      return this.#store.drop(row.id, "budget", routineAt, unaskedLog("dropped_budget", day), "pending");
    }
    if (!this.#store.markSending(row.id, day, claim.epoch, routineAt, row.privacy !== null)) return;
    const delivery = await this.#deps.channels[row.to.channel].deliver({ ...row, texts }, now, claim.live);
    const after = this.#deps.clock.now();
    if (row.routine) this.#store.finishRoutineDelivery(row.id, delivery.kind === "sent" || delivery.kind === "in_doubt" ? after : null);
    switch (delivery.kind) {
      case "sent":
        if (page && row.to.channel === "dev" && this.env.DEV_MODE === "1") {
          this.#devSavedPages.set(row.id, page.text);
          if (this.#devSavedPages.size > 50) {
            const oldest = this.#devSavedPages.keys().next();
            if (!oldest.done) this.#devSavedPages.delete(oldest.value);
          }
        }
        return this.#store.markSent(row.id, delivery.via, after, unaskedLog("sent", day), page?.next, delivery.providerMessages ?? []);
      case "retry":
      case "in_doubt": {
        const at = (after + delivery.afterMs) as EpochMs;
        // A receipt that may have gone out isn't sent twice, since Telegram has no idempotency key; /forget status offers it.
        if (row.privacy === "receipt" && (delivery.kind === "in_doubt" || row.to.channel === "telegram")) {
          return this.#store.drop(row.id, "failed", after, [], "sending");
        }
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

  /**
   * The open forget's last step: erase the person's box, then complete with its receipt. A box that can't be erased
   * now leaves the forget open, retried with backoff; the person is told it is pending and reminded a few times.
   */
  async #stepForget(): Promise<void> {
    if (this.#erasure()) return;
    const now = this.#deps.clock.now();
    const f = this.#store.forgetOp();
    if (f?.phase === "erase" && f.retryAt !== null && f.retryAt <= now) {
      const erased = await this.#eraseBox(f.epoch);
      if (this.#erasure()) return;
      const after = this.#deps.clock.now();
      if (erased === null) this.#store.erasePending(f.op, after);
      else {
        const a = this.#agent();
        try {
          if (this.#store.completeForget(f.op, erased.volume, this.#backups(), checkinWakeup(after, a.tz, a.checkinLocal), after)) this.#devSavedPages.clear();
        } catch (err) {
          this.#store.erasePending(f.op, after);
          throw err;
        }
      }
    }
    this.#store.remindIfDue(this.#deps.clock.now());
  }

  /**
   * Erases the person's box under `epoch`; null while it can't be done yet. A box that isn't up, has no erase, or
   * answers for another volume stays pending: only an erase of the volume this Worker knows can complete a forget.
   */
  async #eraseBox(epoch: ForgetEpoch): Promise<{ readonly volume: string | null } | null> {
    const deps = this.#deps.box;
    const box = this.#store.box();
    if (!box) return { volume: null };
    if (!boxServes(deps, this.#agent().key)) return null;
    if (box.state === "provisioning" || box.state === "reclaiming") return null;
    const token = await boxToken(deps.secret, box.name, box.setup);
    let volume = this.#store.boxVolume();
    if (volume === null) {
      const health = await deps.client.health(box.url, token);
      if (health.kind !== "up") return null;
      this.#store.setBoxVolume(box.name, (volume = health.box ?? ""));
    }
    if (volume === "") return null;
    const erased = await deps.client.erase(box.url, token, epoch);
    if (erased.kind !== "erased") {
      diagnostic("box_erase_pending");
      return null;
    }
    if (erased.box !== volume) {
      this.#store.setBoxVolume(box.name, null);
      return null;
    }
    return { volume };
  }

  /** Whether every backup copy at our hosts has a documented expiry within the receipt's window. */
  #backups(): Backups {
    const host = this.#deps.box?.host.kind ?? null;
    const box = this.#store.claudePlan() || this.#store.box() !== null;
    return backupsWithin([HOST_BACKUP_DAYS.durableObject, ...(box && host !== null ? HOST_BACKUP_DAYS[host] : [])]);
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
      if (this.#erasure()) return;
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
    if (this.#erasure()) return;
    const now = this.#deps.clock.now();
    const catchUp = await this.#catchUpAccess(now);
    if (this.#erasure()) return;
    const r = this.#store.readiness(now);
    const a = this.#store.agent();
    const held = this.#store.held();
    const fireTimes = a && !held && !r.channelEventWaiting ? r.earliestWakeups.map((w) => fireAt(w, a.tz)) : [];
    const box = this.#store.box();
    const retiring = box?.state === "reclaiming" && box.reason === "removed";
    const t = nextAlarm({
      now,
      inboxReadyAt: held ? null : (r.inboxReadyAt ?? (catchUp ? now : null)),
      wakeupFireAt: fireTimes.length > 0 ? (Math.min(...fireTimes) as EpochMs) : null,
      outboxReadyAt: held ? r.privacyReadyAt : r.outboxReadyAt,
      billingAlertAt: this.#billingAlertAt(),
      forgetAt: r.forgetAt,
      logsReadyAt: r.logsReadyAt,
      compactionRetryAt: held ? null : r.compactionRetryAt,
      boxAt: retiring || (this.#deps.box && mayspend(this.#store.admission())) ? r.boxAt : null,
    });
    const challengeTimes = [ERASE_CHALLENGE, START_CHALLENGE]
      .map((key) => this.ctx.storage.kv.get<AccountChallenge>(key)?.expiresAt ?? Infinity);
    const next = Math.min(t ?? Infinity, ...challengeTimes);
    if (next === Infinity) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
  }

  async #armNoLaterThan(t: EpochMs): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    const at = Math.max(t, this.#deps.clock.now());
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
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
  const quoted = e.quote?.kind === "text" ? redactSecrets(e.quote.text) : null;
  if (!r.found && quoted?.found !== true) return envelope;
  const quote = quoted?.found && e.quote?.kind === "text" ? { ...e.quote, text: quoted.text } : e.quote;
  const event = { ...e, text: r.text, redacted: true as const };
  return { ...envelope, event: quote ? { ...event, quote } : event };
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
  const ledger = d1Ledger(env.LEDGER);
  return {
    connect: connect((input, init) => fetch(input, init)),
    keys: config.keys,
    included: config.included,
    ledger,
    channels: makeChannels(config, ledger),
    operatorChat: config.operatorChat,
    clock: { now: () => Date.now() as EpochMs },
    box: boxDeps(config.box),
    billing: {
      config: config.billing,
      store: d1Billing(env.LEDGER),
      stripe: config.billing.on ? stripeApi(config.billing.stripe, config.billing.rules, (input, init) => fetch(input, init)) : null,
    },
    admission: config.admission,
    firstContactConsent: !config.devMode,
  };
}
