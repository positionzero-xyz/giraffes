# Bring your own subscription: the per-person box

A person who has a Claude plan can connect it. Their turns then run on the unmodified Claude Code CLI, in a small machine of their own (a "box"), signed in to their own Claude account. Everyone else brings their own API key (`/key`), or gets a code-written offer to connect one; we hold no model key. This file is the contract between the Worker and the box. The code is the authority.

## Shape

```
chat ──► Worker ──► Agent DO ──(HTTPS, bearer)──► box  https://<name>.fly.dev   claude -p
                        │                          ▲
                        └── sign-in link ──► person's browser ──► box /signin   claude auth login
```

- One box per person. On Fly it is one app, in its own private network, holding one machine (shared-cpu-1x, 2 GB) and one volume mounted at `/data`. The person's Claude login and the CLI's state live on that volume.
- The machine suspends when idle. Fly's proxy resumes it on the next request, so the Worker has no wake code. Suspend needs 2 GB of memory or less.
- `static` host: one box at a fixed URL, signed in to one Claude account. It is used for local development (`box/up.sh`) and for self-hosting by one person. Outside `DEV_MODE=1` it needs `BOX_STATIC_OWNER`, the one agent key that may claim it; anyone else's `/claude` says the feature isn't available.
- The Worker never sees the person's Claude credentials or the sign-in code. The code goes from the person's browser straight to their box.

## Names and secrets

- `BOX_SECRET` is one Worker secret. Every per-box value derives from it.
- Box name: `BOX_APP_PREFIX` + the first 16 hex characters of `HMAC-SHA256(BOX_SECRET, "name:" + agentKey)`. Fly app names are global, so the prefix is ours, and the HMAC keeps names from being guessed from chat ids. On the `static` host every person shares the one box, which holds one `BOX_TOKEN`, so its name is fixed: `BOX_APP_PREFIX` + `static`.
- Box token: `base64url(HMAC-SHA256(BOX_SECRET, "box:" + name))`. The Worker recomputes it. The box receives it once, in the `BOX_TOKEN` environment variable.
- Sign-in ticket: `exp + "." + base64url(HMAC-SHA256(boxToken, "signin:" + exp))`, where `exp` is epoch milliseconds. The box accepts it while `now < exp`. The Worker issues it for 30 minutes.

Test vector (both sides test against it):

| input | value |
|---|---|
| `BOX_SECRET` | `test-secret-0123456789abcdef` |
| name | `gbox-0123456789ab` |
| box token | `b-UiaAiUIgin1zs4CJbKAY68m8rphXVQwWrWHSMO2U4` |
| `exp` | `1790000000000` |
| ticket | `1790000000000.AA1PzFmYf_4obmGHsfd0634YPiMbVDnmjYWbmYI62kM` |

## Box HTTP contract

All JSON. Calls from the Worker carry `Authorization: Bearer <boxToken>`, compared in constant time. The sign-in routes take the ticket instead.

- `GET /health` (bearer) → `200 {"ok":true,"signedIn":boolean,"authMethod":string,"version":string,"box":string}`. `signedIn` is `loggedIn` from `claude auth status --json`. Any method counts, so a person's own API key in the box is also "signed in". `box` is a UUID the box makes the first time it starts on a volume, so a new volume under the same box name has a new one.
- `POST /parse` (bearer), body `{"model","system","user","jsonSchema"}` as `dev/bridge.ts` takes today, plus `"box"` and `"epoch"` (see `/erase`).
  - `200 {"structured","usage","stop","costUsd"}`, the first three exactly as the bridge. `costUsd` is the CLI's `total_cost_usd` or null; the Worker logs box turns at cost 0 and ignores it.
  - `409 {"error":"signed_out"}` when the CLI has no login.
  - `412 {"error":"stale"}` when the request is from before the box's last erase, names another volume, or arrives while an erase is unfinished. Nothing runs and nothing is written.
  - `502 {"error":"claude_failed"}` otherwise. Turns run one at a time per box. When the caller closes the request before the reply, the box kills that turn's CLI, and a queued turn whose caller is gone never starts.
