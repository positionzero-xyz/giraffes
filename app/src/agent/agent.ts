import { DurableObject } from "cloudflare:workers";
import type { z } from "zod";
import { makeChannels, type ChannelRegistry } from "../channels/channel";
import { loadConfig, type Env } from "../config";
import { assertNever, type AgentKey, type EpochMs, type EventKey, type InboundEnvelope, type MicroUsd, type PersonStatus, type TimeZone } from "../domain";
import { d1Ledger, modelCallRow, type LeaseAnswer, type Ledger, type LogRow, type UnaskedStatus } from "../ledger/ledger";
import { makeModelClient, routeOf, type ModelClient, type ModelId, type ModelResult, type Purpose, type Usage } from "../model/model";
import { admitUnasked, OUTREACH } from "../policy/outreach";
import { checkinWakeup, fireAt, nextAlarm, planFiring, SCHEDULE, type PendingWakeup } from "../policy/schedule";
import { costOf, decideReservation, estimate, SPEND } from "../policy/spend";
import { DEFAULT_TIME_ZONE, localDate, startOfLocalDay, utcMonth } from "../policy/time";
import { compactionCommit, CompactionOutputSchema, planCompaction } from "./compaction";
import { COMPACTION_SYSTEM, TURN_SYSTEM } from "./prompt";
import { migrate } from "./schema";
import { AgentStore, type AgentRow, type OutboxRow, type OutboxView, type Reservation, type Settlement } from "./store";
import {
  bypassModel,
  logsForTurn,
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
const utf8 = new TextEncoder();

export type Clock = { now(): EpochMs };

export type AgentDeps = {
  readonly model: ModelClient;
  readonly ledger: Ledger;
  readonly channels: ChannelRegistry;
  readonly clock: Clock;
};

type ModelCall<T> =
  | { readonly kind: "ok"; readonly value: T; readonly reservation: Reservation; readonly usage: Usage }
  | { readonly kind: "failed"; readonly reservation: Reservation; readonly usage: Usage | null }
  | { readonly kind: "unavailable"; readonly reservation: Reservation | null; readonly inDoubt: boolean }
  | { readonly kind: "refused"; readonly scope: "user_cap" | "global_ceiling"; readonly model: ModelId; readonly estimate: MicroUsd };

export type AgentSnapshot = {
  readonly agent: { readonly key: AgentKey; readonly status: PersonStatus; readonly tz: TimeZone } | null;
  readonly turns: readonly TurnRow[];
  readonly outbox: readonly OutboxView[];
  readonly pendingWakeups: readonly PendingWakeup[];
  readonly unaskedSentToday: number;
  readonly spendThisMonthMicro: MicroUsd;
};

export class Agent extends DurableObject<Env> {
  readonly #store: AgentStore;
  #deps: AgentDeps;
  // A DO interleaves requests during `await fetch`. The guard is in memory on purpose: there is one live
  // instance per DO, and if it dies the drain dies with it, so the guard never outlives the work it protects.
  #drain: Promise<void> | null = null;

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
    };
    if (this.#store.enqueue(envelope, first, now) === "duplicate") return "duplicate";
    await this.#armNoLaterThan(now);
    this.ctx.waitUntil(this.alarm());
    return "queued";
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
    return {
      agent: a ? { key: a.key, status: a.status, tz: a.tz } : null,
      turns: this.#store.recentTurns(50),
      outbox: this.#store.recentOutbox(50),
      pendingWakeups: this.#store.pendingWakeups(),
      unaskedSentToday: a ? this.#store.unaskedAdmitted(localDate(now, a.tz)) : 0,
      spendThisMonthMicro: this.#store.monthSpend(utcMonth(now)).spent,
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
      // Each phase fails alone, and the cheap ones go first, so a failing compaction can't hold back
      // delivery or log shipping.
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

    const call = await this.#callModel("turn", TURN_SYSTEM, renderUser(view), TurnOutputSchema, batch.items[0].key, a.key);
    switch (call.kind) {
      case "ok": {
        const settle = { reservation: call.reservation, cost: costOf(call.reservation.model, call.usage) };
        return this.#commit(planTurn(call.value, view), view, a.key, settledCall(settle, call.usage), settle);
      }
      case "failed": {
        const settle = { reservation: call.reservation, cost: call.usage ? costOf(call.reservation.model, call.usage) : NO_COST };
        return this.#commit(planWithoutModel(view, { kind: "model_failed" }), view, a.key, settledCall(settle, call.usage), settle);
      }
      case "refused": {
        const alreadyToldToday = this.#store.refusedToday(startOfLocalDay(view.now, view.tz));
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
  ): void {
    const now = this.#deps.clock.now();
    const logs = [...logsForTurn({ agent, commit, view, call, startedAt: view.now, now }), ...extra];
    this.#store.commitTurn(commit, settle, logs, now);
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
    if (attempts >= TURN.maxModelAttempts) {
      return this.#commit(planWithoutModel(view, { kind: "model_failed" }), view, agent, { kind: "none" }, settle, logs);
    }
    const keys = view.batch.items.map((i) => i.key);
    this.#store.releaseBatch(keys, (now + MODEL_RETRY_BASE_MS * 2 ** (attempts - 1)) as EpochMs, settle, logs, now);
  }

  async #callModel<T>(
    purpose: Purpose,
    system: string,
    user: string,
    schema: z.ZodType<T>,
    eventKey: EventKey | null,
    agent: AgentKey,
  ): Promise<ModelCall<T>> {
    const route = routeOf(purpose);
    const now = this.#deps.clock.now();
    const month = utcMonth(now);
    const est = estimate(route.model, utf8.encode(system).length + utf8.encode(user).length, route.maxTokens);
    for (;;) {
      const decision = decideReservation(this.#store.monthSpend(month), est);
      if (decision.kind === "reserve") break;
      if (decision.kind === "refuse") return { kind: "refused", scope: decision.scope, model: route.model, estimate: est };
      const seq = this.#store.beginLease(month);
      let answer: LeaseAnswer;
      try {
        answer = await this.#deps.ledger.requestLease({ agent, month, seq, micro: decision.chunk, at: now });
      } catch (err) {
        console.warn("lease request failed", err);
        return { kind: "unavailable", reservation: null, inDoubt: false };
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
      // The instance is alive, so close the reservation here rather than leave it for recover(). We
      // can't tell whether the request was billed, so it is charged at its estimate.
      const at = this.#deps.clock.now();
      this.#store.settle({ reservation, cost: reservation.estimate }, [callRow(agent, reservation, "in_doubt", reservation.estimate, null, at)], at);
      throw err;
    }
    if (res.ok) return { kind: "ok", value: res.value, reservation, usage: res.usage };
    if (res.failure === "unavailable" || res.failure === "in_doubt") {
      return { kind: "unavailable", reservation, inDoubt: res.failure === "in_doubt" };
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
        admitted: day,
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
    const plan = planCompaction(this.#store.compactionInput());
    if (!plan) return;
    let call: ModelCall<z.infer<typeof CompactionOutputSchema>>;
    try {
      call = await this.#callModel("compaction", COMPACTION_SYSTEM, plan.user, CompactionOutputSchema, null, a.key);
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
    const r = this.#store.readiness();
    const a = this.#store.agent();
    const fireTimes = a ? r.earliestWakeups.map((w) => fireAt(w, a.tz)) : [];
    const t = nextAlarm({
      now: this.#deps.clock.now(),
      inboxReadyAt: r.inboxReadyAt,
      wakeupFireAt: fireTimes.length > 0 ? (Math.min(...fireTimes) as EpochMs) : null,
      outboxReadyAt: r.outboxReadyAt,
      logsReadyAt: r.logsReadyAt,
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

/** A call the API turned away costs nothing; one whose response was lost may have been billed in full. */
function closeUnavailable(call: Unavailable, agent: AgentKey, now: EpochMs): { settle: Settlement | null; logs: LogRow[] } {
  const r = call.reservation;
  if (!r) return { settle: null, logs: [] };
  const cost = call.inDoubt ? r.estimate : NO_COST;
  return { settle: { reservation: r, cost }, logs: [callRow(agent, r, call.inDoubt ? "in_doubt" : "unavailable", cost, null, now)] };
}

function settledCall(settle: Settlement, usage: Usage | null): TurnCall {
  const { reservation, cost } = settle;
  return { kind: "settled", reservationId: reservation.id, model: reservation.model, estimate: reservation.estimate, cost, usage };
}

function callRow(
  agent: AgentKey,
  r: Reservation,
  status: "settled" | "unavailable" | "in_doubt",
  cost: MicroUsd,
  usage: Usage | null,
  at: EpochMs,
): LogRow {
  return modelCallRow({ id: r.id, agent, purpose: r.purpose, model: r.model, status, estimate: r.estimate, cost, usage, at });
}

function defaultDeps(env: Env): AgentDeps {
  const config = loadConfig(env);
  return {
    model: makeModelClient(config.model),
    ledger: d1Ledger(env.LEDGER, SPEND.globalCeilingMicro),
    channels: makeChannels(config),
    clock: { now: () => Date.now() as EpochMs },
  };
}
