# Agent core

A per-person assistant on Cloudflare Workers. Each person is one SQLite-backed Durable Object (`Agent`)
reached over LINE, Telegram or a local dev page. The design is in `docs/design/USAGE.md` and
`docs/design/RATIONALE.md`.

## Tests

```sh
npm install
npm run typecheck
npm test
```

Tests run inside the Workers runtime (`@cloudflare/vitest-pool-workers`) against the real Worker route,
Durable Object and a local D1, with a scripted model, fake providers behind a fake fetch, a fake clock and
fixed channel fixtures. Nothing reaches the network.

## Run locally

The dev setup uses your own Claude login through the `claude` CLI, so it needs no API key or channel
accounts.

```sh
cp .dev.vars.example .dev.vars        # MODEL_BACKEND=bridge, DEV_MODE=1
npx wrangler d1 execute giraffes-ledger --local --file src/ledger/d1-schema.sql   # once

npm run bridge                        # terminal 1: runs `claude -p` per call on 127.0.0.1:8789
npm run dev                           # terminal 2: wrangler dev on http://localhost:8787
```

Open http://localhost:8787/dev, pick a user name and chat. Send `/follow` or `/block` to exercise
those events. The side panel shows each delivery's intent and status and the pending wake-ups.

The bridge is a dev lane every dev person shares, behind `DEV_MODE=1`. With `MODEL_BACKEND=scripted`
instead, no model runs and a dev person has no access at all, so they get the code-written offer to
connect one. `POST /dev/script` with `{"user": "<name>", "turns": [<turn output>...], "compaction":
[<summary output>...]}` gives that person a dev lane whose next model calls return these, in order, each
checked against the real schema. It lasts until the Worker reloads. To try the key page locally, also set
`KEY_SECRET` (32 or more characters) and `PUBLIC_URL=http://127.0.0.1:8787`; with `DEV_MODE=1` a custom
provider's base URL may be a loopback `http` stub, and so may a preset's, which then runs on that preset's own
route and prompt budget against the stub. Only a dev backend may run without `KEY_SECRET`.

## Evaluate a model

`scripts/eval.ts` replays the fixtures in `eval/fixtures` through any route with the Worker's own adapters,
prompt and `planTurn`, and reports schema validity, rule checks and cost per turn. Without `--yes` it
prints the plan and an upper bound on the cost:

```sh
OPENROUTER_API_KEY=sk-or-... node scripts/eval.ts --yes \
  --routes openrouter:anthropic/claude-haiku-5.5,deepinfra:deepseek-ai/DeepSeek-V4-Flash-0731 \
  --repeat 3 --max-usd 2 --gate valid=0.98,checks=0.9,month_usd=0.6
```

Keys come from `<PROVIDER>_API_KEY` (`OPENCODE_GO_API_KEY`, `DEEPINFRA_API_KEY`, ...), and a custom
provider also needs `<PROVIDER>_BASE_URL`. Each row lands in `eval/out/<time>.json`. Costs are list
price plus the provider's fee from our price cards, not an invoice.

## Deploy

1. Create the ledger and load its schema:
   ```sh
   npx wrangler d1 create giraffes-ledger          # copy the database_id into wrangler.jsonc
   npx wrangler d1 execute giraffes-ledger --remote --file src/ledger/d1-schema.sql
   ```