- `POST /agent` (bearer) runs a turn in the person's Claude Code session and answers like `/parse`. It takes `"box"` and `"epoch"` the same way.
- `POST /erase` (bearer), body `{"epoch"}` with `epoch` a whole number from 1 → `200 {"box","floor"}`. It kills every Claude Code process on the box, including a sign-in in progress, and keeps new ones from starting until it ends. It then empties `HOME`, `/tmp` (with the CLI's working folder), `/var/tmp`, `/run/lock`, `/dev/shm`, `/dev/mqueue` and `CLAUDE_CONFIG_DIR` except `.credentials.json` and `.claude.json` when each is a regular file, and leaves only `oauthAccount` in `.claude.json`. Anything else under those two names, such as a folder or a link, is deleted. `floor` is the highest epoch any erase has asked for. The box writes `floor` and an unfinished-erase flag to `$BOX_STATE_DIR/erase.json` before it starts and clears the flag only when nothing else is left, so a restart mid-erase finishes the erase before it runs anything. `500 {"error":"erase_incomplete"}` when something is left; the flag stays, and every `/parse` and `/agent` answers `412` until an erase succeeds. Repeating an erase is safe.
  - A request without `box` and `epoch` runs only while the volume has never required them, so an older Worker keeps working on a box no newer Worker has touched. The volume requires them for good, recorded in `erase.json`, from its first erase, from the first request that carries them, or from the start when the machine has `BOX_REQUIRE_EPOCH=1`. The Worker sets `BOX_REQUIRE_EPOCH=1` on every Fly machine it creates or updates, so a request from before an erase can't run on a new volume. It reads `box` from `/health` and sends it, with the person's forget epoch, on every `/parse` and `/agent`; it reads `box` again after a `412` or an ensure. From then on `/parse` and `/agent` run only with this volume's `box` and an `epoch` at least `floor`; a request at `floor` is the normal turn after the erase. A request that reached the box before an erase started is refused when its turn comes, whatever its epoch, so nothing sent before the erase runs after it. `box` and `epoch` come together or not at all (otherwise `400`).
  - An image from before erase answers `404` to `/erase` and ignores `box` and `epoch`. The Worker's client reads that as not done.
- `GET /signin` (no auth) → the sign-in page. The page reads the ticket from the URL fragment (`#t=<ticket>`), so it never reaches server logs.
- `POST /signin/start` `{"ticket"}` → `200 {"url"}`. It starts `claude auth login --claudeai` with pipes and `BROWSER=true`, and returns the first `https://claude.com/`, `https://claude.ai/` or `https://platform.claude.com/` link the CLI prints. A second start replaces the first process. The process dies after 10 minutes. `502 {"error":"signin_failed"}` when the CLI prints no link within 30 s.
- `POST /signin/code` `{"ticket","code"}` → `200 {"signedIn":boolean}`. It writes the code and a newline to the CLI's stdin once, waits for the process to exit (up to 60 s, or until the CLI says the code is invalid, when it is killed), then reads `claude auth status`. The code is never logged. `409 {"error":"no_signin"}` when no sign-in is running or it is older than 10 minutes, `400 {"error":"bad_code"}` for an empty or multi-line code.
- The sign-in process stays owned until it exits. While a code is completing, a start or another code answers `409 {"error":"busy"}`, so two CLIs never share the credentials. The page disables both buttons while a code is submitting.
- Anything else → 404. Bad or expired auth → 401.

The box pins the CLI version in `box/package-lock.json`, sets `DISABLE_AUTOUPDATER=1`, runs as the unprivileged `agent` user with `HOME`, `CLAUDE_CONFIG_DIR` and `BOX_STATE_DIR` on `/data`, can write nowhere else but `/tmp` (`lockdown.sh` checks this at every start and refuses to start otherwise), and runs `claude -p` with `--tools ""` from an empty directory. The browser is not in the MVP image. Booking work adds it back, visible under Xvfb rather than headless.

## Worker side

Per person, in the Agent DO, one row:

```
box: { name, host: "fly" | "static", url, state, stateAt, linkSentAt, signinPollUntil, pollAt, reclaimAt, reclaimReason, retireAt, image, ensureAt }
state: "provisioning" | "signed_out" | "signed_in" | "reclaiming"
reclaimReason: "unused" | "failed" | "retired" | "removed"     set exactly when state is reclaiming
```

The table also keeps `attempts` (provisioning or reclaim attempts so far) and `next_at` (the earliest of the next provisioning attempt, sign-in poll, reclaim, reclaim retry, retire and ensure), which the alarm time includes. Each step stores its retry time before it calls out, so a crash mid-step retries later rather than at once. Provisioning gives up after 10 attempts, 15 s apart and doubling to 5 minutes, or at once on a failure that can't be retried, and the box goes straight to `reclaiming` with reason `failed`. A box that is already signed in when it first answers `/health` goes straight to `signed_in`.

- `/claude` (exact text, Telegram, LINE or dev) runs without the model:
  - No box: insert one in `provisioning` and reply that the box is being set up. The drain then provisions it step by step. Each step is idempotent, so a crash or a retry resumes where it stopped. When the box answers `/health`, the state becomes `signed_out` and the person gets the sign-in link.
  - `signed_out`: send a fresh sign-in link.
  - `signed_in`: say it is connected.
  - `reclaiming`: say the old box is being removed and to send `/claude` again in a few minutes.
  - A plan without the box (`included`, `lapsed`): say the plan doesn't include it and point at `/plan`.
  - The D1 claim fails: say setup can't start right now and to try again in a few minutes. The turn's outcome is `no_model`, as for every command; it is not retried and not logged as a model failure.
- After a link goes out, the drain polls `/health` every 30 s for 30 minutes. When `signedIn` turns true, the state becomes `signed_in` and the person is told their turns now use their Claude plan.
- Reclaim of an unused box: the first link sets `reclaimAt` to 48 hours later. Each later link moves it to at least that link's ticket expiry plus 2 minutes (a code posted just before expiry can take the box's 60 s exit wait to land), so every outstanding ticket is dead by then: `reclaimAt = max(first link + 48 h, latest link + 30 min + 2 min)`. A box that has ever been signed in has `reclaimAt` null and is never removed for being unused. When `reclaimAt` passes, the drain takes one last look at `/health`, still in `signed_out`. Signed in: it becomes `signed_in` as above. Answered and signed out: it moves to `reclaiming` with reason `unused`. No answer: nothing is destroyed, and the last look runs again 5 minutes later.
- Reclaiming, for any reason, skips `/health` and runs the reclaim: the host destroys the box (Fly `DELETE /apps/{app}?force=true`; on `static` there is nothing to destroy), the D1 `boxes` row gets `deleted_at`, and the DO row goes, together with one message for the reason. `unused`: nobody signed in for 2 days, and `/claude` sets it up again. `failed`: setup failed, and `/claude` starts over. `retired`: the plan doesn't include it, and `/plan` shows the plans. `removed`: the person sent `/claude remove`. The steps run in that order and each is done when repeated, so a crash between them resumes from the top on the retry. A failed destroy retries from 15 s, doubling to an hour, and tells the person nothing.
- `/claude remove` (exact text) runs without the model. It moves a box in any state to `reclaiming` with reason `removed` and says so, or, with no box left, just says the connection is removed. Either way it forgets that the person had a Claude plan, so their own key answers without the backup question from then on.
- Retire: with `BILLING=on`, when the drain sees a box (in any state but `reclaiming`) whose person's plan no longer allows one (`planAllowsBox` false), it sets `retireAt` to 14 days later and tells the person once, with the date, that the box will be removed unless their plan resumes. If the plan allows a box again before then, `retireAt` is cleared silently. At `retireAt` the box moves to `reclaiming` with reason `retired`, even if it was signed in, since it holds only their Claude login. With `BILLING=off` this never fires. The drain runs on the person's messages and daily check-in, so a lapse is seen within a day.
- Keeping machines current: the row keeps `image`, the `BOX_IMAGE` the box was last ensured with. When the drain sees a live box (`signed_out` or `signed_in`) whose `image` differs from `BOX_IMAGE`, or a box answers `401` to `/health` or `/parse` (a token from another `BOX_SECRET`), it sets `ensureAt` and runs the host's `ensure` for that box, with the same retries every 5 minutes until it succeeds. The box's state doesn't change and the person hears nothing. A turn whose `/parse` got `401` backs off and tries the box again.
- Turns and compaction: if the box is `signed_in` and `planAllowsBox` says yes (`trial`, `standard`, `plus`), `ModelAccess` sends the call to the box and reserves nothing, since the person's own plan pays. Every turn goes there: the person's messages, the daily check-in, reminders and the agent's own follow-ups. A turn runs as the person's Claude Code session at `/agent`, acting through Giraffe's tools, and compaction goes to `/parse`. The ledger logs the call with `backend = 'box'` and cost 0. A box that can't answer never falls back to money: not ours, and not the person's own key unless they said yes to it as a backup (see "Model access" in `RATIONALE.md`).
  - `signed_out` from the box: set `signed_out` and tell the person once with a new link. The turn ends there. Later turns get one code-written line a day saying the plan isn't signed in, until polling sees the sign-in.
  - unavailable (timeout 120 s, 5xx, network): the turn backs off like an unavailable model and ends in the fixed apology after three attempts, five for a requested reminder. A single blip does not suppress those retries or later turns. When the person has said their key may back the box up, the box is skipped for the next 5 minutes instead, so a dead box does not stand in front of every backup reply. That skip is kept in memory, so a restart of the DO costs at most one more try.
