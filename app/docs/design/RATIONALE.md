# Rationale: week-1 agent core (opus candidate)

## Problem

Build a per-person agent on Cloudflare Workers and SQLite-backed Durable Objects. A person texts it on LINE, Telegram or a dev page. It replies, keeps reminders, sends one daily check-in, and never resets its memory. The platform makes the shape non-obvious in four ways:

- **A Durable Object is not serial across `await`.** While a turn awaits the model call, other requests are delivered to the same object. "One event at a time" therefore has to be built.
- **There is one alarm per object.** That one alarm must serve wake-ups, debounced messages, delivery retries and log shipping.
- **Every external effect can happen twice or not at all.** That covers webhooks, alarms, LINE pushes, Telegram sends and D1 writes. A crash can land between any two of them.
- **Two facts cross users.** The global $1,500 ceiling and the gate logs need one owner each. A per-person object can't own them.

Constraints that cross the boundary: the LINE reply token is single-use and lives for about a minute; pushes are billed, and only pushes take `X-Line-Retry-Key`. Telegram has no idempotency key. The week-2 job-result event, versioned jobs, approvals, groups and invites must fit in later without rework.

## Usage (caller's view)

See `USAGE.md`. In short, the Worker calls `agent.enqueue(envelope)` and returns 200. Everything else happens in `agent.alarm()`. A test drives `devChat(...).say(...)` / `.advanceTo(...)` / `.received()` against the real Worker route, using a scripted model and a fake clock.

## Shape

### Core idea: one way in, one executor, derived alarm

`Agent` (one DO per person, `app/src/agent/agent.ts`) has three public methods: `enqueue`, `alarm`, `snapshot` (plus a test-only `withDeps`).

- `enqueue` does one `INSERT OR IGNORE` into `inbox` and arms the alarm no later than the row's `ready_at`. It never processes anything.
- `alarm` is the only code that calls a model, changes memory or sends a message. It drains in a fixed priority order: recover → fire due wake-ups → turns (each followed by delivery) → compaction → deferred delivery → ship logs → prune. Then it re-arms.
- The alarm time is **computed, never stored**: `nextAlarm(min of inbox ready_at, fireAt(earliest pending wake-up), outbox ready_at, log retry_at)`. No "next alarm" field can drift from the tables, per single-source-of-truth.
- A second `alarm()` call while a drain runs joins the in-flight promise. The guard is in memory on purpose. A DO has one live instance, so the guard can't outlive the work it protects. Anything the dead instance left in flight, the next drain's `recover()` treats as crashed.

This makes serial processing explicit without a lock table. While a turn awaits the model, the only operations that can interleave are an `INSERT` into the inbox and a read.

### Data structures (DO SQLite, `app/src/agent/schema.ts`)

| Table | Owner of | Key invariant |
|---|---|---|
| `inbox` | the durable queue, all event kinds | `event_key UNIQUE`; status `pending → processing → done/failed`; `attempts` bounds crash retries |
| `turn` | verbatim recent conversation | prompt reads the last 30 only, so the prompt stays bounded even when compaction lags |
| `memory` (1 row) + `memory_note` | compacted past + model notes | compaction is compare-and-set on `through_turn_seq` |
| `wakeup` | reminders and the check-in | partial `UNIQUE(key) WHERE status='pending'` is the duplicate rule; check-in successor inserted in the same tx as its firing |
| `outbox` | everything leaving | one row per turn (all its texts); `id` = UUID = LINE retry key; `intent` decided by code; `admitted_day` makes budget admission idempotent |
| `spend_month` + `reservation` | per-user spend and global-ceiling leases | `reserved` is `SUM(reservation)`, never stored |
| `log_outbox` | log rows not yet in D1 | written in the same tx as the fact it records |

Derived, not stored: unasked-sent-today (`COUNT` over `outbox.admitted_day`), lateness (`firedAt − dueAt`), reserved spend, "already told them about the limit today" (the inbox outcomes), the alarm time.

Cross-user (D1, `app/src/ledger/d1-schema.sql`): append-only `agent`, `turn_log`, `model_call`, `unasked_message`, `lifecycle`, plus `spend_lease`. The gates are SQL views. "Did a completed task follow this unasked message" is a view, not an update.

### Types carry the invariants (`app/src/domain.ts`)

