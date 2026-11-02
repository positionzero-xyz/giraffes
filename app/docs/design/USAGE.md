# Agent core: usage

Written before the types. The type sketch under `app/` is derived from this file; where they disagree, this file wins.

## The one idea

Each person is one Durable Object, `Agent`. It has exactly **one way in** (`enqueue`) and exactly **one executor** (`alarm`). Everything the outside world tells the agent is appended to its SQLite inbox and nothing else happens in the request. All work (model turns, firing wake-ups, delivering messages, compaction, shipping logs) happens inside `alarm()`, which drains durable tables and then re-arms the alarm to the earliest thing any table says is due. There is no stored "next alarm" value and no in-request processing, so there is nothing to keep in sync and nothing that can interleave.

```
 LINE / Telegram / dev ──► worker.ts ──► adapter.receive(req) ──► Agent.enqueue(envelope)   (INSERT OR IGNORE, set alarm)
                                                                           │
                                                          Agent.alarm() ◄──┘   the only executor
                                                             │
     fire due wake-ups ─► inbox    take next batch ─► model turn ─► one SQL transaction ─► deliver outbox ─► flush logs ─► re-arm
```

## Quickstart (local, no accounts)

```sh
# terminal 1: the Claude-login bridge (dev only; the Worker can't spawn processes)
bun app/dev/bridge.ts                    # listens on 127.0.0.1:8789, runs `claude -p` per call

# terminal 2
cd app && wrangler dev                   # MODEL_BACKEND=bridge, DEV_MODE=1 in .dev.vars
open http://localhost:8787/dev           # minimal chat page, user picker, live transcript
```

`.dev.vars`:

```
MODEL_BACKEND=bridge
MODEL_BRIDGE_URL=http://127.0.0.1:8789
DEV_MODE=1
```

Production sets `MODEL_BACKEND=anthropic` and `ANTHROPIC_API_KEY`, plus the LINE and Telegram secrets. Tests set `MODEL_BACKEND=scripted` and inject a script per test.

## Call site 1: the Worker routes a LINE webhook to a person's agent

`app/src/worker.ts`. One route serves every channel. The adapter owns signature checks and payload shapes, so the Worker never sees a LINE type.

```ts
export default {
  async fetch(req: Request, rawEnv: Env): Promise<Response> {
    const config = loadConfig(rawEnv);                     // validates env once, at the boundary
    const url = new URL(req.url);
    const hook = url.pathname.match(/^\/webhook\/(line|telegram|dev)$/);
    if (req.method === "POST" && hook) {
      const adapter = makeChannels(config)[hook[1] as ChannelId];
      const received = await adapter.receive(req);         // verifies x-line-signature over the raw body
      if (received.kind === "rejected") return new Response(null, { status: received.status });
      // Durable before we answer 200. If any enqueue throws we answer 500 and the channel redelivers;
      // the inbox's UNIQUE(event_key) makes the redelivery a no-op for the ones that landed.
      await Promise.all(received.envelopes.map((e) => agentStub(rawEnv, e.agent).enqueue(e)));
      return new Response("ok");
    }
    if (config.devMode) return devRoutes(req, rawEnv);    // GET /dev, GET /dev/transcript?user=
    return new Response("not found", { status: 404 });
  },
};

// A person is keyed by channel + channel user ID. No account linking in week 1.
const agentStub = (env: Env, key: AgentKey) => env.AGENT.get(env.AGENT.idFromName(key));
```

`enqueue` returns in one synchronous SQLite write, well inside LINE's webhook timeout. The reply token from the webhook rides along inside the envelope as an opaque `ReplyHandle`.

## Call site 2: one event, end to end

The person texts "remind me tomorrow 9am to call the clinic". Inside the `Agent` Durable Object:

1. `enqueue(envelope)` runs `INSERT OR IGNORE INTO inbox (event_key = 'line:<webhookEventId>', ready_at = now + 1.5s)` and sets the alarm to `ready_at` if that is earlier than the current one. Returns `"queued"` (or `"duplicate"` on a redelivery).
2. `alarm()` starts a drain. First it recovers anything a crashed run left behind (rows in `processing` or `sending`, open spend reservations).
3. It moves due wake-ups into the inbox (none here), then takes the next **batch**: the oldest ready event, plus any consecutive ready `message` events behind it, so three quick texts become one turn.
4. It builds the prompt: byte-stable system prompt (rules + playbook) first, then memory summary, notes, the last 30 turns, pending wake-ups with their keys, the batch, local "now", today's unasked budget left.
5. `#callModel("turn", prompt, TurnOutputSchema)` estimates cost, reserves it against the person's month (local SQLite, no network) and, if the local lease from the global ceiling is short, asks the ledger for another chunk. Then it calls the model once. The model returns:
   ```json
   { "actions": [
       { "type": "schedule_wakeup", "key": "call-clinic", "at": "2026-11-05T09:00", "note": "Remind: call the clinic" },
       { "type": "send", "text": "Done. I'll remind you tomorrow at 9." } ],
     "task": { "kind": "reminder", "key": "call-clinic", "status": "started" } }
   ```
