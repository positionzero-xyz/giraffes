# Agent core: usage

This file shows how callers use the agent core. The code is the authority. Where this file disagrees with it, fix this file. `RATIONALE.md` explains why the core is shaped this way. `../../README.md` covers running and deploying it.

## The one idea

Each person is one Durable Object, `Agent`, with one way in (`enqueue`) and one executor (`alarm`). `enqueue` appends the event to the SQLite inbox, arms the alarm, and starts a drain with `ctx.waitUntil`. The drain is the only code that calls the model, fires wake-ups, delivers messages, compacts memory and ships logs. When it finishes, it sets the alarm to the earliest time any table says is due.

```
 LINE / Telegram / dev ──► worker.ts ──► adapter.receive(req) ──► Agent.enqueue(envelope)   INSERT OR IGNORE, arm, waitUntil(alarm())
                                                                           │
                                                          Agent.alarm() ◄──┘   the only executor
                                                             │
     recover, fire due wake-ups, then per batch: model turn ─► one SQL transaction ─► deliver
     then: box step ─► deliver deferred rows ─► flush logs ─► compact one page ─► prune ─► re-arm
```

## Call site 1: the Worker routes a webhook to a person's agent

`app/src/worker.ts`. One route serves every channel. The adapter owns signature checks and payload shapes, so the Worker never sees a LINE or Telegram type.

```ts
const channel = req.method === "POST" ? url.pathname.match(WEBHOOK)?.[1] : undefined;
if (channel !== undefined && isChannelId(channel)) {
	const received = await makeChannels(config)[channel].receive(req);
	if (received.kind === "rejected") return new Response(null, { status: received.status });
	await Promise.all(received.envelopes.map((e) => agentStub(env, e.agent).enqueue(e)));
	return new Response("ok");
}
```

A person is keyed by channel and channel user id (`p:<channel>:<id>`). There is no account linking in week 1. If any `enqueue` throws, the request fails with 500 and the channel redelivers. `UNIQUE(event_key)` makes the redelivery a no-op for the envelopes that landed. A LINE reply token travels inside the envelope as a `ReplyHandle`.

## Call site 2: one message, end to end

The person texts "remind me tomorrow 9am to call the clinic".

1. `enqueue(envelope)` inserts `event_key = 'line:<webhookEventId>'` with `ready_at = now`, arms the alarm no later than now, starts a drain, and returns `"queued"`. A redelivery returns `"duplicate"`.
2. The drain recovers anything a dead instance left (rows in `processing` or `sending`, open reservations), then fires due wake-ups into the inbox, unless a message, follow or block is still waiting there.
3. It claims a batch, starting with the oldest unfinished event, and claims nothing while that event waits out a model backoff. If that event is a message, the consecutive ready messages behind it join, up to 10 in all.
4. `renderUser` builds the prompt after the byte-stable system prompt: local now in the person's zone, the memory summary and newest 50 notes, pending wake-ups with their keys, unasked messages left today, every turn not yet folded into the summary (up to 90), and the batch.
5. `#callModel("turn", …)` reserves the estimate against the person's month in local SQLite, under the monthly cap their plan sets, asks D1 for a lease chunk only when the local lease is short, then calls the model once. A lapsed person gets no model call: the turn ends with one notice a day instead. The model returns:
   ```json
   { "actions": [
       { "type": "schedule_wakeup", "key": "call-clinic", "at": "2026-11-05T09:00", "note": "Remind: call the clinic", "asked": true },
       { "type": "send", "text": "Done. I'll remind you tomorrow at 9." } ],
     "task": { "kind": "reminder", "key": "call-clinic", "status": "started" } }
   ```
6. `planTurn(output, view)` is pure. A `set_locale` action (an IANA zone and `th` or `en`) is applied first, so the turn's times are read in the new zone and its corrections are in the new language. It cuts over-long texts to their caps, applies cancels before schedules, converts the local time to an instant, admits or rejects each action, and returns one `TurnCommit`. Because a message started the turn and `asked` is true, the wake-up's origin is `person`. A rejected action adds a row to `action_rejection`. It also adds a code-written correction to any turn that sends text, and to any reply to a person even when the model sent none, unless it is a wake-up the agent set for itself.
7. One transaction appends the person's text and the agent's text to `turn`, inserts the wake-up, inserts one outbox row (`intent = 'reply'`, both texts, the reply handle), marks the inbox row `done`, settles the reservation at the real cost, and appends log rows to `log_outbox`.
8. Delivery uses the free LINE reply API while the token is fresh and the row is not in doubt. Otherwise it pushes with `X-Line-Retry-Key = outbox.id`. An unasked LINE message is dropped instead once this month's latest quota reading is at 90% or more.
9. After the batches, the drain delivers any deferred rows, flushes `log_outbox` to D1, compacts one page if due, prunes, and re-arms.