- Branded `EpochMs`, `MicroUsd` (integer), `TimeZone`, `LocalDateTime`, `EventKey`, `WakeupKey`, `OutboxId`, `AgentKey`. An `EventKey` can only come from the `eventKey.*` constructors, so every dedupe key has a stated source.
- `intentOf(event)` decides reply vs unasked from the event kind. The model has no field for it, so it can't route around the budget or quiet hours.
- The model reads and writes only local wall time (`LocalDateTime`). Zone math lives in `policy/time.ts` alone.
- `ChannelRegistry` is a mapped type over `CHANNEL_IDS`. Adding a channel id without an adapter fails the build, so there is no hand-synced list.
- `LogRow` is one union. Each variant maps to one D1 table in one exhaustive switch.
- `AgentEvent` is a union stored as JSON with no SQL CHECK on kind. Week 2's `job_result` is one new variant, and the exhaustive switches name every place that has to handle it.

### Where validation lives

- Channel adapters authenticate and parse. They do the HMAC over the raw body (LINE), the constant-time header compare (Telegram), and identity extraction. Wire types never leave `channels/<name>.ts`.
- `loadConfig` validates env once.
- Model output is validated twice. The zod schema checks shape in the backend. `planTurn` checks meaning: times, limits, keys. Inside the agent, everything is trusted typed data (per boundary-discipline).

### Interface depth

The Worker learns one method (`enqueue`). A channel implements two (`receive`, `deliver`). A model backend implements one (`parse`). Behind `enqueue` sit queueing, coalescing, scheduling, budget, spend reservation, global leasing, compaction, delivery with reply-or-push, and crash recovery. None of that is a caller's concern. All policy is pure and lives in `policy/` (`schedule`, `outreach`, `spend`, `time`) and `agent/turn.ts` / `compaction.ts`. Every function there is testable without the runtime.

### Module map

```
app/src/worker.ts            routes /webhook/:channel → adapter.receive → Agent.enqueue; dev routes
app/src/config.ts            Env → Config (only reader of env strings)
app/src/domain.ts            branded units, ids, events, intent, outbound, task labels
app/src/agent/agent.ts       the DO: enqueue, alarm drain, metered model call, delivery, re-arm
app/src/agent/store.ts       the only SQL; sync methods; tx wrapper (imported only by agent.ts)
app/src/agent/schema.ts      DO DDL + migrate()
app/src/agent/turn.ts        TurnOutputSchema, renderUser, planTurn, planWithoutModel, logsForTurn (pure)
app/src/agent/compaction.ts  planCompaction, compactionCommit (pure)
app/src/agent/prompt.ts      byte-stable system prompts + playbook placeholder
app/src/policy/{time,schedule,outreach,spend}.ts   pure rules
app/src/model/{model,anthropic,bridge,scripted}.ts port + routing + prices, three backends
app/src/channels/{channel,line,telegram,dev}.ts    port + registry, three adapters
app/src/ledger/{ledger.ts,d1-schema.sql}           D1 append + leases, gate views
app/dev/{bridge.ts,chat.html}                      local claude -p bridge, dev chat page
app/test/{testkit,agent.test,policy.test}.ts
```

Tracing any flow takes three files: `worker.ts` → `agent.ts` → one pure module (`turn.ts`, `policy/*`).

### Dominant access patterns, traced

1. **Inbound message → reply (hot path).** Worker: `adapter.receive` → `enqueue`, which is one INSERT, plus `getAlarm`/`setAlarm`. After the 1.5 s debounce, `alarm`: `claimBatch` (indexed `inbox(status, ready_at, seq)`) → `turnContext` (memory row, notes, last 30 turns by PK desc, pending wake-ups by index) → `decideReservation` over `spend_month` + `SUM(reservation)` (local, no network) → one model call → `commitTurn` (one tx) → `deliverReady` → LINE reply API. Network hops: the model and the channel. D1 isn't touched on the hot path: logs ship after the inbox empties, and a lease is requested about once per $0.50 of a person's spend.
2. **Wake-up scheduled and fired.** Scheduling happens inside the turn's commit (partial unique index). Firing: `#rearm` → alarm at `fireAt(min due_at)` → `dueWakeups` (index `wakeup(status, due_at)`) → `planFiring` → `applyFiring` (inbox insert keyed `wake:<id>`) → same turn path, with `intent = unasked` → `admitUnasked` at delivery.
3. **Daily check-in.** The same as a wake-up, with key `daily-checkin` and inbox key `checkin:<local date>`. The successor is inserted in the firing transaction, and `follow` ensures one exists.
4. **Gate queries.** D1 views over append-only tables, indexed by `(agent_key, time)`. 100 users × a few hundred rows a week is trivially small.
5. **Global ceiling.** About once per $0.50 per person, there is one conditional `INSERT … SELECT … WHERE SUM + chunk <= ceiling` in D1. Nothing per call.

### Failure cases

