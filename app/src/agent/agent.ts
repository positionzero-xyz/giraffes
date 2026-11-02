/**
 * One Durable Object per person. Owns that person's queue, memory, wake-ups, budget counters, spend and
 * outbox, in its own SQLite.
 *
 * Shape: one way in, one executor.
 *   - `enqueue` is the only entry for outside events. It writes one inbox row and arms the alarm.
 *     It never processes, so no request ever interleaves with a turn.
 *   - `alarm` is the only executor. It drains durable tables in a fixed order and re-arms the alarm to
 *     the earliest instant any table needs attention (derived each time, never stored).
 *
 * Why this is serial even though a DO interleaves requests during `await fetch` (the model call):
 * the only thing that can interleave is `enqueue` (an INSERT) or `snapshot` (a read). A second `alarm`
 * invocation while a drain is in flight joins the in-flight drain via `#drain` instead of starting
 * another. The guard is in memory on purpose: there is one live instance per DO, and if it dies the
 * drain dies with it, so the guard never outlives the work it protects. `store.recover()` at the
 * start of every drain then treats anything left in flight as crashed.
 */
import { DurableObject } from "cloudflare:workers";
import { loadConfig, type Env } from "../config";
import { makeChannels, type ChannelRegistry } from "../channels/channel";
import type { EpochMs, EventKey, InboundEnvelope, MonthKey } from "../domain";
import { d1Ledger, type Ledger } from "../ledger/ledger";
import { makeModelClient, routeOf, type ModelClient, type Purpose, type Usage } from "../model/model";
import { admitUnasked, OUTREACH } from "../policy/outreach";
import { fireAt, nextAlarm, planFiring } from "../policy/schedule";
import { SPEND, costOf, decideReservation, estimate } from "../policy/spend";
import { localDate, monthKey } from "../policy/time";
import { compactionCommit, CompactionOutputSchema, planCompaction } from "./compaction";
import { COMPACTION_SYSTEM, TURN_SYSTEM } from "./prompt";
import { migrate } from "./schema";
import { AgentStore, type Reservation } from "./store";
import { logsForTurn, planTurn, planWithoutModel, renderUser, TURN, TurnOutputSchema, type Batch } from "./turn";
import type { z } from "zod";

/** Messages wait this long so a burst of texts becomes one turn. Well inside LINE's ~60 s reply window. */
const MESSAGE_DEBOUNCE_MS = 1500;
/** One alarm invocation stops taking new batches after this and re-arms for now. */
const DRAIN_BUDGET_MS = 60_000;
const MAX_DELIVERY_ATTEMPTS = 5;

export type Clock = { now(): EpochMs };

/** Everything the agent talks to. Built from config in production; replaced wholesale in tests. */
export type AgentDeps = {
  readonly model: ModelClient;
  readonly ledger: Ledger;
  readonly channels: ChannelRegistry;
  readonly clock: Clock;
};

type ModelCall<T> =
  | { readonly kind: "ok"; readonly value: T; readonly reservation: Reservation; readonly usage: Usage }
  | { readonly kind: "failed"; readonly failure: "invalid_output" | "refused_by_model"; readonly reservation: Reservation; readonly usage: Usage | null }
  /** Transient. The caller requeues the batch with backoff instead of failing the turn. */
  | { readonly kind: "unavailable"; readonly reservation: Reservation | null }
  | { readonly kind: "refused"; readonly scope: "user_cap" | "global_ceiling" };