- `BOX_HOST=none` (the default) turns all of this off. `/claude` then says the feature isn't available yet.
- `MAX_BOXES` caps boxes across everyone. The D1 table `boxes` is the inventory, used to count boxes and to find orphans. A reclaimed box frees its slot, and the same person can claim it again.

## Fly host

Machines REST API at `https://api.machines.dev/v1`, with `FLY_API_TOKEN` (an org token) and `FLY_ORG`. Every call, reading its body included, times out after 15 s, and a timeout, a network error, a 429 or a 5xx is retryable. Steps, each treating "already exists" as done:

1. `POST /apps` `{app_name, org_slug, network: app_name}`.
2. `POST /apps/{app}/ip_assignments` `{type:"shared_v4"}`, then `{type:"v6"}`.
3. `POST /apps/{app}/volumes` `{name:"data", region, size_gb: BOX_VOLUME_GB}`.
4. `POST /apps/{app}/machines` with the image `BOX_IMAGE`, `guest {cpu_kind:"shared", cpus:1, memory_mb:2048}`, `env {BOX_TOKEN}`, the mount at `/data`, one service on 443/80 to port 8789 with `autostop:"suspend"`, `autostart:true`, `min_machines_running:0`, and `restart {policy:"on-failure"}`. When the app already has a machine, its config is compared with that one, counting only the values we set (Fly adds its own). If any differs (image, `BOX_TOKEN`, guest, services, mount or restart), `POST /apps/{app}/machines/{id}` `{config}` updates it in place with the full config on the same volume; otherwise the step is done.
5. Wait until `https://<app>.fly.dev/health` answers.