- **Crash mid-event.** The claim committed `processing` and `attempts+1`, and the reservation row is durable. Nothing else is written until `commitTurn`, which is one transaction: turns, wake-ups, notes, outbox, inbox done, settle and logs land together or not at all. The next drain's `recover()` puts the batch back to `pending` and settles the orphaned reservation at its estimate. The model can't tell us what it billed, so we charge conservatively and log `recovered_after_crash`. The event is then re-run from scratch, and none of its effects were applied before. After 3 claims, the batch commits a `poison` turn with a fixed apology, so a crash loop can't eat the person's queue.
- **Crash after commit, before or while sending.** The outbox row is `pending` or `sending`. `recover()` turns `sending` into `pending` with `in_doubt = 1`. LINE: an in-doubt row skips the reply token and pushes with `X-Line-Retry-Key = outbox.id`. If the first push landed, LINE answers 409, which we treat as sent. If the first attempt was a reply that landed, the person sees a duplicate; we accept that. Telegram: resent, with a possible duplicate. We accept a rare duplicate over a lost reminder. Budget admission was recorded with `admitted_day` before the fetch, so it is never charged twice.
- **Duplicate webhook delivery.** `inbox.event_key` is `line:<webhookEventId>` / `tg:<update_id>` / `dev:<client id>`, and the insert is `INSERT OR IGNORE`. A redelivery returns `"duplicate"` and the Worker still answers 200. Done rows are kept 14 days for this.
- **Alarm firing twice.** A concurrent second call joins the in-flight drain. A sequential second call finds nothing due: wake-ups were closed in the same transaction that inserted `wake:<id>`, and even a replayed insert is ignored by the unique key. Check-ins are additionally keyed per local day.
- **Message arriving while a model call is in flight.** `enqueue` inserts it, which is allowed during the outbound fetch. The in-flight turn commits as planned. The drain loop then claims the new message in the next batch, and that turn's prompt contains the previous reply. The 1.5 s debounce plus batching of consecutive ready messages folds a burst of texts into one turn before any call starts.
- **Model unavailable.** The batch goes back to `pending` with backoff (`releaseBatch`) and attempts are kept, so a long outage ends as `model_failed`, not a loop. Invalid output or a refusal commits a fixed "say it again" reply for messages and nothing for proactive events. All of it is logged.
- **D1 down.** Logs wait in `log_outbox` and ship later with deterministic ids (exactly once in effect). A lease request that can't reach D1 makes the turn retry later. It never runs the call unreserved.

### What it deliberately does not do

- No in-request processing, and no `ctx.waitUntil` turns.
- No lock rows.
- No stored alarm time.
- No model-chosen ids, intents or time zones.
- No mutable counters for anything that can be counted.
- No D1 write inside a turn.
- No Cloudflare Queues.
- No Agents SDK.

## Synthesis decision