export class Agent extends DurableObject<Env> {
  readonly #store: AgentStore;
  #deps: AgentDeps;
  #drain: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#store = new AgentStore(ctx.storage);
    void ctx.blockConcurrencyWhile(async () => migrate(ctx.storage.sql));
    this.#deps = defaultDeps(env);
  }

  // =============================================================================================
  // Public surface: three methods.

  /**
   * The only way in. Durable on return. Idempotent on `envelope.key`.
   * Called by the Worker for every verified webhook event, before it answers the channel 200.
   */
  async enqueue(envelope: InboundEnvelope): Promise<"queued" | "duplicate"> {
    // TODO:
    //   now = clock.now()
    //   readyAt = envelope.event.kind === "message" ? now + MESSAGE_DEBOUNCE_MS : now
    //   result = store.tx(() => { store.ensureAgent(envelope);
    //                             return store.insertInbox(envelope.key, envelope.event, envelope.receivedAt, readyAt) })
    //   if (result === "inserted") await this.#armNoLaterThan(readyAt)
    //   return result === "inserted" ? "queued" : "duplicate"
    void MESSAGE_DEBOUNCE_MS;
    throw new Error("not implemented");
  }

  /** The only executor. Cloudflare may invoke it more than once; joining the in-flight drain makes that harmless. */
  override async alarm(): Promise<void> {
    if (this.#drain) return this.#drain;
    this.#drain = this.#runDrain().finally(() => {
      this.#drain = null;
    });
    return this.#drain;
  }

  /** Read-only view for the dev chat page and tests. */
  async snapshot(): Promise<AgentSnapshot> {
    throw new Error("not implemented");
  }

  /** Test seam. Refused unless MODEL_BACKEND=scripted, so it can't be reached in a deployed Worker. */
  withDeps(over: Partial<AgentDeps>): void {
    // TODO: if (loadConfig(this.env).model.backend !== "scripted") throw new Error("withDeps is test-only");
    this.#deps = { ...this.#deps, ...over };
  }

  // =============================================================================================
  // The drain. Order is the priority: replies before housekeeping.

  async #runDrain(): Promise<void> {
    const started = this.#deps.clock.now();
    try {
      // 1. Crash recovery. Requeue `processing`, mark `sending` in doubt, settle stale reservations,
      //    commit a poison turn for batches that hit TURN.maxAttempts.
      // TODO: const rec = this.#store.recover(started); for (const b of rec.poisoned) this.#commitPoison(b)
      // 2. Due wake-ups become inbox rows.
      this.#fireDueWakeups();
      // 3. Turns, one batch at a time, each followed by delivery so a reply never waits behind the next turn.
      while (this.#deps.clock.now() - started < DRAIN_BUDGET_MS) {
        const batch = this.#store.claimBatch(this.#deps.clock.now());
        if (!batch) break;
        await this.#turn(batch);
        await this.#deliverReady();
        this.#fireDueWakeups(); // a long drain can cross a due time
      }
      // 4. Housekeeping, only once the inbox is empty or the budget is spent.
      await this.#compactIfDue();
      await this.#deliverReady(); // deferred unasked rows that became admissible at 08:00
      await this.#flushLogs();
      this.#store.prune(this.#deps.clock.now());
    } catch (err) {
      // Unexpected errors are crash-equivalent: rows stay `processing`/`sending`, and the next drain's
      // recover() handles them (attempts bound the retries). We don't rethrow: our own re-arm below is
      // the retry policy, not Cloudflare's alarm backoff.
      console.error("drain failed", err);
    } finally {
      await this.#rearm();
    }
  }

  #fireDueWakeups(): void {
    // TODO:
    //   now = clock.now(); a = store.agent(); if (!a) return
    //   for (const f of planFiring(now, a.tz, a.status, a.checkinLocal, store.dueWakeups(now)))
    //     store.applyFiring(f, now)       // one tx each; inbox insert is OR IGNORE on 'wake:<id>' / 'checkin:<day>'
    void planFiring;
    throw new Error("not implemented");
  }

  /**
   * One turn: read a consistent view, call the model at most once, commit everything in one transaction.
   * Between the claim and the commit the only durable trace is `inbox.status = processing` and the open
   * reservation, both of which recover() knows how to undo.
   */
  async #turn(batch: Batch): Promise<void> {
    // TODO:
    //   now = clock.now(); a = store.agent()!
    //   first = batch.items[0].event
    //   view = { now, tz: a.tz, status: a.status, batch, ...store.turnContext(TURN.recentTurns),
    //            unaskedLeftToday: max(0, OUTREACH.dailyUnaskedBudget - store.unaskedAdmitted(localDate(now, a.tz))) }
    //
    //   if (first.kind === "lifecycle" && first.change === "block")
    //     return store.commitTurn(planWithoutModel(view, { kind: "block" }), null, logsForTurn(...), now)
    //
    //   call = await this.#callModel("turn", TURN_SYSTEM, renderUser(view), TurnOutputSchema, batch.items[0].key)
    //   switch (call.kind) {
    //     case "ok":          commit = planTurn(call.value, view); settle = { reservation, cost: costOf(model, usage), usage }
    //     case "failed":      commit = planWithoutModel(view, { kind: "model_failed" }); settle likewise (usage may be null → cost 0)
    //     case "refused":     commit = planWithoutModel(view, { kind: "refused_budget", alreadyToldToday: store.refusedToday(...) })
    //     case "unavailable": settle reservation at 0 if any; store.releaseBatch(keys, now + backoff(attempts)); return
    //                         (attempts was incremented by the claim, so a persistent outage ends in poison → model_failed)
    //   }
    //   store.commitTurn(commit, settle, logsForTurn(commit, view, settle, started, now), now)
    void TurnOutputSchema; void TURN_SYSTEM; void renderUser; void planTurn; void planWithoutModel; void TURN;
    void OUTREACH; void localDate;
    throw new Error("not implemented");
  }

  /**
   * The metered model call: route → estimate → reserve (lease more from the global ceiling if needed)
   * → call. Settlement is the caller's, inside its commit transaction, so cost and effects land together.
   * Never awaits while holding anything but the durable reservation row.
   */
  async #callModel<T>(
    purpose: Purpose,
    system: string,
    user: string,
    schema: z.ZodType<T>,
    eventKey: EventKey | null,
  ): Promise<ModelCall<T>> {
    // TODO:
    //   route = routeOf(purpose); now = clock.now(); month = monthKey(now)
    //   est = estimate(route.model, system.length + user.length, route.maxTokens)
    //   loop:
    //     d = decideReservation(store.monthSpend(month), est)
    //     "reserve"    → break
    //     "refuse"     → log model_call refused_user_cap; return { kind: "refused", scope: "user_cap" }
    //     "need_lease" → seq = store.beginLease(month)                       // durable intent first
    //                    try ans = await ledger.requestLease({ agent, month, seq, micro: d.chunk })
    //                    catch → return { kind: "unavailable", reservation: null }  // D1 down: retry the batch later
    //                    "granted" → store.grantLease(month, seq, d.chunk); continue
    //                    "ceiling" → store.denyLease(month, seq); log refused_global_ceiling;
    //                                return { kind: "refused", scope: "global_ceiling" }
    //   r = { id: crypto.randomUUID(), month, purpose, model: route.model, estimate: est }
    //   store.reserve(r, eventKey, now)
    //   res = await model.parse({ purpose, system, user, schema })
    //   res.ok → ok; res.failure === "unavailable" → unavailable(r); else failed(r)
    void routeOf; void monthKey; void estimate; void decideReservation; void costOf; void SPEND;
    void (null as unknown as MonthKey);
    throw new Error("not implemented");
  }

  /**
   * Deliver ready outbox rows. Unasked rows pass `admitUnasked` exactly once (admitted_day is recorded
   * with the pending→sending transition, before the network call), so a crash after admission never
   * charges the budget twice and never re-judges a row that was already allowed.
   */
  async #deliverReady(): Promise<void> {
    // TODO:
    //   now = clock.now(); a = store.agent()!
    //   for (row of store.readyOutbox(now, 20)):
    //     day = row.admittedDay
    //     if (row.intent === "unasked" && day === null):
    //       v = admitUnasked({ now, tz: a.tz, sentToday: store.unaskedAdmitted(localDate(now, a.tz)),
    //                          dailyBudget: OUTREACH.dailyUnaskedBudget, status: a.status })
    //       "defer" → store.reschedule(row.id, v.until); continue
    //       "drop"  → store.drop(row.id, v.reason, now, [unasked log dropped_*]); continue
    //       "send"  → day = v.day
    //     else if (a.status === "blocked") → store.drop(row.id, "blocked", now, []); continue
    //     store.markSending(row.id, day)                         // committed before the fetch
    //     d = await channels[a.identity.channel].deliver(row, now)
    //     "sent"           → store.markSent(row.id, d.via, now, unasked ? [unasked log sent] : [])
    //     "retry"          → row.attempts + 1 >= MAX_DELIVERY_ATTEMPTS ? drop failed : reschedule(now + d.afterMs)
    //     "failed"         → drop failed (+ unasked log failed)
    //     "recipient_gone" → store.tx: drop gone, agent.status = blocked, lifecycle log (source "delivery")
    void admitUnasked; void MAX_DELIVERY_ATTEMPTS;
    throw new Error("not implemented");
  }

  async #compactIfDue(): Promise<void> {
    // TODO:
    //   plan = planCompaction(store.compactionInput(), now); if (!plan) return
    //   call = await this.#callModel("compaction", COMPACTION_SYSTEM, plan.user, CompactionOutputSchema, null)
    //   "ok"           → store.commitCompaction(compactionCommit(plan, call.value), settle, logs, now)
    //                    (false = memory moved under us; impossible with one drain, but harmless)
    //   "failed"       → store.settle(...)
    //   "refused" | "unavailable" → return (bounded prompt means a lagging summary only loses recall)
    void planCompaction; void compactionCommit; void CompactionOutputSchema; void COMPACTION_SYSTEM;
    throw new Error("not implemented");
  }

  async #flushLogs(): Promise<void> {
    // TODO: rows = store.pendingLogs(100); if empty return
    //       try { await ledger.append(rows); store.logsShipped(rows.map(r => r.id)) }
    //       catch { store.logsFailed(now) }   // exponential retry_at, read by readiness()
    throw new Error("not implemented");
  }

  /** Set the one alarm to the earliest instant any table needs us, or delete it. */
  async #rearm(): Promise<void> {
    // TODO:
    //   r = store.readiness(); a = store.agent()
    //   t = nextAlarm({ now, inboxReadyAt: r.inboxReadyAt,
    //                   wakeupFireAt: r.earliestWakeupDue && a ? fireAt(r.earliestWakeupDue, a.tz) : null,
    //                   outboxReadyAt: r.outboxReadyAt, logsReadyAt: r.logsReadyAt })
    //   t === null ? await ctx.storage.deleteAlarm() : await ctx.storage.setAlarm(t)
    void nextAlarm; void fireAt;
    throw new Error("not implemented");
  }

  async #armNoLaterThan(t: EpochMs): Promise<void> {
    // TODO: cur = await ctx.storage.getAlarm(); if (cur === null || cur > t) await ctx.storage.setAlarm(t)
    //       If a drain is running, its final #rearm() recomputes anyway; this only guarantees the new row
    //       is never stranded when the object is idle.
    throw new Error("not implemented");
  }
}

export type AgentSnapshot = {
  readonly agent: { readonly key: string; readonly status: string; readonly tz: string } | null;
  readonly turns: readonly { readonly role: string; readonly text: string; readonly at: number }[];
  readonly outbox: readonly { readonly id: string; readonly intent: string; readonly texts: readonly string[]; readonly status: string; readonly via: string | null }[];
  readonly pendingWakeups: readonly { readonly key: string; readonly kind: string; readonly dueAt: number; readonly note: string }[];
  readonly unaskedSentToday: number;
  readonly spendThisMonthMicro: number;
};

function defaultDeps(env: Env): AgentDeps {
  // TODO: config = loadConfig(env)
  //   return { model: config.model.backend === "scripted" ? unscripted() : makeModelClient(config),
  //            ledger: d1Ledger(env.LEDGER, SPEND.globalCeilingMicro),
  //            channels: makeChannels(config),
  //            clock: { now: () => Date.now() as EpochMs } }
  //   unscripted(): a ModelClient whose parse throws "test forgot to inject a script"
  void loadConfig; void makeChannels; void makeModelClient; void d1Ledger;
  throw new Error("not implemented");
}
