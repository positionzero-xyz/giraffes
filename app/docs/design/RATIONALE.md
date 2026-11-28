# Rationale: week-1 agent core

## Problem

Build a per-person agent on Cloudflare Workers and SQLite-backed Durable Objects. A person texts it on LINE, Telegram or a dev page. It replies, keeps reminders, sends one daily check-in, and never resets its memory. The platform makes the shape non-obvious in four ways:

- **A Durable Object is not serial across `await`.** While a turn awaits the model call, other requests reach the same object. "One event at a time" has to be built.
- **There is one alarm per object.** It must serve wake-ups, model retries, delivery retries and log shipping.
- **Every external effect can happen twice or not at all.** That covers webhooks, alarms, model calls, LINE and Telegram sends, and D1 writes. A crash can land between any two of them.
- **The gate logs cross users,** and a per-person object can't own them.
- **Every model call is paid for by the person it serves.** We hold no model key. A call runs on that person's own Claude plan in their box, or on their own API key, and the providers behind a key differ exactly where our invariants live: structured output, what an error means, and long-context price tiers.

The LINE reply token is single-use and lives for about a minute. Pushes are billed, and only pushes take `X-Line-Retry-Key`. Telegram has no idempotency key. The week-2 job-result event, versioned jobs, approvals, groups and invites must fit in later without rework.

`USAGE.md` shows the call sites. The code is the authority. Where a doc disagrees with it, fix the doc.

## Shape

### One way in, one executor, a derived alarm

`Agent` (one DO per person, `app/src/agent/agent.ts`) has three public methods, `enqueue`, `alarm` and `snapshot`, plus the test-only `withDeps`.

