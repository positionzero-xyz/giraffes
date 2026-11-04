# Rationale: week-1 agent core

## Problem

Build a per-person agent on Cloudflare Workers and SQLite-backed Durable Objects. A person texts it on LINE, Telegram or a dev page. It replies, keeps reminders, sends one daily check-in, and never resets its memory. The platform makes the shape non-obvious in four ways:

- **A Durable Object is not serial across `await`.** While a turn awaits the model call, other requests reach the same object. "One event at a time" has to be built.
- **There is one alarm per object.** It must serve wake-ups, model retries, delivery retries and log shipping.
- **Every external effect can happen twice or not at all.** That covers webhooks, alarms, model calls, LINE and Telegram sends, and D1 writes. A crash can land between any two of them.
- **Two facts cross users.** The global $1,500 ceiling and the gate logs need one owner each, and a per-person object can't own them.

The LINE reply token is single-use and lives for about a minute. Pushes are billed, and only pushes take `X-Line-Retry-Key`. Telegram has no idempotency key. The week-2 job-result event, versioned jobs, approvals, groups and invites must fit in later without rework.

`USAGE.md` shows the call sites. The code is the authority. Where a doc disagrees with it, fix the doc.

## Shape

### One way in, one executor, a derived alarm

`Agent` (one DO per person, `app/src/agent/agent.ts`) has three public methods, `enqueue`, `alarm` and `snapshot`, plus the test-only `withDeps`.

- `enqueue` runs one transaction. It does `INSERT OR IGNORE` into `inbox`, and on first contact it also creates the `agent` row and the first daily check-in. It arms the alarm no later than now, then starts a drain with `ctx.waitUntil(this.alarm())`, so a reply never waits on alarm scheduling. The alarm is the durable backstop if that drain dies.
- `alarm` is the only code that calls a model, changes memory or sends a message. A drain runs isolated phases in order: turns, box, delivery, log flush, compaction, prune. The turns phase recovers what a dead instance left, fires due wake-ups, then loops over batches (claim, turn, deliver, fire due wake-ups) for at most 60 s. A phase that throws is logged and the next phase still runs, so a failing compaction can't hold back delivery or log shipping.
- Events are claimed strictly in `seq` order. When the oldest unfinished event is waiting out a model backoff, nothing behind it is claimed, whatever its kind, and messages that arrived meanwhile join its batch when it is retried. No kind passes a waiting head, because every kind can change what a later one means: a message can cancel what an earlier one asked for, a follow or block decides whether a later turn is delivered, and a wake-up's turn reads the conversation before it. The cost is that a model outage holds everything for that person for at most its retry window, about 90 s behind a message and about 7.5 minutes behind a requested reminder.
- Due wake-ups fire only while no message, follow or block is waiting in the inbox, so whatever the person sent before a wake-up fires is applied first: a cancel waiting out an outage still stops the reminder that falls due meanwhile. A burst of messages can hold a wake-up for as long as the burst lasts.
- The alarm time is computed, never stored. It is the earliest of the oldest unfinished inbox event's `ready_at`, the fire time of the earliest pending wake-up while no channel event holds wake-ups back, the outbox `ready_at`, the log retry time, the compaction retry time while a due compaction is backing off, and the box's next step while a box is configured, so no "next alarm" field can drift from the tables.
- A second `alarm()` while a drain runs joins the in-flight promise. The guard is in memory on purpose. A DO has one live instance, so the guard can't outlive the work it protects, and `recover()` treats whatever a dead instance left as crashed.

While a turn awaits the model, the only operations that can interleave are an inbox insert and a read.

### Data (DO SQLite, `app/src/agent/schema.ts`)

| Table | Holds | Key invariant |
|---|---|---|
| `inbox` | the durable queue, all event kinds | `event_key UNIQUE`; `pending → processing → done/failed`; `attempts` bounds retries |
| `turn` | verbatim recent conversation | a turn prompt reads the newest 30 |
| `memory` (1 row) + `memory_note` | compacted summary, model notes | compaction is compare-and-set on `through_turn_seq`; a turn prompt reads the newest 50 notes |
| `wakeup` | reminders and the check-in | partial `UNIQUE(key) WHERE status = 'pending'`; `origin` is `person`, `agent` or `system` |
| `outbox` | everything leaving | one row per turn with all its texts; `id` is a UUID and the LINE retry key; `intent` is set by code; `admitted_day` charges the budget once per local day; `in_doubt` bars the reply token |
| `spend_month` + `reservation` | per-person spend and global leases | reserved spend is `SUM(reservation)`, never stored |
| `log_outbox` + `log_flush` | log rows not yet in D1, and their backoff | written in the same transaction as the fact they record |
| `box` (0 or 1 row) | the person's box and its state | `next_at` is the next provisioning attempt or sign-in poll, and null in any other state |