Delete is `DELETE /apps/{app}?force=true`, which removes the person's data. A 404 counts as done. Besides an operator, only a reclaim triggers it: an unused box, a failed setup, a box retired by its plan, or `/claude remove`.

`scripts/fly-verify.ts --yes` runs these steps against the real API with a throwaway app: it provisions, provisions again (which must create and update nothing), waits for `/health`, starts a sign-in, suspends the machine through the Machines API, waits for `suspended`, calls `/health` through the proxy and prints how long the resume took. A failure names its step, and the app is deleted at the end either way.

## Plans and billing

Prices live in Stripe, never in code. `app/src/billing/` holds the plan rules (`plan.ts`), the texts (`say.ts`), the D1 store (`store.ts`) and the Stripe boundary (`stripe.ts`).

| Plan | Box | Own API key | Our quota | Who |
|---|---|---|---|---|
| `trial` | yes | yes | no | everyone for `TRIAL_DAYS` (default 14) from their first message with `BILLING=on`, people from the beta included |
| `standard` | yes | yes | no | a person with their own Standard subscription |
| `plus` | yes | yes | no | the owner of a Plus subscription, and each person holding one of its seats |
| `included` | no | yes | `INCLUDED_CAP_USD` a month, only with `INCLUDED=on` and no access of their own | a person with their own included subscription |
| `lapsed` | no | no | no | `BILLING=on`, no paid plan or seat, trial over; no model call at all, compaction included |

A person with more than one picks in that order: their own Plus or Standard, then a seat, then their own included plan, then the trial. A paid plan applies from the moment Stripe says it is paying, even mid-trial. `/plan` sells `included` only while `INCLUDED=on`, and a subscription on the old `giraffes_ai` product reads as `included`.

- `BILLING=off` (the default): nobody lapses, no trial clock runs, no payment text goes out, and `/webhook/stripe` answers 404. The plan row exists with no trial end. `/plan` says the free beta has nothing to pay, and `/invite`, `/join` and `/leave` say plans aren't available yet.
- Lapsed: a message gets one notice a local day, "You have no active plan, so I can't answer messages for now. Send /plan to pick one." Later messages that day get nothing. A reminder the person asked for still goes out as the code-written `Reminder: <note>`. Check-ins and the agent's own wake-ups send nothing. The turn's outcome is `lapsed`.