2. Set the secrets with `npx wrangler secret put <NAME>`:
   - `KEY_SECRET` (32 or more random characters) and `PUBLIC_URL` (the Worker's https URL), which turn on
     `/key` and the key page. A live deploy refuses to start without `KEY_SECRET`. Every saved key is sealed
     under it; to rotate it, see [LAUNCH.md](docs/LAUNCH.md#rotating-key_secret). A key that won't open is
     marked unreadable and tried again as soon as the configured secret changes, so putting the right
     secret back repairs it.
     `OWN_KEY_CAP_USD` (default 5) is the monthly limit a new key starts with.
   - `PRIVACY_CONTROLLER` (the operator's legal name and address) and `PRIVACY_CONTACT` (an email for
     privacy requests). Both appear on the privacy notice at `PUBLIC_URL/privacy`, which the consent message
     links to. A live deploy refuses to start without them, so on an existing Worker set them before you
     deploy this version. A dev run without them shows a placeholder operator.
   - `LINE_CHANNEL_SECRET` and `LINE_CHANNEL_ACCESS_TOKEN`
   - `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET`

   A channel needs both of its secrets or neither. Without them its webhook answers 404.

   With LINE configured, an hourly cron (in `wrangler.jsonc`) reads the LINE message quota into the ledger
   and alerts at 70% and 90% of it, once a month each. Set the var `OPERATOR_CHAT` to
   `telegram:<chat id>` or `line:<user id>` to get the alerts in that chat, on a channel that is configured.
   Without it they go to the Worker log.

   To let people connect their own Claude plan (`/claude`, see `docs/design/BOX.md`), set `BOX_HOST`:
   - `BOX_HOST=none` (the default): `/claude` replies that it isn't available, and nothing else changes.
   - `BOX_HOST=fly` needs the secrets `BOX_SECRET` (at least 16 characters; every box name and token
     derives from it, so changing it orphans every box) and `FLY_API_TOKEN` (an org token, sent as-is
     when it starts with `FlyV1 `), and the vars `FLY_ORG` and `BOX_IMAGE`. Optional vars:
     `BOX_APP_PREFIX` (default `gbox-`), `BOX_REGION` (default `sin`), `BOX_VOLUME_GB` (default 5) and
     `MAX_BOXES` (default 10).
   - `BOX_HOST=static` needs `BOX_SECRET` and `BOX_STATIC_URL`, one box at a fixed URL signed in to one
     Claude account. Outside `DEV_MODE=1` it also needs `BOX_STATIC_OWNER`, the agent key of the one person
     who may use it (such as `p:telegram:12345`); anyone else's `/claude` says it isn't available. Start
     that box with `BOX_TOKEN` set to the token for the name `<BOX_APP_PREFIX>static`:
     ```sh
     node -e 'console.log(require("crypto").createHmac("sha256", process.env.BOX_SECRET).update("box:gbox-static").digest("base64url"))'
     ```

   We hold no model key. `MODEL_BACKEND` is `live` (the default): each turn runs on the person's own
   access, their box first, then their own key if they have no box or said it may back the box up. With
   neither they get a code-written offer to connect one, once a day. `MODEL_BACKEND=anthropic` was removed
   and fails at load. Our own quota for a paid plan is off unless `INCLUDED=on`, which needs
   `INCLUDED_PROVIDER` (a preset with a fixed base URL), `INCLUDED_MODEL` (one of its priced models),
   `INCLUDED_API_KEY` (set a hard monthly spend limit on that key at the provider; it is the only global
   ceiling) and, with `BILLING=on`, `STRIPE_PRICE_INCLUDED`. `INCLUDED_CAP_USD` (default 1) caps each
   person. It serves only people on the included plan who have no access of their own.

   Before turning on `fly`, check the account with a throwaway box. It creates billable resources for a
   few minutes and deletes them:
   ```sh
   FLY_API_TOKEN=... FLY_ORG=... BOX_IMAGE=... BOX_SECRET=... node scripts/fly-verify.ts --yes
   ```
   Who may use the agent follows `ADMISSION` (see `docs/design/RATIONALE.md`, "Admission"):
   - `ADMISSION=beta` (the default): people on LINE and Telegram need an invite code and must consent
     before anything spends. Print recruit or staff codes, and set the beta's start, as SQL to run with
     `npx wrangler d1 execute giraffes-ledger --remote --command "..."`:
     ```sh
     node scripts/beta-codes.ts recruit th_line 40 --start 2026-11-16T00:00:00+07:00
     node scripts/beta-codes.ts recruit intl_telegram 40
     ```
     `--start` sets the start only if none is set yet; its first statement prints the old and new dates.
     Moving a start that is already set, which moves week 0 for every recruit, needs `--force`.
     A Telegram recruit opens `https://t.me/<bot>?start=<code>`; a LINE recruit sends `/join <code>`.
     Enrolled people get joiner codes with `/invite`. It can't run with `BILLING=on`.
     Send `/feedback <text>` to register a feedback event. The ledger keeps the event and cohort. The service discards the message and operator alerts still cover LINE quota.
     Send `/memory` to see the saved notes, reminders, tasks and personal settings for this chat, even without connected AI. Send `/memory next` for another page when prompted.
   - `ADMISSION=open`: everyone is admitted at first contact, and `/invite` and `/join` are billing's.

   Plans and payments (`/plan`, `/invite`, `/join <code>`, `/leave`, see `docs/design/BOX.md`) follow `BILLING`:
   - `BILLING=off` (the default): nobody pays, nobody lapses and no trial clock runs. `/plan` says it is
     the free beta.
   - `BILLING=on` needs `ADMISSION=open`, the secrets `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`, and the vars
     `STRIPE_PRICE_STANDARD`, `STRIPE_PRICE_PLUS`, `STRIPE_PRICE_SEAT`,
     `STRIPE_PORTAL_CONFIGURATION` and `PUBLIC_URL` (the Worker's https URL; Checkout and the billing
     portal send people back to `PUBLIC_URL/billing/done`). Optional vars: `TRIAL_DAYS` (default 14,
     counted from a person's first message with billing on, so people from the beta get a full trial
     too), `PLUS_SEATS` (default 3 people, the owner included) and `PLUS_MAX_SEATS` (default 6). `/plan`
     sells the included plan only while `INCLUDED=on`.

   Create the Stripe side with a test key first. It makes the products, THB monthly prices, the customer
   portal configuration and the webhook endpoint for `PUBLIC_URL/webhook/stripe`, and prints the values
   above. Run it again and it creates nothing. Amounts are satang flags (`--standard 29900 --plus 69900 --seat 19900`
   are the defaults). `--with-included` also makes the included plan's product and price (`--included 17900`
   sets its amount), and a live key also needs `--live`:
   ```sh
   STRIPE_SECRET_KEY=sk_test_... PUBLIC_URL=https://<worker> node scripts/stripe-setup.ts --yes
   ```
   Never set `DEV_MODE` in production: it opens the `/dev` routes and the unauthenticated dev channel.
3. `npx wrangler deploy`
4. Point the webhooks at the Worker: LINE at `https://<worker>/webhook/line`, and Telegram with
   `setWebhook` at `https://<worker>/webhook/telegram` with `secret_token` set to `TELEGRAM_WEBHOOK_SECRET`.
5. In the LINE Developers console, turn on **Webhook redelivery** for the channel. It is off by default.
   When an event can't be queued, the Worker answers 500 and relies on LINE to send the event again.
   Telegram retries a failed webhook on its own.

The gate queries are views in the ledger, for example:

```sh
npx wrangler d1 execute giraffes-ledger --remote --command "SELECT * FROM gate_summary"
```

Safety incidents and survey answers are operator rows in `safety_incident` and `survey_response`. The
safety incident's `detail` must be an empty string. The safety gate needs at least one red-team attempt, and the survey gate counts each
person's latest answer. `tasks_by_type` counts tasks opened and completed per kind, and
`tasks_by_evidence` breaks the completions down by the fact that completed them.

### Update an existing ledger

Apply `src/ledger/d1-schema.sql` before deploying this Worker. On an existing ledger, the file adds write guards,
clears the historical message and diagnostic fields, and updates the completion view. Apply it with `--local`
to upgrade a dev ledger. An older Worker may fail to flush diagnostics until it is replaced.