Derived, not stored: unasked messages sent today (`COUNT` over `admitted_day`), lateness (`firedAt - dueAt`), reserved spend, whether the person was already told about the monthly limit today (inbox outcomes), and the alarm time.

D1 (`app/src/ledger/d1-schema.sql`) holds the cross-user facts: append-only `agent`, `turn_log`, `model_call`, `unasked_message`, `lifecycle` and `action_rejection`, plus `spend_lease` and the `boxes` inventory. The gates are SQL views.

### Types carry the invariants (`app/src/domain.ts`)

- Branded `EpochMs`, `MicroUsd` (integer), `TimeZone`, `LocalDateTime`, `EventKey`, `WakeupKey`, `OutboxId` and `AgentKey`. An `EventKey` comes only from the `eventKey.*` constructors, so every dedupe key has a stated source.
- `intentOf(event)` returns `reply`, `requested` or `unasked` from the event kind and the wake-up origin. The model has no intent field.
- The model reads and writes local wall time only. Zone math lives in `policy/time.ts`.
- `ChannelRegistry` is a mapped type over `CHANNEL_IDS`, so a channel id without an adapter fails the build.
- `LogRow` is one union, and each variant maps to one D1 table in one exhaustive switch.
- `AgentEvent` is stored as JSON with no SQL CHECK on kind. Week 2's `job_result` is one new variant, and the exhaustive switches name every place that must handle it.

### Where validation lives

Channel adapters authenticate and parse: the HMAC over the raw body for LINE, a constant-time header compare for Telegram, and identity extraction. Wire types never leave `channels/<name>.ts`. `loadConfig` validates env once. The zod schema checks the shape of model output in the backend, and `planTurn` checks its meaning (times, limits, keys) and its lengths, which the API doesn't enforce. Inside the agent, data is trusted and typed.

### Module map

```
app/src/worker.ts            /webhook/:channel → adapter.receive → Agent.enqueue; dev routes
app/src/config.ts            Env → Config, the only reader of env strings
app/src/domain.ts            branded units, ids, events, intent, outbound, task labels
app/src/agent/agent.ts       the DO: enqueue, drain phases, metered model call, delivery, re-arm
app/src/agent/store.ts       all DO SQL, synchronous methods (imported only by agent.ts)
app/src/agent/schema.ts      DO DDL and migrate()
app/src/agent/turn.ts        TurnOutputSchema, renderUser, planTurn, planWithoutModel, logsForTurn (pure)
app/src/agent/compaction.ts  planCompaction, compactionCommit (pure)
app/src/agent/prompt.ts      byte-stable system prompts and the opportunism playbook
app/src/policy/{time,schedule,outreach,spend}.ts   pure rules
app/src/model/{model,anthropic,bridge,scripted}.ts routes, prices, three backends
app/src/box/{names,host,fly,client,machine}.ts     box secrets, Fly and static hosts, box client, box state machine
app/src/channels/{channel,line,telegram,dev}.ts    port, registry, three adapters
app/src/ledger/{ledger.ts,d1-schema.sql}           D1 append, leases, gate views
app/dev/{bridge.ts,chat.html}                      local `claude -p` bridge, dev chat page
app/test/testkit.ts, app/test/{agent,channels,ledger,model,policy}.test.ts
```

Tracing a flow takes three files: `worker.ts`, `agent.ts`, and one pure module.

### The box path

`BOX.md` is the contract with the box. The Worker side keeps the same shape as the rest of the agent:

- **One row, one state machine.** `box/machine.ts` is pure. `newBox`, `onCommand`, `beginStep`, `afterProbe` and `onSignedOut` return the next row and what to tell the person. The agent writes both in one transaction (`applyBox`), so a link is never sent for a state that didn't commit.
- **Provisioning is a drain step.** `beginStep` commits the attempt and the next attempt's time (15 s, doubling to 5 minutes) before any network call. Then the host's `ensure` runs, and `/health` decides. Every Fly step reads current state first and treats "already exists" as done, so a crash anywhere resumes. After 10 attempts the box is `failed` and the person is told once.
- **The alarm wakes for it.** `next_at` joins the alarm minimum, but only while `BOX_HOST` isn't `none`, so turning the feature off can't leave an alarm that wakes for nothing.
- **Inventory before the row.** `/claude` claims a D1 `boxes` slot with one conditional insert, as leases do. A retry of the same person's claim is granted. If D1 can't be reached, the command backs off like an unavailable model.
- **The ticket stays out of prompts.** The sign-in link is in the outbox row only. The turn history keeps the text with `<sign-in link>` in its place.
- **Routing.** `#callModel` tries `#callBox` first for turns. Compaction always uses the API. `planAllowsBox` is the plan check, and it allows everyone until billing lands.
- **The static host has one fixed name,** `BOX_APP_PREFIX` + `static`, because its box holds one `BOX_TOKEN` and the token derives from the name. Every person on a static host shares that box.