Two candidates were sketched in parallel (Claude Opus and GPT-6.1 Sol), and a third model (Gemini 3.8 Flash) judged them read-only. This sketch (Opus) is the base. The judge scored it 26/30 against 21/30, and the orchestrator's own reading agreed. Both candidates converged on the same core: an inbox in the person's DO, an in-memory drain promise plus recovery from storage, one transaction per turn, a derived alarm, pure policy and log export to D1. The base won on crash-safe delivery (it resends in doubt, with LINE's retry key, rather than possibly losing a reminder), local-only spend on the hot path, and reminder keys the model can name across turns.

Amendments to the sketch, which the implementation follows:

1. **No debounce.** `enqueue` still inserts and arms the alarm as the durable backstop. It also starts the drain at once through `ctx.waitUntil`, so a reply never waits on alarm scheduling. Messages already pending when a batch is claimed are still folded into one turn. (From the Sol candidate.)
2. **`maxRetries: 0` on the Anthropic client.** Every billed attempt goes through its own reservation, so the SDK can't retry past the spend ledger. (From the Sol candidate.)
3. **Ordered lifecycle.** Reachability keeps the provider timestamp of the last follow, unfollow or block. An older or replayed lifecycle event is logged but can't change reachability. (From the Sol candidate.)
4. **Wake-up origin decides budget and quiet hours.** Each wake-up stores who asked for it: `person`, `agent`, or `system` (the daily check-in). A message caused by a `person` wake-up is a requested reminder. It skips the unasked budget and fires at the time the person chose, even inside quiet hours. `agent` and `system` wake-ups are unasked, so they count against the budget and wait for quiet hours to end. Code sets the origin. A wake-up scheduled during a turn started by the person's own message may be `person` when the model marks it as asked for. Any wake-up scheduled during a proactive turn is `agent`. The cap of 20 pending wake-ups bounds the rest.
5. **Fix.** `spend_lease` inserts use the `agent_key` column that the D1 schema defines.

Not taken: the Sol candidate's typed week-2 job and approval stubs. The `AgentEvent` union already leaves the slot, and stubs written before the booking probe would be guesses.

## Tradeoffs accepted

- **Debounce.** We accept 1.5 s of added reply latency on every message in exchange for one turn (one model call, one coherent reply) per burst of texts.
- **Crash cost.** We accept charging a crashed call's full estimate in exchange for never under-counting spend after a crash.
- **Unused leases.** We accept up to $0.50 per active person of unused global lease at month end ($50 at 100 people) in exchange for no cross-user hop on the per-call path and no global hot row.
- **Duplicate sends.** We accept a possible duplicate on Telegram, and on an in-doubt LINE reply, after a crash in the send window, in exchange for never losing a reminder.
- **Budget order.** We accept that unasked budget is first come, first served within a day. A fourth reminder the person asked for is dropped, exactly as the brief's rule says. See the open questions.
- **Lossy compaction lag.** When compaction lags (budget or failure), turns between the summary and the 30-turn window drop out of the prompt until it catches up. In exchange, the prompt size is bounded and a reply never waits on compaction.
- **English notices.** Code-generated notices (quiet hours, limits, the late-notice fallback) are English. The model writes the late notice itself in the person's language, and code inserts the fallback only when the model omitted it.
- **One coarse DO class.** One `Agent` class holds everything for a person, with no actor per concern, in exchange for one transaction boundary per turn. The class is large, but the store and the pure planners keep each file single-purpose.

## Alternatives considered

- **Process inline in the webhook request**, awaiting the turn before answering. It looks simplest, but it exposes timeouts and interleaving to every caller. Two webhooks for one person would run two turns concurrently, and a crash loses the event with no retry. Rejected because it pushes the hardest invariant (serial, crash-safe) onto every entry point.
- **Cloudflare Queues** (a global queue, with a consumer calling the DO). This adds a hop and a second durable queue whose ordering per person isn't guaranteed. The DO's SQLite is already a durable serial queue. Rejected as two ways to do one task.
- **A lock or lease row** (`processing_until`) instead of the in-memory guard. That takes expiry tuning and a stale-lease path. A DO's single-instance guarantee already gives the property, and `recover()` handles the dead-instance case. Rejected as a structure that adds a failure mode to solve one that can't occur.
- **The global ceiling in a singleton DO, with reserve and settle per call.** Every model call would make a cross-object round trip to one hot object, and a crash between reserve and settle leaks global reservations that need their own recovery. Leases keep per-actor state per the separate-before-serializing principle, with the merge at the one point that needs it.
- **Analytics Engine for logs.** It samples, retains data for a limited time, and has no joins or exact counts. The gates need exact per-person weekly counts and joins (unasked → completed task). Rejected.
- **The Cloudflare Agents SDK** (`this.schedule`, state sync). It owns the alarm and its own schedule table. Our alarm must be the minimum over four tables with quiet-hours-aware fire times, and serial semantics across awaits must be explicit. Rejected: we would be working around the abstraction.
- **The model rewrites its whole memory each turn** (a `memory` field in the output). That costs output tokens on every turn and lets a single bad turn erase facts. Rejected for append-only notes plus periodic compaction, with compare-and-set.
- **Model-declared message intent or model-assigned wake-up ids.** Either lets the model bypass the budget or create silent duplicates. Rejected. Intent is derived, and keys are namespaced and unique among pending.

## Open questions and risks

- Should reminders the person explicitly asked for count against the 3/day unasked budget? The brief says every non-reply counts, so this design counts them. A heavy reminder user would lose the 4th.
- Is 1.5 s the right debounce, or should a lone short message ("ok") skip it?
- Is "charge the estimate on crash" acceptable for the cost gate, or should recovered calls be reported separately? They are separately labeled in `model_call.status`.
- `zodOutputFormat` with a `discriminatedUnion` of actions: does structured output on Haiku 5.5 accept the resulting `anyOf`? If not, flatten to one object with a `type` enum and optional fields, validated in `planTurn`. That is a local change.
- Is the system prompt long enough to clear the minimum cacheable prefix on Haiku 5.5? If not, caching silently does nothing. Measure it in week 1.
- Should the dev transcript expose raw outbox rows (useful when driving) or only what the person would see?
- **Risk: the 15-minute alarm wall-clock limit.** A drain is capped at 60 s of new batches and re-arms for now, so one person can't hold an alarm.
- **Risk: LINE quota exhaustion.** It returns 429 on push. This design drops the push and logs it as failed. The operator alert at 70% of quota is not designed here.

## Next implementation step

Fill in `policy/time.ts` and `policy/outreach.ts` and make `test/policy.test.ts` pass. Every later piece trusts their answers.
