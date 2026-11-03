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
Durable Object and a local D1, with a scripted model, a fake clock and fixed channel fixtures. Nothing
reaches the network.

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

## Deploy

1. Create the ledger and load its schema:
   ```sh
   npx wrangler d1 create giraffes-ledger          # copy the database_id into wrangler.jsonc
   npx wrangler d1 execute giraffes-ledger --remote --file src/ledger/d1-schema.sql
   ```
2. Set the secrets with `npx wrangler secret put <NAME>`:
   - `ANTHROPIC_API_KEY` (required; the deployed backend is `anthropic`)
   - `LINE_CHANNEL_SECRET` and `LINE_CHANNEL_ACCESS_TOKEN`
   - `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET`

   A channel needs both of its secrets or neither. Without them its webhook answers 404.

   To let people connect their own Claude plan (`/claude`, see `docs/design/BOX.md`), set `BOX_HOST`:
   - `BOX_HOST=none` (the default): `/claude` replies that it isn't available, and nothing else changes.
   - `BOX_HOST=fly` needs the secrets `BOX_SECRET` (at least 16 characters; every box name and token
     derives from it, so changing it orphans every box) and `FLY_API_TOKEN` (an org token, sent as-is
     when it starts with `FlyV1 `), and the vars `FLY_ORG` and `BOX_IMAGE`. Optional vars:
     `BOX_APP_PREFIX` (default `gbox-`), `BOX_REGION` (default `sin`), `BOX_VOLUME_GB` (default 5) and
     `MAX_BOXES` (default 10).
   - `BOX_HOST=static` needs `BOX_SECRET` and `BOX_STATIC_URL`, one box at a fixed URL that every person
     shares. Start that box with `BOX_TOKEN` set to the token for the name `<BOX_APP_PREFIX>static`:
     ```sh
     node -e 'console.log(require("crypto").createHmac("sha256", process.env.BOX_SECRET).update("box:gbox-static").digest("base64url"))'
     ```

   Before turning on `fly`, check the account with a throwaway box. It creates billable resources for a
   few minutes and deletes them:
   ```sh
   FLY_API_TOKEN=... FLY_ORG=... BOX_IMAGE=... BOX_SECRET=... node scripts/fly-verify.ts --yes
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
npx wrangler d1 execute giraffes-ledger --remote --command "SELECT * FROM gate_weekly_delegation"
```

### Update an existing ledger

Re-running `src/ledger/d1-schema.sql` adds new tables and views, such as `action_rejection`. Do that
before you deploy code that writes to them, or log shipping backs off until the table exists. Re-running
the file doesn't change the CHECK constraints of a table that already exists. A row that an old CHECK
refuses, such as a `rejected` model call or a `too_long` rejection in a ledger created before those values
existed, fails its log flush. The flush backs off and retries, and log shipping stays stuck behind that
row until the table is migrated. `model_call.status` and `action_rejection.reason` have both gained
values. To migrate their CHECKs, rebuild the two tables:

```sh
npx wrangler d1 execute giraffes-ledger --remote --command "DROP VIEW cost_per_agent_week; DROP INDEX model_call_agent_time; DROP INDEX action_rejection_agent_time; ALTER TABLE model_call RENAME TO model_call_old; ALTER TABLE action_rejection RENAME TO action_rejection_old"
npx wrangler d1 execute giraffes-ledger --remote --file src/ledger/d1-schema.sql
npx wrangler d1 execute giraffes-ledger --remote --command "INSERT INTO model_call SELECT * FROM model_call_old; DROP TABLE model_call_old; INSERT INTO action_rejection SELECT * FROM action_rejection_old; DROP TABLE action_rejection_old"
```

The second command recreates both tables with the current CHECKs, their indexes and the view. Run the
same commands with `--local` to migrate the dev ledger.

The box path adds the `boxes` table, which re-running the schema file creates, and a `backend` column on
`model_call`, which it can't add to an existing table. Add the column once, before deploying code that
writes it:

```sh
npx wrangler d1 execute giraffes-ledger --remote --command "ALTER TABLE model_call ADD COLUMN backend TEXT NOT NULL DEFAULT 'api' CHECK (backend IN ('api', 'box'))"
npx wrangler d1 execute giraffes-ledger --remote --file src/ledger/d1-schema.sql
```

If you rebuild `model_call` with the commands above instead, the rebuilt table already has the column, so
skip the `ALTER`. `SELECT *` copies by position, so replace the copy of `model_call` in the third command
with one that names the old columns, and every old row gets `backend = 'api'`:

```sh
INSERT INTO model_call (id, agent_key, purpose, model, status, estimate_micro, cost_micro, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, at)
SELECT id, agent_key, purpose, model, status, estimate_micro, cost_micro, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, at FROM model_call_old
```