## Call site 3: a wake-up fires

The wake-up from call site 2 is a `wakeup` row (`key = 'call-clinic'`, `origin = 'person'`, `status = 'pending'`). The re-arm includes its fire time, so the alarm is set for 09:00 in the person's zone, Asia/Bangkok until they name another.

At 09:00 `planFiring` (pure) returns a firing for each due row whose fire time has passed. One transaction inserts the inbox event keyed `wake:<id>` and marks the wake-up `fired`. The event then runs through the same turn as a message. Its origin decides the rest:

| Origin | Created by | Fire time | Outbox intent | On delivery |
|---|---|---|---|---|
| `person` | a message turn with `asked: true` | due time, even at night | `requested` | sent; no budget, no quiet hours |
| `agent` | any other `schedule_wakeup` | 08:00 if due in quiet hours | `unasked` | quiet hours on every attempt; budget of 3 a day |
| `system` | code: the daily check-in at 09:00 | as `agent` | `unasked` | as `agent` |

If the wake-up fires more than an hour late, the prompt says so and code prepends the late notice to the first text. If a `person` wake-up's turn would send nothing, because the model failed or answered without a send, code sends `Reminder: <note>` instead.

The check-in has the reserved key `daily-checkin`. Code creates it on first contact, on a newer follow, and when a blocked person writes again, and it inserts the successor in the firing transaction. Its inbox key is `checkin:<local date>`, so it fires at most once per local day. While a person is blocked, due wake-ups are skipped.

## Call site 4: a person connects their Claude plan

With `BOX_HOST` set to `fly` or `static`, the person sends `/claude`. `BOX.md` has the full contract.

1. The message is claimed as a batch of its own and never reaches the model. With no box, the agent claims a slot in D1's `boxes`, inserts the `box` row in `provisioning`, and replies that it is setting up. Past `MAX_BOXES` it says it can't connect another plan.
2. The drain's box phase runs the host's `ensure` (Fly app, IPs, volume, machine) and then `GET /health` with the box token. When the box answers, the row becomes `signed_out` and the outbox gets `https://<box>/signin#t=<ticket>`, valid for 30 minutes.
3. The drain polls `/health` every 30 s for 30 minutes. When `signedIn` turns true, the row becomes `signed_in` and the person is told.
4. From then on, while the plan includes the box, `#callModel` sends each turn to the box's `/parse` first. No spend is reserved, and `model_call` logs it with `backend = 'box'` and cost 0.

```ts
test("a signed-in person's turn runs on their box with their token, reserves no spend, and is logged as backend 'box'", async () => {
	const box = fakeBox({ signedIn: true });
	const c = await devChat("fin", { model: scripted([]), at: "2099-11-04T10:00", box: box.deps });
	await c.say("/claude");

	box.replies.push({ kind: "reply", step: chat("Hello from your own plan.") });
	await c.say("hello");

	expect(c.logs("model_call").map((r) => [r.backend, r.status, r.costMicro])).toEqual([["box", "settled", 0]]);
});
```

`scripts/fly-verify.ts --yes` runs the same Fly host code against the real Machines API with a throwaway app and deletes it afterwards.

A box still `signed_out` 48 hours after its first link, never signed in, is reclaimed: the host destroys it, the D1 `boxes` row is marked deleted, the DO row goes, and the person is told `/claude` sets it up again.

## Call site 5: a person pays

With `BILLING=on` (`BOX.md`, "Plans and billing", has the contract), the person's first message with billing on started a 14-day trial. They send `/plan`.

1. The command runs without the model. It reads the person's standing from D1, says the plan and the days left, expires the Checkout sessions an earlier `/plan` handed out, and adds one new Stripe Checkout link per plan, created with the idempotency key `<agent key>|<message key>|<plan>`. A person who already pays gets a customer portal link instead.
2. The person pays. Stripe posts `checkout.session.completed` and `customer.subscription.created` to `/webhook/stripe`, in either order. The Worker checks the signature, reads only the subscription id and the owner from each, and calls the owner's `Agent.billingEvent`.
3. The DO handles its events one at a time and skips an event id it has handled. Otherwise it reads the subscription from Stripe, stores that state in D1, refreshes the owner's projection and every seat holder's DO, checks for a second paying subscription, and records the event id last. A person whose plan moved gets one message, such as "Thanks. Your Standard plan is active."
4. Every model turn from then on reads the plan from D1, and `planAllowsBox` and the plan's API cap decide the turn's path.

