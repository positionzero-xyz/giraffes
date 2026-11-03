# Bring your own subscription: the per-person box

A person who has a Claude plan can connect it. Their turns then run on the unmodified Claude Code CLI, in a small machine of their own (a "box"), signed in to their own Claude account. Everyone else stays on the API path in the Worker. This file is the contract between the Worker and the box. The code is the authority.

## Shape

```
chat ──► Worker ──► Agent DO ──(HTTPS, bearer)──► box  https://<name>.fly.dev   claude -p
                        │                          ▲
                        └── sign-in link ──► person's browser ──► box /signin   claude auth login
```

- One box per person. On Fly it is one app, in its own private network, holding one machine (shared-cpu-1x, 2 GB) and one volume mounted at `/data`. The person's Claude login and the CLI's state live on that volume.
- The machine suspends when idle. Fly's proxy resumes it on the next request, so the Worker has no wake code. Suspend needs 2 GB of memory or less.
- `static` host: a box at a fixed URL. It is used for local development (`box/up.sh`) and for self-hosting.
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

- `GET /health` (bearer) → `200 {"ok":true,"signedIn":boolean,"authMethod":string,"version":string}`. `signedIn` is `loggedIn` from `claude auth status --json`. Any method counts, so a person's own API key in the box is also "signed in".
- `POST /parse` (bearer), body `{"model","system","user","jsonSchema"}` as `dev/bridge.ts` takes today.
  - `200 {"structured","usage","stop"}` exactly as the bridge.
  - `409 {"error":"signed_out"}` when the CLI has no login.
  - `502 {"error":"claude_failed"}` otherwise. Turns run one at a time per box.
- `GET /signin` (no auth) → the sign-in page. The page reads the ticket from the URL fragment (`#t=<ticket>`), so it never reaches server logs.
- `POST /signin/start` `{"ticket"}` → `200 {"url"}`. It starts `claude auth login --claudeai` with pipes and `BROWSER=true`, and returns the first `https://claude.com/`, `https://claude.ai/` or `https://platform.claude.com/` link the CLI prints. A second start replaces the first process. The process dies after 10 minutes.
- `POST /signin/code` `{"ticket","code"}` → `200 {"signedIn":boolean}`. It writes the code and a newline to the CLI's stdin once, waits for the process to exit (up to 60 s), then reads `claude auth status`. The code is never logged.
- Anything else → 404. Bad or expired auth → 401.

The box pins the CLI version in `box/package-lock.json`, sets `DISABLE_AUTOUPDATER=1`, runs as the unprivileged `agent` user with `HOME` and `CLAUDE_CONFIG_DIR` on `/data`, and runs `claude -p` with `--tools ""` from an empty directory. The browser is not in the MVP image. Booking work adds it back, visible under Xvfb rather than headless.

## Worker side

Per person, in the Agent DO, one row:

```
box: { name, host: "fly" | "static", url, state, stateAt, linkSentAt, signinPollUntil, error }
state: "provisioning" | "signed_out" | "signed_in" | "failed"
```

The table also keeps `attempts` (provisioning attempts so far) and `next_at` (the next provisioning attempt or sign-in poll), which the alarm time includes. Provisioning gives up after 10 attempts, 15 s apart and doubling to 5 minutes, sets `failed` and tells the person once. A box that is already signed in when it first answers `/health` goes straight to `signed_in`.

- `/claude` (exact text, Telegram, LINE or dev) runs without the model:
  - No box: insert one in `provisioning` and reply that the box is being set up. The drain then provisions it step by step. Each step is idempotent, so a crash or a retry resumes where it stopped. When the box answers `/health`, the state becomes `signed_out` and the person gets the sign-in link.
  - `signed_out` or `failed`: send a fresh sign-in link. For `failed`, retry provisioning first.
  - `signed_in`: say it is connected.
- After a link goes out, the drain polls `/health` every 30 s for 30 minutes. When `signedIn` turns true, the state becomes `signed_in` and the person is told their turns now use their Claude plan.
- Turns: if the box is `signed_in` and the plan allows it, `#callModel` sends the turn to the box and reserves no API spend, since the person's own plan pays. The ledger logs the call with `backend = 'box'` and cost 0.
  - `signed_out` from the box: set `signed_out`, tell the person once with a new link, and run this turn on the API path.
  - unavailable (timeout 120 s, 5xx, network): run this turn on the API path. The usual per-person cap and the global ceiling apply.
- `BOX_HOST=none` (the default) turns all of this off. `/claude` then says the feature isn't available yet.
- `MAX_BOXES` caps boxes across everyone. The D1 table `boxes` is the inventory, used to count boxes and to find orphans.

## Fly host

Machines REST API at `https://api.machines.dev/v1`, with `FLY_API_TOKEN` (an org token) and `FLY_ORG`. Steps, each treating "already exists" as done:

1. `POST /apps` `{app_name, org_slug, network: app_name}`.
2. `POST /apps/{app}/ip_assignments` `{type:"shared_v4"}`, then `{type:"v6"}`.
3. `POST /apps/{app}/volumes` `{name:"data", region, size_gb: BOX_VOLUME_GB}`.
4. `POST /apps/{app}/machines` with the image `BOX_IMAGE`, `guest {cpu_kind:"shared", cpus:1, memory_mb:2048}`, `env {BOX_TOKEN}`, the mount at `/data`, one service on 443/80 to port 8789 with `autostop:"suspend"`, `autostart:true`, `min_machines_running:0`, and `restart {policy:"on-failure"}`.
5. Wait until `https://<app>.fly.dev/health` answers.

Delete is `DELETE /apps/{app}?force=true`, which removes the person's data. Only a person's explicit request or an operator triggers it.

## Plans and billing

- Plans: `trial` (30 days from the first box), `standard`, `plus`, `lapsed`. Prices live in Stripe, not in code.
- `BILLING=off` (the default): everyone stays on the trial with no end, for the free beta.
- `BILLING=on`: `/plan` replies with the plan and a Stripe Checkout link (subscription mode, `client_reference_id` = agent key). `POST /webhook/stripe` verifies the signature and updates the person's plan. A lapsed person's turns don't reach the box. They get one notice a day with the payment link.
- Plus covers up to 5 people, each with their own box and their own Claude login. The owner sends `/invite` to get a code. Another person sends `/join <code>`.

## Configuration

`BOX_HOST` (`none` | `fly` | `static`), `BOX_SECRET`, `BOX_APP_PREFIX`, `BOX_IMAGE`, `BOX_REGION` (default `sin`), `BOX_VOLUME_GB` (default 5), `MAX_BOXES`, `BOX_STATIC_URL`, `FLY_API_TOKEN`, `FLY_ORG`, `BILLING`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STANDARD`, `STRIPE_PRICE_PLUS`, `PUBLIC_URL`.