- `enqueue` runs one transaction. It does `INSERT OR IGNORE` into `inbox`, and on first contact it also creates the `agent` row. A dev identity, or anyone while `ADMISSION=open`, is admitted then and gets the first daily check-in. Anyone else gets it when they are admitted. It arms the alarm no later than now, then starts a drain with `ctx.waitUntil(this.alarm())`, so a reply never waits on alarm scheduling. The alarm is the durable backstop if that drain dies.
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
| `turn` | verbatim conversation not yet in the summary | a turn prompt reads all of it, up to 90 rows |
| `memory` (1 row) + `memory_note` | compacted summary, model notes | compaction is compare-and-set on `through_turn_seq`; a turn prompt reads the newest 50 notes |
| `wakeup` | reminders and the check-in | partial `UNIQUE(key) WHERE status = 'pending'`; `origin` is `person`, `agent` or `system`; `task_id` is the task an agent wake-up follows up |
| `outbox` | everything leaving | one row per turn with all its texts; `id` is a UUID and the LINE retry key; `intent` is set by code; `admitted_day` charges the budget once per local day; `in_doubt` bars the reply token; `task_id` and `purpose` say what an unasked message is about and why; `choice` is its button; `reply_only` bars a push |
| `task` | what the person wants done that takes more than one message | a code id; the model's `ref` is unique among open tasks; `status` changes only when a fact is recorded, and `completed`, `closed` and `expired` are final |
| `task_fact` | everything code knows happened to a task | `UNIQUE(task_id, kind, ref)`, so the same evidence twice is one fact; `completes = 1` on the one fact that moved the task to completed |
| `proposal` | a plan offered for a task, and the outbox row that carried it | at most one open per task; a newer version supersedes it; an accept must name the open one |
| `admission` (0 or 1 row) | where the person stands with the beta | no row is a stranger; no lane serves anyone it doesn't admit |
| `spend_month` + `reservation` | metered spend per scope (`byok`, the person's own key; `included`, our quota) and month | reserved spend is `SUM(reservation)`, never stored; a reservation names the DO instance that made it |
| `model_key` (0 or 1 row) | the person's own key, sealed, with its provider, base URL, model, schema mode, cap, backup answer and fault state | a fault rests the key until `rest_until`; `told_on` is the local date of the last notice; `unreadable_under` names the secrets that failed to open it |
| `key_revision` (1 row) + `key_ticket` | the access revision, and one-time links to the key page | every save and removal bumps the revision; a ticket stores only its nonce's hash and moves `issued → validating → saved/failed` |
| `owned_group` | group ownership versions | unused; the schema stays unchanged for existing objects |
| `log_outbox` + `log_flush` | log rows not yet in D1, and their backoff | written in the same transaction as the fact they record |
| `box` (0 or 1 row) | the person's box and its state | `next_at` is the next provisioning attempt or sign-in poll, and null in any other state |

Derived, not stored: how a person's model calls are served (`accessOf` over the box row, the key row and the plan), unasked messages sent today (`COUNT` over `admitted_day`), lateness (`firedAt - dueAt`), reserved spend, whether the person was already told about the monthly limit or the no-access offer today (inbox outcomes), and the alarm time.

D1 (`app/src/ledger/migrations`) holds the cross-user facts: append-only `agent`, `turn_log`, `model_call`, `unasked_message`, `lifecycle`, `action_rejection`, `task`, `task_fact`, `admission_log` and `line_quota`, plus `line_quota_alert`, the `boxes` inventory, and the beta's `invite_code` and `enrollment`. The operator writes `beta`, `safety_incident` and `survey_response`. The gates are SQL views.

### Types carry the invariants (`app/src/domain.ts`)

- Branded `EpochMs`, `MicroUsd` (integer), `TimeZone`, `LocalDateTime`, `EventKey`, `WakeupKey`, `OutboxId` and `AgentKey`. An `EventKey` comes only from the `eventKey.*` constructors, so every dedupe key has a stated source.
- `intentOf(event)` returns `reply`, `requested` or `unasked` from the event kind and the wake-up origin. The model has no intent field.
- The model reads and writes local wall time only. Zone math lives in `policy/time.ts`.
- `Language` is `th` or `en`, and `CHANNEL_LANGUAGE` maps every channel to the language a new person starts in. `notices.ts` holds every code-written text in one table typed by `Notices`, one entry per language, so a text missing in either language fails the build.
- `ChannelRegistry` is a mapped type over `CHANNEL_IDS`, so a channel id without an adapter fails the build.
- `LogRow` is one union, and each variant maps to one D1 table in one exhaustive switch.
- `AgentEvent` is stored as JSON with no SQL CHECK on kind. Week 2's `job_result` is one new variant, and the exhaustive switches name every place that must handle it. A tap on a button is a `choice` event.
- `FACTS` in `domain.ts` is the one list of what can happen to a task, and of which facts complete one or count as the person's own decision. A new kind of evidence is a new entry; no table or view keeps a copy.
- `mayspend(admission)` is the one test every spend path uses.
- `PROVIDERS` (`model/providers.ts`) is the one list of providers, their wire protocol, auth, key shape, priced models and schema support. The key page, its form check, the route table, the adapters and the price lookup all read it. A `ModelRef` is provider-qualified, such as `opencode-go:claude-haiku-5-5`.
- `SecretKey` prints and serializes as `[key]`; only the wire's header builder and the sealer call `reveal()`.

### Where validation lives

Channel adapters authenticate and parse: the HMAC over the raw body for LINE, a constant-time header compare for Telegram, and identity extraction. Wire types never leave `channels/<name>.ts`. `loadConfig` validates env once. The zod schema checks the shape of model output in the backend, and `planTurn` checks its meaning (times, limits, keys, time zones) and its lengths, which the API doesn't enforce. A provider's reply is read once, in `runParse`: HTTP status to meaning in `classify`, then JSON, then the zod schema. Inside the agent, data is trusted and typed.

### Module map

```
app/src/worker.ts            /webhook/:channel → adapter.receive → Agent.enqueue; dev routes
app/src/config.ts            Env → Config, the only reader of env strings
app/src/domain.ts            branded units, ids, events, intent, outbound, task facts, choices, invite codes, admission, languages
app/src/notices.ts           every code-written text, in Thai and English
app/src/agent/agent.ts       the DO: enqueue, drain phases, delivery, re-arm, the box lane, the key page's connect
app/src/agent/store.ts       all DO SQL, synchronous methods (imported only by agent.ts)
app/src/agent/schema.ts      DO DDL and migrate()
app/src/agent/turn.ts        TurnOutputSchema, renderUser, planTurn, planWithoutModel, logsForTurn (pure)
app/src/agent/tasks.ts       taskEffects, planTasks, linkOf, purposeOf, nextStatus, isPlainAccept (pure)
app/src/agent/admission.ts   planAdmission (pure)
app/src/agent/compaction.ts  planCompaction, compactionCommit (pure)
app/src/agent/prompt.ts      byte-stable system prompts and the opportunism playbook
app/src/agent/purposes.ts    what each purpose's model call returns
app/src/access/access.ts     accessOf (pure) and ModelAccess: lanes, prompt fitting, metering, key faults, the probe
app/src/access/key.ts        seal/open, tickets, draftKey and redactSecrets (pure)
app/src/access/page.html     the key page
app/src/policy/{time,schedule,outreach,spend,quota}.ts   pure rules
app/src/model/{providers,routes,prompt,client,scripted}.ts  the provider registry, routes and prompt budgets, the wire, the test client
app/src/box/{names,host,fly,client,machine}.ts     box secrets, Fly and static hosts, box client, box state machine
app/src/channels/{channel,line,telegram,dev}.ts    port, registry, three adapters
app/src/ledger/{ledger.ts,migrations/}           D1 append, seats and box inventory, gate views
app/dev/{bridge.ts,chat.html}                      local `claude -p` bridge, dev chat page
app/scripts/beta-codes.ts                         the operator's invite codes and beta start, as SQL
app/scripts/eval.ts, app/eval/fixtures/           replays fixtures through any route on the Worker's own code
app/test/testkit.ts, app/test/{agent,access,key,wire,evidence,beta,tasks,admission,views,channels,ledger,policy}.test.ts
```

Tracing a flow takes three files: `worker.ts`, `agent.ts`, and one pure module.

### The box path

`BOX.md` is the contract with the box. The Worker side keeps the same shape as the rest of the agent:

- **One row, one state machine.** `box/machine.ts` is pure. `newBox`, `onCommand`, `beginStep`, `afterProbe` and `onSignedOut` return the next row and what to tell the person. The agent writes both in one transaction (`applyBox`), so a link is never sent for a state that didn't commit.
- **Provisioning is a drain step.** `beginStep` commits the attempt and the next attempt's time (15 s, doubling to 5 minutes) before any network call. Then the host's `ensure` runs, and `/health` decides. Every Fly step reads current state first and treats "already exists" as done, so a crash anywhere resumes. After 10 attempts the box is `failed` and the person is told once.
- **The alarm wakes for it.** `next_at` joins the alarm minimum, but only while `BOX_HOST` isn't `none`, so turning the feature off can't leave an alarm that wakes for nothing.
- **Inventory before the row.** `/claude` claims a D1 `boxes` slot with one conditional insert. A retry of the same person's claim is granted. If D1 can't be reached, the command backs off like an unavailable model.
- **The ticket stays out of prompts.** The sign-in link is in the outbox row only. The turn history keeps the text with `<sign-in link>` in its place.
- **Routing.** The box is the first lane `ModelAccess` tries, for turns and compaction alike. `planAllowsBox` is the plan check, and it allows everyone until billing lands. A box that can't answer falls back to nothing that costs money, unless the person said their key may back it up.
- **The static host has one fixed name,** `BOX_APP_PREFIX` + `static`, because its box holds one `BOX_TOKEN` and the token derives from the name. Every person on a static host shares that box. The Worker derives a different opaque `sessionOwner` from each agent key, so the box's rollback session files stay per person even there.

## Policy decided by code

**A task completes only on evidence code holds.** The model doesn't label a turn's task or say when it is done. It returns `tasks`, a list of plain ops (`open`, `propose` or `close`, a ref it reuses across turns, a kind, a title and a plan that is `""` unless it proposes), and `about`, the ref of the task its messages are about. A turn on the person's box makes each op a call to the `task` tool, whose input is the op itself, and its messages are about the task its last task call names; opening a task that is already open changes nothing else. `planTasks` checks them: at most 3 ops, at most 20 open tasks, one proposal per turn, a plan of at least 2 lines and 80 characters, and no ops on a task that finished this turn. A rejection is logged and the person isn't told. A proposed plan goes out as its own text, last, under an Accept button, and counts as one of the 3 sends. The store creates the proposal (`<task id>.<version>`) in the same transaction as the outbox row that carries it, and supersedes the task's open one. `taskEffects` is the only place that records acceptance: a tap on the open proposal, or a message that is only a plain yes (`ok`, `โอเคค่ะ` and a closed list like them) when the newest message the person received carried an open proposal sent within 48 hours. The yes may open a batch, as in "ok" then "thanks", as long as nothing after it rejects or amends ("but", "no", "not", "change", "instead", "แต่", "ไม่", "เปลี่ยน"). The times compare at whole-second precision, since Telegram stamps a message in whole seconds. Each fact keeps `via`, `tap` or `typed`. It runs whether or not the model answers, so an accept still commits and is confirmed when the turn fails. The store applies `nextStatus` in the transaction that records the fact, so a task completes once, and a fact on a task already closed or expired changes nothing. An open task untouched for 30 days expires. Week 1 has one kind of evidence, `plan_accepted`; a worker that books, publishes or reports a group's outcome later adds its own entry to `FACTS`.

**Code decides why an unasked message went out.** `linkOf` picks the message's task by fixed precedence: the task proposed this turn, the firing wake-up's task if it is still open, then `about` if it names a task that is open or that finished this turn. `purposeOf` sets `task_followup` for a link to a task still open after the turn, `bookkeeping` for a check code scheduled or a task that just finished, and `unlinked` otherwise. The model never labels purpose. A message's task is a code id fixed before it went out, so a later turn can't claim credit for it.

**Admission.** While `ADMISSION=beta` (the default), a person on LINE or Telegram is a stranger until they present an invite code and consent. A code arrives as Telegram's `/start CODE`, as `/join CODE`, or as a message that is only a code. Presenting it only reads D1 (`checkInvite`), so nobody holds a seat they never consented to. A good code gets the privacy notice and a consent button. The tap claims the seat with one conditional insert into `enrollment`, capped per cohort, and the DO row becomes `admitted` only after D1 granted it. Seats are never freed. A bad, used or full code waitlists the person, and anyone not admitted is told to send a code at most once per local day. Until admission every reply is code-written, keeps nothing the person wrote, goes out only on the reply token, and starts no check-in. The same `admission` row also gates the model call (`accessOf` gives no lane to anyone not admitted), the box, compaction and wake-ups. `/invite` gives an enrolled person up to 5 joiner codes, and a joiner inherits their inviter's half. `POST /dev/remove` takes someone out: their wake-ups are skipped, every message gets a fixed reply, and their seat stays used. Everything that acts for them on its own stops, all gated on the same `mayspend` read of the `admission` row: their key-page tickets are deleted and a submission is refused as expired, their box is neither provisioned nor advanced, and every pending push is dropped with reason `removed` (an unasked one logs `dropped_removed`), as is any push queued later. Only the fixed reply, a reply-only row, still goes out. `ADMISSION=open` admits everyone at first contact and gives `/invite` and `/join` back to billing, and `loadConfig` refuses `ADMISSION=beta` with `BILLING=on`, so each mode has exactly one way to redeem a code.

**Who asked decides budget and quiet hours.** A wake-up is `person` only when the turn was started by the person's own message and the model sets `asked: true`. Every wake-up scheduled during a proactive turn is `agent`. The daily check-in (09:00 local) is `system`.

- A `person` wake-up fires at its due time, even between 22:00 and 08:00. Its message is `requested`, so it skips the unasked budget and quiet hours.
- An `agent` or `system` wake-up due in quiet hours fires at 08:00. Its message is `unasked`. Every delivery attempt checks quiet hours and defers to 08:00. The first attempt admitted on a local day charges that day's budget of 3 and records `admitted_day`, and later attempts that day are not charged again. A row that a retry carries past midnight is admitted again against the new day's budget, so the cap holds for every day a message goes out on. Past the budget, the row is dropped and logged as `dropped_budget`.
- A reply to a message or a follow is `reply` and is never limited.

**Requested reminders have a floor.** When a `person` wake-up's turn would send nothing, code sends `Reminder: <note>` from the stored row, led by the fixed late notice when it is more than an hour late. That covers a valid answer with no send, invalid output, a refusal, a poisoned batch, a budget refusal, and five unavailable attempts (about 7.5 minutes). A chat message gets three model attempts (about 90 s) before the fixed "say it again" reply. Agent wake-ups and check-ins send nothing on failure.

**Code corrects what it rejects.** `planTurn` applies every cancel before any schedule, so a move or a swap gives the same result in any action order, and replacing one of 20 reminders frees its slot first. It rejects a reminder that is before the current minute, more than 366 days ahead, a key already pending, an unreadable time, or the check-in key. It also rejects a cancel with nothing pending. When the replacement for a key cancelled in the same turn is rejected, the cancel doesn't commit, the original reminder stays, and the correction says so. The 20-reminder cap is checked last, on the turn's final pending set, after every cancel, move and restore: a move keeps its own slot, and when the set would hold more than 20, the new keys scheduled last are rejected as `limit`. `commitTurn` checks the count again inside its transaction and refuses a commit that would leave more than 20 pending. In any turn that sends model text, whatever its intent, a code-written correction goes out in the same delivery, so a model confirmation can't go out alone. A rejected wake-up the agent set for itself (`asked: false`) gets no correction, because the person never heard of it. A reply to a person who wrote in carries the correction even when the model sent no text; a wake-up or check-in that sends nothing shows none. A correction displaces the third send when the turn already has three. Every rejection, in any turn, is logged to `action_rejection`.

A reminder the person asked for may be for the current minute, and it fires on the next alarm. The agent's own wake-ups need a minute's lead, or a wake-up turn could re-arm itself and fire again in the same drain.

**Lateness.** A wake-up that fires more than an hour after its due time tells the model so. Code prepends the model's `lateNotice`, or a fixed one when the model left it out.

**Send caps.** A turn sends at most 3 texts of 600 characters each, in at most 6 actions, and a late notice of at most 200. Those caps are for the person, so they count characters. Every cap that guards a prompt budget counts UTF-8 bytes instead, since Thai is 3 bytes a character: a note is at most 300 bytes, a task title 80, the summary 4,000, and the earlier messages of a batch 2,000 each and 4,000 together. Providers don't enforce these, because `jsonSchemaOf` moves length and count limits into the schema's descriptions, where every strict mode accepts them. So the schema only states them, and `planTurn` cuts a longer text or note to its cap and drops actions past the sixth, logging each as `too_long` or `too_many_actions`. One long text no longer fails the turn. The output budgets (`maxTokens` 18,000 for turns and 12,500 for compaction) fit the largest output code keeps whole, a whole plan included, even in Thai, and `policy.test.ts` pins that.

**LINE quota.** Pushes count against the LINE account's monthly message quota and replies don't. A cron runs the Worker's `scheduled` handler every hour. With LINE configured, it reads LINE's `GET /v2/bot/message/quota` (`type` is `none` or `limited`, with `value` when limited) and `GET /v2/bot/message/quota/consumption` (`totalUsage`), and appends the reading to D1's `line_quota`, keyed by the cron's scheduled time so a retried run adds nothing. At 70% and at 90% of the limit it alerts the operator once per UTC month per threshold, through `OPERATOR_CHAT` (`telegram:<chat id>` or `line:<user id>`) or, with none set, the log. The alert is recorded in `line_quota_alert` only after it went out, so a failed send is retried the next hour. From 90%, the reserve, an unasked message to a LINE person is dropped after quiet hours and before the budget, and logged as `dropped_quota`, which keeps the last tenth of the quota for replies that fall back to a push and for reminders people asked for. Delivery reads the latest reading from D1 only for an unasked LINE row. A reading from an earlier month, or none, holds nothing back, and so does a D1 failure, because the reserve is a margin rather than a limit. LINE doesn't say which time zone its month follows, so for a few hours around the 1st the alert month and LINE's month can differ.

**Reachability.** Follow and block events carry the platform's timestamp. One older than the last recorded change is logged as `stale` and changes nothing. A block skips the model. A message from a blocked person, written at or after that block, sets them active and re-creates a missing check-in, so the reply is delivered. A send that fails because the person is gone (Telegram 403) marks them blocked but leaves the timestamp alone, because our clock isn't comparable with the platform's. While a person is blocked, their wake-ups are skipped (the check-in gets no successor) and their outbox rows are dropped.

**Time zone and language.** A person starts on Asia/Bangkok time, with notices in Thai on LINE and in English on Telegram and the dev page. When they say where they live or which language they want, the model returns `set_locale` with an IANA zone and `th` or `en`. It is one plain action with two required fields, so the schema gains no `anyOf` or optional branch that a cheaper model might not support. `planTurn` checks the zone with `parseTimeZone` and rejects one it can't read as `bad_zone`, with a correction, while the language still applies. A new zone applies to the whole turn: the turn's own times are read in it, and every pending reminder keeps its local wall time there, because a time a person gave was meant on their clock and was read in Bangkok time until now. A reminder that moves into the past fires on the next alarm and says it is late. The check-in moves to the next 09:00 in the new zone, which a check-in already fired that local date can't repeat, because its inbox key is the date. Quiet hours, the unasked budget's local day and the prompt's clock all read `agent.tz`. A new language applies to the notices of the same turn.

## Model access

**Access is derived.** `accessOf` lists a person's lanes from facts that already have owners: the `box` row (the box machine owns it), the `model_key` row, and the plan. The box comes first when it is `signed_in` and the plan allows it, at no metered cost. The person's own key comes next, but while they have their Claude plan's box in any state (provisioning, signed in, signed out or reclaiming), or ever had one, the key is used only if they said yes to it as a backup, so a box that can't answer never spends their key's money silently. `agent.claude_plan_at` remembers that a box existed; a reclaim doesn't clear it, and asks the backup question again instead, so the key is never promoted silently. Only `/claude remove` clears it. Our included tier serves only someone with no box and no key, on the included plan, while `INCLUDED=on`. In dev, the bridge or a posted script is that lane for everyone, behind `DEV_MODE`. Nobody not admitted gets a lane, and a lapsed person gets none.

**One call, five outcomes.** `ModelAccess.call` tries the lanes in order. Per lane it fits the prompt to the route, reserves, sends one strict attempt (or, in loose mode, one attempt and one repair), and settles each attempt the moment it returns. It returns `ok`, `failed` (invalid output or a refusal), `unavailable` (some lane is down; the batch backs off as before), `over_cap`, or `no_access`. With no access, the turn never reaches a model: a message gets a code-written offer once a local day, naming only what this deploy offers (`/claude` when boxes are on, `/key` when keys are on, `/plan` when the included plan is sold), or, when the plan's box isn't signed in, a line saying so. A requested reminder still gets `Reminder: <note>`.

**Provider faults are one table.** `classify` maps an HTTP answer to its meaning for every protocol: 401 and 403 are a refused key, 402 or a billing error body is no credit, 404 is a missing model, a 429 with no Retry-After or one over a minute is a usage window, a short 429 or a 529 is turned away, another 4xx is rejected, and 408, 5xx or a lost connection is in doubt. A fault rests the key (an hour doubling to a day for a refused key or no credit, a day for a missing model, Retry-After or 15 minutes doubling to 6 hours for a usage window, and, when our own secret can't open it, until the configured secrets change, so restoring the right `KEY_SECRET` repairs every such key) and tells the person in their language at most once a local day (`told_on` is the date of the last notice). While it rests, every message the person sends is answered with the code-written line naming the problem, so nobody is met with silence. The failure counter stops at 20, so it never grows without bound.

**Keys never pass through chat.** `/key` sends `PUBLIC_URL/key#t=<ticket>&l=<language>`. The ticket is `<DO id>.<expiry>.<nonce>.<mac>`: the Worker checks the MAC and the 15-minute expiry before it wakes any DO, the DO id names no chat, and the fragment keeps it out of server logs. The DO stores only the nonce's hash and the access revision at issue. Opening the page uses nothing. A submission with a form mistake doesn't use the ticket. A good form moves it to `validating` before any provider call, so a repeat submission gets the stored outcome rather than a second probe. The probe is one tiny strict call (and a loose one when a provider leaves that to it), reserved and charged to the person's own spend like any call, and it decides the key's schema mode. The save is compare-and-set on the access revision, so a slow probe can't overwrite a newer key or a removal. Every other write to the key (a reseal, a rest after a fault, clearing that fault, the backup answer, the cap, a removal) names the key revision it was made for and does nothing once the key moved on, so a call that started on one key can't rest or reseal the key that replaced it; its turn backs off and retries on the new key. The backup question's button carries the revision it asked about, and a tap after the key changed, or on a button from before buttons carried one, changes nothing and says so. The key is sealed with AES-256-GCM under a key derived by HKDF from `KEY_SECRET` and the person's agent key, with the provider and base URL as associated data, so a row copied to another DO or pointed at another host fails to open. During a rotation (`KEY_SECRET_PREVIOUS` set) a key the old secret opens is resealed on use.

**A key pasted into chat is caught.** `enqueue` runs `redactSecrets` on every message before anything stores it: a known key prefix (`sk-ant-`, `sk-or-`, `oc_sk_`, or `sk-` with 16 or more characters after it) becomes `<a key, removed>` wherever it appears, inside a link, after `=` or `:`, or in a query string. So does a token of 32 or more characters that mixes cases and digits with some entropy, or is 48 or more lowercase hex characters (a Git SHA is 40), unless it follows a slash, a dot or an `@`, as a link's path, a host name or an address does. The redacted message is a command of its own: code replies with a fresh `/key` link and advice to revoke the key, since the chat provider saw it.

**Prompts are bounded per route.** Every tokenizer here is byte-level, so a prompt's UTF-8 bytes bound its tokens. `routeFor` gives each route a byte budget below its card's long-prompt tier (Haiku's 100K, Qwen's 32K) and its context, at most 80,000. `renderUser` returns sections: the newest message whole, the batch's earlier messages cut to their byte caps, the summary, pending wake-ups and open tasks are kept whole, and `fitPrompt` drops the oldest conversation first, then notes, marking each cut. At their caps, in Thai, the kept sections leave room for a message on every route, and `budget.test.ts` pins that. When the newest message with them still doesn't fit, nothing is sent and code answers, in the person's language, that it's too long and asks them to split it (turn outcome `too_long`). When the history not yet in the summary doesn't fit the smallest budget among the person's lanes, one compaction step runs first, in the same drain. If compaction is backing off or fails, the turn shows the newest history that fits, and `turn_log.history_trimmed` is 1; it is never trimmed silently. A loose-mode repair whose prompt would exceed the budget isn't sent, and the call fails as invalid output.

**Compaction folds only what it saw.** A page takes whole turns, oldest first, then whole notes, until the compaction route's byte budget (the smallest among the person's lanes, less the system prompt and any inlined schema) is full, and folds through the last turn it sent. It never cuts a turn's text. A turn bigger than an empty page is folded as a placeholder line, `[long message on <date>, <n> bytes, not summarized]`, and its row is kept, outside every turn prompt, until a later page can take it whole; only rows the model saw whole are deleted.

## Spend

Only metered lanes reserve: a person's own key (`byok`) and our included tier (`included`). The box reserves nothing, since the person's flat plan pays. `estimate()` is an upper bound on one attempt's bill. It counts the prompt's UTF-8 bytes plus 4,000 tokens for framing and the schema, prices all of it at the dearer of the input and cache-write rates, adds the route's full output budget, and adds the provider's fee (OpenRouter's 5.5%). A cost the provider reports wins over our card.

The reservation is local: `spent + reserved + estimate` must fit the scope's monthly cap, the person's own `cap_micro` for their key (default `OWN_KEY_CAP_USD`, $5, changed with `/key cap`) or `INCLUDED_CAP_USD` for ours. There is no global ceiling in code. The included tier's only global ceiling is the spend limit the operator sets on `INCLUDED_API_KEY` at the provider; when our provider answers 402, the person gets the monthly-limit notice. A key replacement keeps its month's `byok` spend.

Each attempt settles in its own transaction, with its `model_call` row, the moment it returns:

| Outcome | Charged | `model_call.status` |
|---|---|---|
| a response, valid or not | its usage, or the cost the provider reported | `settled` |
| a response with no usage and no reported cost, or a 200 whose body doesn't parse | the estimate | `usage_missing` |
| a short 429 or a 529, or the dev bridge is down | $0 | `unavailable` |
| the provider refused the key or the model | $0 | `provider_refused` |
| another 4xx, rejected before it ran | $0 | `rejected` |
| no response, a 408, another 5xx, or no full answer within the timeout | the estimate | `in_doubt` |
| over the cap, so not sent | $0 | `refused_user_cap` |
| the instance died mid-call | the estimate, charged by `recover()` | `recovered_after_crash` |

`recover()` settles only reservations another instance made.

Every provider attempt has a timeout through `AbortSignal` that covers the headers and the body: 60 s for a turn or a compaction, 20 s for the key page's probe. A timeout is `in_doubt`, since the provider may have run and billed it, and the batch backs off like any unavailable model, so a stalled endpoint can't hold the person's drain. An endpoint that answers without usage is charged at the estimate, so a person's own cap binds on an endpoint that never reports what it used.

## Failure cases

- **Crash mid-turn.** The claim committed `processing` and `attempts + 1`, and the reservation is durable. Each attempt settled when it returned. `commitTurn` is one transaction: turns, wake-ups, notes, outbox, inbox done and logs land together or not at all. `recover()` puts the batch back to `pending` and settles orphaned reservations from a dead instance at their estimate. After 3 claims the batch is poisoned. A message gets a fixed apology, a requested reminder gets its floor, and anything else gets nothing.
- **Model unavailable or the request rejected.** The batch goes back to `pending` with a 30 s doubling backoff, and attempts are kept. Later events wait behind it. A long outage ends as `model_failed` after 3 attempts, or 5 for a requested reminder. Invalid output or a refusal ends the turn the same way at once.
- **Crash after commit, before or during a send.** `recover()` turns `sending` back to `pending` with `in_doubt = 1`. A LINE reply that answered 5xx or lost its connection is marked in doubt the same way. So is a push that must be retried after LINE refused the reply token, so the retry doesn't present that token again. An in-doubt row is read without its reply token, so LINE pushes it with `X-Line-Retry-Key = outbox.id`, and a 409 counts as sent. If the lost attempt was a reply that landed, the person sees a duplicate. Telegram sends one `sendMessage` per row, texts joined by blank lines, so a retry repeats the whole row once and never part of it. A crash after a Telegram send that landed also duplicates. Budget admission was recorded before the send, so it is never charged twice.
- **Delivery failure.** A 429 or 5xx retries after 30 s, or after Telegram's `retry_after`. LINE's monthly-quota 429 fails at once, and the hourly quota check exists so the operator hears about it at 70% and 90%, long before. A row is dropped after 5 attempts.
- **Duplicate webhook.** `inbox.event_key` is `line:<webhookEventId>`, `tg:<update_id>` or `dev:<client id>`, inserted with `INSERT OR IGNORE`. Done rows are kept 14 days for this.
- **Box unavailable or signed out.** A turn on a `signed_in` box that times out (120 s), gets a 5xx or loses the network is logged as a `box` call with status `unavailable` and backs off like an unavailable model; it runs on the person's key only if they said the key may back the box up. A `409 signed_out` sets the box to `signed_out`, sends one fresh link and logs `rejected`; the turn ends there, and later turns get one line a day saying the plan isn't signed in until polling sees the sign-in. A crash mid-call re-runs the turn, which costs nothing on the box.
- **A person's provider refuses their key.** The key rests, the person is told at most once a local day, and the turn moves to the next lane or ends as `no_access`, whose reply names the problem. A usage window counts as transient, so the batch backs off and ends in the fixed apology if the window outlasts it.
- **Webhook enqueue fails.** The Worker answers 200 only after every envelope is in its inbox. Otherwise the request fails with 500, and the channel's redelivery is the retry. LINE redelivery is off by default and must be turned on.
- **Alarm fires twice.** A concurrent call joins the in-flight drain. A sequential call finds nothing due, because a wake-up is closed in the transaction that inserts `wake:<id>`, and check-ins are keyed `checkin:<local date>`.
- **Message during a model call.** `enqueue` inserts it. The in-flight turn commits as planned, and the next batch's prompt contains the previous reply. Consecutive messages already pending when a batch is claimed (up to 10) become one turn. There is no debounce.
- **Compaction fails.** Compaction runs when there are more than 60 turns or 40 notes, or before a turn whose history doesn't fit. Each call folds one page: up to the oldest 30 turns, keeping the newest 30 unless the next turn needs the room, and up to 40 notes, folding toward 20, only as many of each as the page's byte budget holds. The trigger (keep 30 plus a page of 30) and the prompt window (one page more, 90) derive from one pair of constants in `compaction.ts`, so in steady operation every turn is either in the summary or in the prompt: a drain can add a page of turns before its own compaction runs. Any outcome other than success backs off 5 minutes, doubling to a day. The backoff is stored on the `memory` row, is part of the alarm time, and is reset on success. A backlog shrinks one page per drain.
- **D1 down.** Logs wait in `log_outbox` and ship later with deterministic ids, backing off from 10 s, doubling to an hour. Only a duplicate id is skipped. A row D1 refuses, such as one an old CHECK doesn't allow, fails the flush the same way until the ledger is migrated.

### What it does not do

No turn runs inside the webhook request. There are no lock rows, no stored alarm time, no model-chosen ids or time zones, no mutable counters for anything countable, no Cloudflare Queues and no Agents SDK. A turn still writes D1 where the write itself is the cross-user decision the turn needs: beta invite issuance and seat claims, billing invite and join writes, and box inventory claims. Those conditional writes decide the reply and can't be deferred to `log_outbox`; ordinary facts still ship later through it.

## Tradeoffs accepted

- **No debounce.** A reply starts at once. In exchange, a burst of texts that arrives during a model call becomes more than one turn.
- **Charging the estimate when the bill is unknown.** Spend is never under-counted after a crash or a lost response, at the cost of over-charging some calls.
- **A box outage ends a box-only person's message in "say it again"** after the usual three attempts, in exchange for never spending anyone's money they didn't agree to.
- **A signed-out box is not a fallback either.** A person whose plan is connected but signed out gets a line a day saying so, rather than their key being used without a yes.
- **The provider's own spend limit is the included tier's only ceiling.** It holds only if the operator sets it on `INCLUDED_API_KEY`, in exchange for deleting the D1 lease table, its protocol and a cross-user hop. The included tier is off and may never ship.
- **Ceiling pricing for unpriced models.** A custom endpoint or an unlisted model is priced on the dearest card any preset on its protocol publishes (Haiku's today, on both protocols), so its cap is never looser than a listed model's and bounds tokens rather than dollars, and `/key` says "about".
- **Route-specific prompt budgets.** A cheaper route may see less of the conversation than Haiku does, in exchange for no route ever reaching its long-prompt tier.
- **The operator can decrypt saved keys,** since it holds `KEY_SECRET`. The key page says the key is kept only for the person's assistant; envelope encryption under a key the operator can't reach isn't available on Workers.
- **A failed probe uses up its link.** A mistyped key needs a fresh `/key`, in exchange for tickets that are single use and replay-safe.
- **Duplicate sends.** A crash in the send window can duplicate a Telegram message or an in-doubt LINE reply, in exchange for never losing a reminder.
- **Lossy compaction lag.** While compaction lags by more than a page (it is failing, or one drain added more than 30 rows), the oldest unfolded turns fall outside the 90-row prompt window, or the route's budget, until it catches up, one page per drain. `turn_log.history_trimmed` records every such turn. In exchange, the prompt is bounded and a reply waits on at most one compaction call.
- **Two languages for code-written text.** Corrections, the monthly limit, the late-notice fallback, the requested-reminder floor, and the plan and box messages are in Thai or English. A person who writes in another language gets English notices, while the model answers in their language.
- **Plan acceptance is week 1's only evidence.** A person can accept a thin plan, though code refuses one under 2 lines or 80 characters. In exchange, no model judgment decides whether a task counts. `completion.evidence` and `completion.via` show what a gate's pass rests on.
- **A typed yes counts.** A closed vocabulary can read an "ok" aimed at something else as acceptance, so it applies only to the newest message the person received, within 48 hours, and code confirms it in the chat. In exchange, nobody has to find a button that LINE hides after the next message.
- **A model call on every tap**, so the agent can follow up, such as scheduling the trip's reminders.
- **Replies only before admission.** A LINE reply token that expires before the reply leaves a stranger unanswered, in exchange for no billed push to anyone who isn't in.
- **One coarse DO class.** One `Agent` holds everything for a person, which gives one transaction per turn. The store and the pure planners keep each file single-purpose.

## Alternatives considered

- **Process inline in the webhook request.** Two webhooks for one person would run two turns at once, and a crash loses the event. Rejected because it pushes the serial, crash-safe invariant onto every entry point.
- **A 1.5 s debounce on every message.** It folds a burst into one turn but delays every reply. Replaced by starting the drain from `enqueue` and batching what is already pending.
- **Cloudflare Queues.** A second durable queue with no per-person ordering, when the DO's SQLite already is one. Rejected.
- **A lock or lease row** instead of the in-memory guard. It needs expiry tuning and a stale-lease path for a case that a DO's single instance already rules out. Rejected.
- **A global ceiling at all, for money that is now the person's own.** The D1 lease protected our key; with no operator key it guarded nothing. It was deleted. If the included tier ships and the provider's limit proves too coarse, the lease can come back unchanged.
- **A stored access mode** (`none | box | key | included`, switched by commands). The box machine already owns whether the box can serve, so the row would need a sync on every box transition, plan refresh and key fault. Rejected as split ownership.
- **Every person's AI in a box,** keys included (Claude Code pointed at the person's endpoint). One path, but every person would cost us a machine even when their AI costs $10, only Anthropic-shaped endpoints would work, and every turn would pay the box's latency. Rejected.
- **A gateway holding every person's key,** our own or a hosted router. It moves the key out of the person's DO into a second holder and still leaks provider differences back to us. Rejected.
- **Keys in D1 or KV.** A second store for state one DO already owns, readable by any Worker path. Rejected.
- **The Anthropic SDK for the Anthropic path.** Its schema helper transforms the schema differently from what the box and the OpenAI path receive. One `jsonSchemaOf` and one fetch-based wire give every path the same model-facing schema and one HTTP table. Rejected.
- **Analytics Engine for logs.** It samples, expires data and has no joins. The gates need exact weekly counts and joins. Rejected.
- **The Cloudflare Agents SDK.** It owns the alarm and its own schedule table, and our alarm is the minimum over four tables with quiet-hours-aware fire times. Rejected.
- **The model rewrites its whole memory each turn.** It costs output tokens every turn and lets one bad turn erase facts. Rejected for append-only notes plus compare-and-set compaction.
- **Counting requested reminders against the unasked budget.** A heavy reminder user would lose the fourth reminder they asked for. Rejected.
- **Typed week-2 job and approval stubs.** The `AgentEvent` union already leaves the slot, and stubs written before the booking probe would be guesses. Not taken.
- **Keep the model's per-turn task label and check it.** A label can't carry a task's identity across turns, and a week-2 result arrives in a turn the model didn't label. Replaced by code-owned tasks and facts.
- **The model labels why it sent an unasked message.** Code can't check "this is new", and the credit rule (an open task, the person's decision, then one completion) already excludes the checks the label was meant to catch.
- **Admission at the Worker edge, or read from D1 each turn.** Either costs a D1 round trip per webhook or turn and splits one person's state across two owners, while consent lives in the DO anyway.
- **One invite table shared with billing.** The beta's codes and billing's seats differ in cap, lifetime, issuer and meaning. `ADMISSION` routes the same two commands instead.

## Open questions and risks

- Is charging the estimate on a crash or a lost response acceptable for the cost gate? Those calls are labeled in `model_call.status`.
- Does structured output on Haiku 5.5 accept the `anyOf` that `jsonSchemaOf` makes from the action union? If not, flatten it to one object with a `type` enum, validated in `planTurn`. `scripts/eval.ts` answers it on its first run with a key.
- Does OpenCode Go's Anthropic path pass `output_config` through? The probe decides strict or loose per key, so either answer works, but loose costs a repair call now and then.
- The model slugs and prices in `PROVIDERS` come from published pages, not from a call we made. Confirm each preset's slug against its `/models` listing before relying on it.
- In the worst case (a 4,000-byte summary, 20 pending reminders, 20 open tasks, and a batch whose earlier messages fill their 4,000 bytes), the smallest route (Qwen's, about 20 KB for the user prompt in loose mode) has about 2.9 KB (some 950 Thai characters) left for the newest message, and a longer one gets the "too long" notice. Haiku's budget holds it.
- The key detector can miss a key with no known prefix that is short or all one case, and can flag a long mixed-case token that isn't one. A flagged message is answered by code, never lost.
- Does the system prompt clear Haiku 5.5's minimum cacheable prefix? If not, caching silently does nothing.
- The only guard on the requested bypass of budget and quiet hours is the model's `asked` flag on a message turn, bounded by the 20 pending reminders.
- A drain stops starting batches after 60 s and re-arms for now, which keeps one person well inside the 15-minute alarm limit.
- The quota reserve keeps 10% of LINE pushes for replies and requested reminders, but nothing yet ranks within that reserve, so a burst of requested reminders can still use it up.

Known ordering races, all open:

- Concurrent LINE envelopes for one person can swap. The Worker enqueues one webhook's events in parallel, and `inbox.seq` follows arrival order.
- Telegram lifecycle events in the same second can misorder. Their timestamps are whole seconds, so two of them tie and apply in inbox order.
- A reply recorded in history may never have been delivered. The agent's text is committed to `turn` before delivery, and a dropped or failed row stays in the prompt as said.