6. `planTurn(output, ctx)` (pure) validates every action: local time to instant in the person's zone, not in the past, under 20 pending, key not already pending. It returns a `TurnCommit`, never a partial.
7. One `transactionSync`: append the person's text and the agent's text to `turn`, insert the wake-up, insert one outbox row (`intent = 'reply'`, both texts, the reply handle), mark the inbox rows `done`, settle the reservation to actual cost, append log rows to `log_outbox`.
8. Delivery: the LINE adapter sees a fresh reply token and calls the free reply API. If the token is stale it pushes with `X-Line-Retry-Key = outbox.id`.
9. After the inbox is empty: compaction if the verbatim turns crossed the threshold, flush `log_outbox` to D1, then `#rearm()` sets the alarm to the earliest of: ready inbox rows, the next wake-up's fire time, the next outbox retry, pending logs.

## Call site 3: a wake-up is scheduled and fires

The wake-up from call site 2 is a row in `wakeup` (`key = 'call-clinic'`, `due_at`, `status = 'pending'`). `#rearm()` includes `fireAt(due_at, tz)` in its minimum, so the Durable Object alarm is set for 09:00 Bangkok time.

At 09:00 `alarm()` runs `planFiring(now, tz, dueWakeups)` (pure). For each due row it returns either "fire" or "defer until 08:00" (quiet hours). Firing is one transaction:

```ts
// inside Agent.#fireDueWakeups(), simplified
for (const f of planFiring(now, person.tz, store.dueWakeups(this.sql, now))) {
  if (f.kind === "defer") continue;                       // re-arm will pick up f.until
  store.tx(this.ctx, () => {
    store.insertInbox(this.sql, { key: eventKey.wakeup(f.wakeup.id), event: f.event, readyAt: now });   // INSERT OR IGNORE
    store.markWakeupFired(this.sql, f.wakeup.id, now);
    if (f.next) store.insertWakeup(this.sql, f.next);     // the daily check-in schedules its successor
  });
}
```

The event then goes through the same turn as a message, with two differences decided by code, not the model:

- Its sends are `intent = 'unasked'`, so delivery checks quiet hours and the daily budget (3) before sending. Over budget, the row is dropped and logged to `unasked_message` with `status = 'dropped_budget'`.
- If `firedAt - dueAt > 1h`, the prompt states the real due time and the turn must carry a `lateNotice`. Code prepends it to the first text, and falls back to a fixed notice if the model left it out.

The daily check-in is a wake-up of kind `checkin` with the reserved key `daily-checkin`. Code creates it on first contact and on `follow`, and inserts its successor when it fires. Its inbox key is `checkin:<local date>`, so there is at most one check-in per local day, whatever happens to the rows.

## Call site 4: a test drives a conversation

`app/test/agent.test.ts`, with `vitest` and `@cloudflare/vitest-pool-workers`. The scripted model validates each canned output against the real schema, so a schema change breaks the script, not production.

```ts
import { devChat, schedule, scripted, send, turn } from "./testkit";

test("a reminder set at 21:30 for 23:00 is held until 08:00 and says it is late", async () => {
  const model = scripted([
    turn({ actions: [schedule("bins", "2026-11-04T23:00", "Take the bins out"), send("Will do.")], task: ["reminder", "bins", "started"] }),
    turn({ actions: [send("Take the bins out!")], lateNotice: "Sorry, this was due at 23:00 last night.", task: ["reminder", "bins", "completed"] }),
  ]);
  const chat = await devChat("alice", { model, at: "2026-11-04T21:30", tz: "Asia/Bangkok" });

  await chat.say("remind me at 11pm to take the bins out");
  expect(await chat.received()).toEqual([
    "Will do.\n(I don't send messages between 22:00 and 08:00, so this reminder will come at 08:00.)",
  ]);

  await chat.advanceTo("2026-11-05T08:00");               // moves the fake clock, runs the DO alarm until idle
  expect(await chat.received()).toEqual(["Sorry, this was due at 23:00 last night.\nTake the bins out!"]);

  expect((await chat.snapshot()).unaskedSentToday).toBe(1);
  expect(chat.logs("turn").map((l) => l.taskStatus)).toEqual(["started", "completed"]);
});
```

Pure policy is tested without the Worker runtime (`app/test/policy.test.ts`):

```ts
import { admitUnasked } from "../src/policy/outreach";

test("fourth unasked message of the local day is dropped", () => {
  const v = admitUnasked({ now: at("2026-11-04T15:00+07:00"), tz: BKK, sentToday: 3, dailyBudget: 3, status: "active" });
  expect(v).toEqual({ verdict: "drop", reason: "budget" });
});
```

## Querying across users

Every log row lands in D1 (`app/src/ledger/d1-schema.sql`). The MVP gates are views over it, for example:

```sh
wrangler d1 execute giraffes-ledger --command "SELECT * FROM gate_weekly_delegation"
wrangler d1 execute giraffes-ledger --command "SELECT * FROM unasked_with_followup WHERE followed = 1"
```