## Policy decided by code

**Who asked decides budget and quiet hours.** A wake-up is `person` only when the turn was started by the person's own message and the model sets `asked: true`. Every wake-up scheduled during a proactive turn is `agent`. The daily check-in (09:00 local) is `system`.

- A `person` wake-up fires at its due time, even between 22:00 and 08:00. Its message is `requested`, so it skips the unasked budget and quiet hours.
- An `agent` or `system` wake-up due in quiet hours fires at 08:00. Its message is `unasked`. Every delivery attempt checks quiet hours and defers to 08:00. The first attempt admitted on a local day charges that day's budget of 3 and records `admitted_day`, and later attempts that day are not charged again. A row that a retry carries past midnight is admitted again against the new day's budget, so the cap holds for every day a message goes out on. Past the budget, the row is dropped and logged as `dropped_budget`.
- A reply to a message or a follow is `reply` and is never limited.

**Requested reminders have a floor.** When a `person` wake-up's turn would send nothing, code sends `Reminder: <note>` from the stored row, led by the fixed late notice when it is more than an hour late. That covers a valid answer with no send, invalid output, a refusal, a poisoned batch, a budget refusal, and five unavailable attempts (about 7.5 minutes). A chat message gets three model attempts (about 90 s) before the fixed "say it again" reply. Agent wake-ups and check-ins send nothing on failure.

**Code corrects what it rejects.** `planTurn` applies every cancel before any schedule, so a move or a swap gives the same result in any action order, and replacing one of 20 reminders frees its slot first. It rejects a reminder that is before the current minute, more than 366 days ahead, a key already pending, an unreadable time, or the check-in key. It also rejects a cancel with nothing pending. When the replacement for a key cancelled in the same turn is rejected, the cancel doesn't commit, the original reminder stays, and the correction says so. The 20-reminder cap is checked last, on the turn's final pending set, after every cancel, move and restore: a move keeps its own slot, and when the set would hold more than 20, the new keys scheduled last are rejected as `limit`. `commitTurn` checks the count again inside its transaction and refuses a commit that would leave more than 20 pending. In any turn that sends model text, whatever its intent, a code-written correction goes out in the same delivery, so a model confirmation can't go out alone. A rejected wake-up the agent set for itself (`asked: false`) gets no correction, because the person never heard of it. A reply to a person who wrote in carries the correction even when the model sent no text; a wake-up or check-in that sends nothing shows none. A correction displaces the third send when the turn already has three. Every rejection, in any turn, is logged to `action_rejection`.

A reminder the person asked for may be for the current minute, and it fires on the next alarm. The agent's own wake-ups need a minute's lead, or a wake-up turn could re-arm itself and fire again in the same drain.

**Lateness.** A wake-up that fires more than an hour after its due time tells the model so. Code prepends the model's `lateNotice`, or a fixed one when the model left it out.

**Send caps.** A turn sends at most 3 texts of 600 characters each, in at most 6 actions. Notes are capped at 300 characters and the late notice at 200. The API doesn't enforce these, because the SDK's `zodOutputFormat` moves length and count limits into the schema's descriptions. So the schema only states them, and `planTurn` cuts a longer text to its cap and drops actions past the sixth, logging each as `too_long` or `too_many_actions`. One long text no longer fails the turn. The output budgets (`maxTokens` 12,000 for turns and 12,500 for compaction) fit the largest output code keeps whole, even in Thai, and `policy.test.ts` pins that.

**Reachability.** Follow and block events carry the platform's timestamp. One older than the last recorded change is logged as `stale` and changes nothing. A block skips the model. A message from a blocked person, written at or after that block, sets them active and re-creates a missing check-in, so the reply is delivered. A send that fails because the person is gone (Telegram 403) marks them blocked but leaves the timestamp alone, because our clock isn't comparable with the platform's. While a person is blocked, their wake-ups are skipped (the check-in gets no successor) and their outbox rows are dropped.