### Data

D1 is the truth, because a Plus seat crosses Durable Objects:

```
billing_subscription: { id (Stripe sub_…), owner_key, customer_id (cus_…), plan: standard|plus|included, status, seats, past_due_since }
billing_seat:         { agent_key (one seat per person), subscription_id, joined_at, left_at }
billing_invite:       { code, subscription_id, created_at, expires_at, used_by, used_at }
billing_duplicate:    { owner_key, subscription_ids (space-separated), found_at }
```

`seats` counts the owner: `PLUS_SEATS` (default 3) plus the quantity of the seat price, at most `PLUS_MAX_SEATS` (default 6). Non-Plus subscriptions have 1.

A subscription is paying while it is `active` or `trialing`, or `past_due` for less than 14 days from `past_due_since`. The store sets `past_due_since` the first time it reads `past_due` and clears it when the status moves on, so a card that never pays stops the plan two weeks in even if Stripe keeps the subscription open.

A seat holds a place while its subscription is a paying Plus and fewer than `seats - 1` open seats joined before it. One SQL test (`countingSeat` in `store.ts`) decides it both for the standing and for `/join`'s "already seated" check, so a member pushed out when an owner cuts places holds no seat and can join another Plus plan.

Each person's DO keeps a projection, `plan: { trialEndsAt | null, own: {subscription, plan} | null, seat: {subscription, owner} | null }`. With `BILLING=on`, every model turn reads the person's standing from D1 in one query and computes the plan from it (`planOf`), so a lost refresh or a past_due running out changes the next turn. The projection stands in only when D1 can't be read, and drives the box decision, compaction and the snapshot. The trial ending needs no timer either way.

`trialEndsAt` is written on the person's first message with `BILLING=on`, and never while billing is off. The DO migration that made it nullable cleared every trial end the beta wrote, so people from the beta start a full trial when billing turns on.

### Commands

All exact text and without the model, each claimed as a batch of its own:

- `/plan` reads the person's standing from D1 first and refreshes the projection. It says the plan: days left on the trial, places taken for a Plus owner. A person who owns a paying subscription also gets a Stripe customer portal link to change or cancel it, and no Checkout links. With no plan to keep (trial or lapsed) and `BILLING=on`, it adds three Checkout links, one per plan, after expiring the ones an earlier `/plan` handed out. If an expiry or a Checkout or portal call fails, it says so and to try again.
- `/invite` (Plus owner): a 6-character one-time code from an alphabet without 0, O, 1 or I, valid for 7 days, as `/join <code>` on its own line. Refused when every place is taken or the person owns no paying Plus.
- `/join <code>` takes a seat if the code is unused and unexpired, the subscription is a paying Plus with a free place, the person isn't its owner and holds no counting seat elsewhere. One D1 batch checks and claims, so two people can't take the last place. Repeated by the person who joined, it answers joined again.
- `/leave` ends the person's seat. They go back to their trial if it is still running, else to lapsed. When D1 has no open seat but the projection still holds one, the first `/leave` committed and its refresh failed, so the repeat refreshes and answers as if it had just left.

### Checkout

`POST https://api.stripe.com/v1/checkout/sessions`, form-encoded, `Authorization: Bearer STRIPE_SECRET_KEY`, `Idempotency-Key: <agent key>|<message key>|<plan>`, so a retried turn gets the same session:

```
mode=subscription  client_reference_id=<agent key>
metadata[agent_key], metadata[plan], subscription_data[metadata][agent_key], subscription_data[metadata][plan]
line_items[0][price]=STRIPE_PRICE_<PLAN>  line_items[0][quantity]=1
success_url = cancel_url = PUBLIC_URL/billing/done      a page saying to go back to the chat
Plus only: optional_items[0] = STRIPE_PRICE_SEAT, quantity 1, adjustable 1 to PLUS_MAX_SEATS - PLUS_SEATS
```

The DO keeps each session id it hands out in `checkout_session { id, event_key, created_at }`. Before making new sessions, `/plan` sends `POST /v1/checkout/sessions/{id}/expire` for every stored session from another message, so only one set can be paid at a time. A 200 or a 400 or 404 (paid, already expired, unknown) removes the row; any other failure keeps it and sends no new links. Sessions from the same message key are left open, since a retried turn gets them back from the idempotency key.