```ts
test("a payment after the trial lapsed is announced and the model answers again", async () => {
	const kit = billingOn({ TRIAL_DAYS: "0" });
	const c = await devChat("eve", { model: scripted([chat("Welcome back.")]), at: "2099-11-04T10:00", billing: kit.deps });
	await c.say("/plan");

	kit.stripe.subscriptions.set("sub_eve", stripeSubscription({ user: "eve", sub: "sub_eve", plan: "standard", status: "active" }));
	await postStripe(checkoutEvent({ user: "eve", sub: "sub_eve", plan: "standard" }));
	await c.settle();
	expect(await c.received()).toEqual(["Thanks. Your Standard plan is active."]);
});
```

The fake Stripe in `billingOn` holds what each subscription looks like now, so a test sets that state and posts the event that names it. `stripeChange(kit, …)` does both.

A Plus owner sends `/invite` for a one-time code, another person sends `/join <code>` to take a seat, and `/leave` gives it up. Seats are D1 rows, so a join checks and claims a place in one batch.

## Call site 6: a test drives a conversation

`app/test/agent.test.ts` runs inside the Workers runtime with `@cloudflare/vitest-pool-workers`. `devChat` posts to the real `/webhook/dev` route and swaps in a scripted model, a fake clock, an in-memory ledger and a scripted channel. The scripted model checks every canned output against the real schema, so a schema change breaks the script, not production.

```ts
test("a reminder the person asked for at 23:00 arrives at 23:00 and isn't counted as unasked", async () => {
	const model = scripted([
		turn({ actions: [schedule("bins", "2099-11-04T23:00", "Take the bins out"), send("Will do.")], task: ["reminder", "bins", "started"] }),
		turn({ actions: [send("Take the bins out!")], task: ["reminder", "bins", "completed"] }),
	]);
	const c = await devChat("dan", { model, at: "2099-11-04T21:30" });

	await c.say("remind me at 11pm to take the bins out");
	expect(await c.received()).toEqual(["Will do."]);

	await c.advanceTo("2099-11-04T23:00");
	expect(await c.received()).toEqual(["Take the bins out!"]);
	expect((await c.snapshot()).unaskedSentToday).toBe(0);
	expect(c.logs("unasked")).toEqual([]);
});
```

`advanceTo` moves the fake clock from alarm to alarm and runs each drain until idle. Scenarios use 2099 dates so that no stored alarm fires on the real clock. Pure policy is tested without the Durable Object in `app/test/policy.test.ts`:

```ts
test("a row admitted on an earlier day is admitted again against the day it goes out", () => {
	const admitted = "2026-11-04" as LocalDate;
	expect(admitUnasked({ ...input, admitted, now: at("2026-11-05T08:00+07:00"), sentToday: 2 })).toEqual({ verdict: "send", day: "2026-11-05" });
	expect(admitUnasked({ ...input, admitted, now: at("2026-11-05T08:00+07:00"), sentToday: 3 })).toEqual({ verdict: "drop", reason: "budget" });
});
```

## Querying across users

Every log row lands in D1 (`app/src/ledger/d1-schema.sql`). The MVP gates are views over it:

```sh
npx wrangler d1 execute giraffes-ledger --remote --command "SELECT * FROM gate_weekly_delegation"
npx wrangler d1 execute giraffes-ledger --remote --command "SELECT * FROM unasked_with_followup WHERE followed = 1"
npx wrangler d1 execute giraffes-ledger --remote --command "SELECT reason, COUNT(*) FROM action_rejection GROUP BY reason"
npx wrangler d1 execute giraffes-ledger --remote --command "SELECT backend, status, COUNT(*) FROM model_call GROUP BY backend, status"
npx wrangler d1 execute giraffes-ledger --remote --command "SELECT plan, status, COUNT(*) FROM billing_subscription GROUP BY plan, status"
npx wrangler d1 execute giraffes-ledger --remote --command "SELECT * FROM billing_duplicate"
```