**Time zone.** Week 1 runs every person on Asia/Bangkok time. The `agent.tz` column exists and the zone math takes a zone, but nothing sets a per-person zone yet. A Telegram user elsewhere gets reminder times and quiet hours in Bangkok time.

## Spend

`estimate()` is an upper bound on the bill. It counts the prompt's UTF-8 bytes (no token is shorter than a byte), adds 4,000 tokens for the injected schema and framing, prices all of it at the cache-write rate, and adds the route's full `maxTokens` of output. The prompt size picks the rate card, so a Haiku prompt over 100K tokens is priced on the long-context card.

The reservation is local. `spent + reserved + estimate` must fit the person's $15 monthly cap. When it exceeds the person's lease, the agent asks D1 for a $0.50 chunk of the global ceiling with one conditional `INSERT … SELECT … WHERE SUM + chunk <= ceiling`. That is about one D1 round trip per $0.50 of a person's spend, and none per call. A lease request that can't reach D1 retries the turn later. It never runs the call unreserved.

Settlement follows what is known about the bill:

| Outcome | Charged | `model_call.status` |
|---|---|---|
| a response, valid or not | its usage | `settled` |
| 429 or 529, or the dev bridge is down | $0 | `unavailable` |
| another 4xx, rejected before it ran | $0 | `rejected` |
| no response, a 408, or another 5xx | the estimate | `in_doubt` |
| the call threw anything else in process | the estimate | `in_doubt` |
| the instance died mid-call | the estimate, charged by `recover()` | `recovered_after_crash` |

The Anthropic client runs with `maxRetries: 0`, so every billed attempt passes through its own reservation.

## Failure cases

- **Crash mid-turn.** The claim committed `processing` and `attempts + 1`, and the reservation is durable. `commitTurn` is one transaction: turns, wake-ups, notes, outbox, inbox done, settlement and logs land together or not at all. `recover()` puts the batch back to `pending` and settles orphaned reservations at their estimate. After 3 claims the batch is poisoned. A message gets a fixed apology, a requested reminder gets its floor, and anything else gets nothing.
- **Model unavailable or the request rejected.** The batch goes back to `pending` with a 30 s doubling backoff, and attempts are kept. Later events wait behind it. A long outage ends as `model_failed` after 3 attempts, or 5 for a requested reminder. Invalid output or a refusal ends the turn the same way at once.
- **Crash after commit, before or during a send.** `recover()` turns `sending` back to `pending` with `in_doubt = 1`. A LINE reply that answered 5xx or lost its connection is marked in doubt the same way. So is a push that must be retried after LINE refused the reply token, so the retry doesn't present that token again. An in-doubt row is read without its reply token, so LINE pushes it with `X-Line-Retry-Key = outbox.id`, and a 409 counts as sent. If the lost attempt was a reply that landed, the person sees a duplicate. Telegram sends one `sendMessage` per row, texts joined by blank lines, so a retry repeats the whole row once and never part of it. A crash after a Telegram send that landed also duplicates. Budget admission was recorded before the send, so it is never charged twice.
- **Delivery failure.** A 429 or 5xx retries after 30 s, or after Telegram's `retry_after`. LINE's monthly-quota 429 fails at once. A row is dropped after 5 attempts.
- **Duplicate webhook.** `inbox.event_key` is `line:<webhookEventId>`, `tg:<update_id>` or `dev:<client id>`, inserted with `INSERT OR IGNORE`. Done rows are kept 14 days for this.
- **Box unavailable or signed out.** A turn on a `signed_in` box that times out (120 s), gets a 5xx or loses the network runs on the API path, with the usual caps, and is logged as a `box` call with status `unavailable`. A `409 signed_out` sets the box to `signed_out`, sends one fresh link, logs `rejected`, and runs the turn on the API. Later turns stay on the API until polling sees the sign-in. A crash mid-call re-runs the turn, which costs nothing on the box.
- **Webhook enqueue fails.** The Worker answers 200 only after every envelope is in its inbox. Otherwise the request fails with 500, and the channel's redelivery is the retry. LINE redelivery is off by default and must be turned on.
- **Alarm fires twice.** A concurrent call joins the in-flight drain. A sequential call finds nothing due, because a wake-up is closed in the transaction that inserts `wake:<id>`, and check-ins are keyed `checkin:<local date>`.
- **Message during a model call.** `enqueue` inserts it. The in-flight turn commits as planned, and the next batch's prompt contains the previous reply. Consecutive messages already pending when a batch is claimed (up to 10) become one turn. There is no debounce.
- **Compaction fails.** Compaction runs when there are more than 60 turns or 40 notes. Each call folds one page: up to the oldest 30 turns, always keeping the newest 30, and up to 40 notes, folding toward 20. Any outcome other than success backs off 5 minutes, doubling to a day. The backoff is stored on the `memory` row, is part of the alarm time, and is reset on success. A backlog shrinks one page per drain.
- **D1 down.** Logs wait in `log_outbox` and ship later with deterministic ids, backing off from 10 s, doubling to an hour. Only a duplicate id is skipped. A row D1 refuses, such as one an old CHECK doesn't allow, fails the flush the same way until the ledger is migrated.