A payer's portal link is `POST /v1/billing_portal/sessions` with `customer` (the subscription's `customer_id`), `configuration=STRIPE_PORTAL_CONFIGURATION` and `return_url=PUBLIC_URL/billing/done`.

Extra Plus places are an optional item the buyer adds at checkout. Stripe's portal can't switch a subscription with more than one product, so a Plus owner with extra places can cancel there but not change plan. The links stay out of the conversation history, which keeps `<payment link>` or `<billing link>` instead.

### Webhook

`POST /webhook/stripe`:

1. Verify `Stripe-Signature`: `t=<unix seconds>,v1=<hex>`, where some `v1` is HMAC-SHA256 with `STRIPE_WEBHOOK_SECRET` over `` `${t}.${payload}` ``, compared in constant time, and `t` is within 5 minutes of now. Otherwise 400.
2. Parse only who and what: `checkout.session.completed` in subscription mode, and `customer.subscription.created`, `.updated` and `.deleted`, each name a subscription id and an owner (`client_reference_id` or `metadata.agent_key`). Nothing else in the payload is used. Other types, and events without our agent key, get 200 and are ignored. An unreadable event gets 400.
3. The owner's DO handles its events one at a time. A Stripe event id it has handled answers `duplicate`. Otherwise it reads `GET /v1/subscriptions/{id}` and stores that state in D1, unless the stored row is `canceled` or `incomplete_expired`, which are final. It then refreshes the owner's projection, refreshes the DO of every open seat on the subscription whatever its plan, checks for a duplicate, and only then records the event id. A failed read or step is a 500, and Stripe's redelivery redoes each step, all of which are done when repeated. A subscription Stripe doesn't have, or whose owner differs from the event's, is ignored.

Reading the state instead of trusting the payload means no ordering rule: an `unpaid` after `past_due`, a shortened period or a checkout arriving after its Plus subscription all store what Stripe holds now. Handling one event at a time per owner keeps a slow read of an older state from landing after a newer one.

The plan is the item whose price's product, or else lookup key, is `giraffes_standard`, `giraffes_plus` or `giraffes_included` (or the old `giraffes_ai`), else `metadata.plan`; extra places are the quantity on `giraffes_seat`. Price ids don't matter, so a price that `stripe-setup.ts` replaced still counts for the people on it.

A refresh re-reads the person's standing. When it moves their plan, the person is told once: "Thanks. Your Standard plan is active.", "The Plus plan you joined is active.", their trial days left, or the lapsed notice.

If the owner ends up with more than one paying subscription, nothing is cancelled or refunded automatically. The event logs an error naming the ids, inserts a `billing_duplicate` row, and tells the person once, "It looks like you're paying for more than one plan at once. We'll sort out the duplicate for you." An operator finds them with `SELECT * FROM billing_duplicate`.

`scripts/stripe-setup.ts --yes` creates the products (ids `giraffes_standard`, `giraffes_plus`, `giraffes_seat`, and `giraffes_included` only with `--with-included`), the THB monthly prices with the same lookup keys (amounts in satang as flags), a customer portal configuration tagged `metadata[giraffes]=portal` (card updates, invoices, cancel at period end, switching between the plan prices it made), and the webhook endpoint for those four event types, then prints the values to set. A second run creates nothing and brings the portal configuration up to date. A live key also needs `--live`.

## Configuration

Box: `BOX_HOST` (`none` | `fly` | `static`), `BOX_SECRET`, `BOX_APP_PREFIX`, `BOX_IMAGE`, `BOX_REGION` (default `sin`), `BOX_VOLUME_GB` (default 5), `MAX_BOXES`, `BOX_STATIC_URL`, `BOX_STATIC_OWNER` (an agent key such as `p:telegram:12345`; `static` needs it unless `DEV_MODE=1`), `FLY_API_TOKEN`, `FLY_ORG`.

Billing: `BILLING` (`off` | `on`), `TRIAL_DAYS` (default 14), `PLUS_SEATS` (default 3), `PLUS_MAX_SEATS` (default 6). `BILLING=on` also needs `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STANDARD`, `STRIPE_PRICE_PLUS`, `STRIPE_PRICE_SEAT`, `STRIPE_PORTAL_CONFIGURATION` and `PUBLIC_URL`, and with `INCLUDED=on` also `STRIPE_PRICE_INCLUDED`.