### What it does not do

No turn runs inside the webhook request. There are no lock rows, no stored alarm time, no model-chosen ids or time zones, no mutable counters for anything countable, no D1 write inside a turn, no Cloudflare Queues and no Agents SDK.

## Tradeoffs accepted

- **No debounce.** A reply starts at once. In exchange, a burst of texts that arrives during a model call becomes more than one turn.
- **Charging the estimate when the bill is unknown.** Spend is never under-counted after a crash or a lost response, at the cost of over-charging some calls.
- **Unused leases.** Up to $0.50 per active person of unused global lease at month end ($50 at 100 people), in exchange for no cross-user hop per call and no global hot row.
- **Duplicate sends.** A crash in the send window can duplicate a Telegram message or an in-doubt LINE reply, in exchange for never losing a reminder.
- **Lossy compaction lag.** While compaction lags, turns between the summary and the 30-turn window are missing from the prompt. In exchange, the prompt is bounded and a reply never waits on compaction.
- **English notices.** Code-written text is English: corrections, the monthly limit, the late-notice fallback and the requested-reminder floor. The model writes its own late notice in the person's language.
- **One coarse DO class.** One `Agent` holds everything for a person, which gives one transaction per turn. The store and the pure planners keep each file single-purpose.

## Alternatives considered

- **Process inline in the webhook request.** Two webhooks for one person would run two turns at once, and a crash loses the event. Rejected because it pushes the serial, crash-safe invariant onto every entry point.
- **A 1.5 s debounce on every message.** It folds a burst into one turn but delays every reply. Replaced by starting the drain from `enqueue` and batching what is already pending.
- **Cloudflare Queues.** A second durable queue with no per-person ordering, when the DO's SQLite already is one. Rejected.
- **A lock or lease row** instead of the in-memory guard. It needs expiry tuning and a stale-lease path for a case that a DO's single instance already rules out. Rejected.
- **The global ceiling in a singleton DO**, reserved and settled per call. Every call would hop to one hot object, and a crash between reserve and settle leaks reservations. Leases keep state per actor and merge at the one point that needs it.
- **Analytics Engine for logs.** It samples, expires data and has no joins. The gates need exact weekly counts and joins. Rejected.
- **The Cloudflare Agents SDK.** It owns the alarm and its own schedule table, and our alarm is the minimum over four tables with quiet-hours-aware fire times. Rejected.
- **The model rewrites its whole memory each turn.** It costs output tokens every turn and lets one bad turn erase facts. Rejected for append-only notes plus compare-and-set compaction.
- **Counting requested reminders against the unasked budget.** A heavy reminder user would lose the fourth reminder they asked for. Rejected.
- **Typed week-2 job and approval stubs.** The `AgentEvent` union already leaves the slot, and stubs written before the booking probe would be guesses. Not taken.

## Open questions and risks

- Is charging the estimate on a crash or a lost response acceptable for the cost gate? Those calls are labeled in `model_call.status`.
- Does structured output on Haiku 5.5 accept the `anyOf` that `zodOutputFormat` makes from the action union? If not, flatten it to one object with a `type` enum, validated in `planTurn`.
- Does the system prompt clear Haiku 5.5's minimum cacheable prefix? If not, caching silently does nothing.
- The only guard on the requested bypass of budget and quiet hours is the model's `asked` flag on a message turn, bounded by the 20 pending reminders.
- A drain stops starting batches after 60 s and re-arms for now, which keeps one person well inside the 15-minute alarm limit.
- LINE quota exhaustion fails every push, and nothing alerts the operator.

Known ordering races, all open:

- Concurrent LINE envelopes for one person can swap. The Worker enqueues one webhook's events in parallel, and `inbox.seq` follows arrival order.
- Telegram lifecycle events in the same second can misorder. Their timestamps are whole seconds, so two of them tie and apply in inbox order.
- A reply recorded in history may never have been delivered. The agent's text is committed to `turn` before delivery, and a dropped or failed row stays in the prompt as said.
