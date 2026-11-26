---
name: giraffes-verify
description: Drive the giraffes agent core (app/, Cloudflare Worker plus one Durable Object per person) locally the way a person texting it would, through the dev channel and dev chat page, with a real model via the claude -p bridge or the no-model scripted backend. Use to prove a change to replies, reminders, check-ins, follow/block, delivery or the ledger works in the running app, not just in vitest.
---

# Verify giraffes

`scripts/gv` is the harness. Every command needs `RUN_DIR`, a scratch directory that holds this run's config, Durable Object and D1 state, pidfiles and `evidence/`. Use a fresh one per run, under the session scratchpad.

```sh
GV="$(git rev-parse --show-toplevel)/.claude/skills/giraffes-verify/scripts/gv"   # Git Bash; from PowerShell: node <same dir>/gv.mjs
export RUN_DIR=<scratchpad>/gv-<label>
$GV help
```

The run never writes under `app/`. `gv prepare` writes a copy of `app/wrangler.jsonc` into `RUN_DIR` with `main` made absolute, so wrangler's `.wrangler/`, `.dev.vars` and state all land in `RUN_DIR`. Source edits under `app/src` still hot-reload. To verify another checkout (a worktree), set `APP_DIR=<checkout>/app` before `prepare`.

## Launch

1. `$GV prepare bridge` (real model through your `claude` login) or `$GV prepare scripted` (no model, see Backends). It refuses if a port is taken. Defaults are worker 8797, bridge 8799, inspector 9339, chosen to stay off the README's 8787/8789. Override with `WORKER_PORT`, `BRIDGE_PORT`, `INSPECTOR_PORT` on the `prepare` line. It also loads `src/ledger/d1-schema.sql` into the local D1, where the agent flushes its turn, model-call and lifecycle rows and the gate views read them (before `mvp/model-access` it also held the spend leases every model call needs). It writes `KEY_SECRET` and `PUBLIC_URL` into `.dev.vars` for the `/key` page, and a re-prepare keeps the secret.
2. Start each long-lived process with the Bash tool's `run_in_background`, never a trailing `&`:
   - `RUN_DIR=... $GV worker`
   - `RUN_DIR=... $GV bridge` (bridge backend only)
3. `$GV doctor --wait 60 || exit 1`, unpiped, at the head of every drive command. Ready when every line reads `ok`. The worker log shows `Ready on http://127.0.0.1:<port>` and the bridge log shows `claude bridge on`.

## Doctor

`$GV doctor` is read-only. It checks that the pidfile processes from this `RUN_DIR` are alive, that `GET /dev` serves the dev chat page, and, for the bridge backend, that the bridge rejects an empty `/parse` with 400 (which proves it is up without spending a model call) and that `claude auth status` reports `loggedIn` (an expired login still lets `claude -p` exit 0, so the 400 alone can't catch it). It honors `CLAUDE_BIN` like the bridge and prints no account details. A run prepared with `--box` also checks the box's `/health` with the run's token. Run it first whenever anything looks off. A `FAIL` on the worker pid with `/dev` still answering means someone else owns the port. Stop and pick other ports. Never drive an instance this `RUN_DIR` did not start.

## Drive

People are dev-channel users. A user name matches `[A-Za-z0-9_-]{1,64}` and maps to the Durable Object `p:dev:<user>`. Use a fresh name per scenario, because a person's history, reminders and spend persist for the life of `RUN_DIR`.

- **Send as a person.** `$GV say <user> <text...>` first checks the same worker/bridge/box health as `doctor` (without the login probe), refuses to drive an unhealthy run, then posts `{user, text, id}` to `POST /webhook/dev` and prints `200 ok id=...`. `/follow` and `/block` are lifecycle events. Everything else is a message. Each call gets a unique id. Re-posting an id is deduplicated.
- **Read the agent.** `$GV snapshot <user> [name]` prints `GET /dev/transcript?user=<user>`, which is `{agent, turns, outbox, pendingWakeups, unaskedSentToday, spendThisMonthMicro}`, plus `box`, `plan`, `tasks`, `admission` and `access` on `mvp/model-access` (`agent` is `{key, status, tz, language}`; `access` holds `lanes`, the saved `key` and `spentMicro` by scope). Turn history stores sign-in and key links as placeholders; the real link is only in the outbox text. With `name` it also saves `evidence/<name>.json` and a revision record. Add `--pick '<js over s>'` to print only a projection, for example `--pick 's.outbox.map(o => [o.status, o.text])'`. Delivered messages are `outbox` rows with `status: "sent"` and `via: "reply" | "push"`. Dropped ones read `"dropped"`. The dev channel delivers in-process, so `outbox` is the delivery record.
- **Wait for state.** `$GV wait <user> '<js over s>' [seconds]` polls the snapshot every second until the expression is truthy, prints the snapshot, and exits 1 with the last snapshot on timeout. Add `--pick '<js over s>'` for a compact final print. Examples: `'s.outbox.some(o => o.status === "sent")'`, `'s.pendingWakeups.some(w => w.kind === "reminder")'`.
- **Load a script.** On branches with `/dev/script`, put `{"turns":[...],"compaction":[]}` in a file and run `$GV script <user> <file>` rather than rebuilding the curl body by hand.
- **Save a key.** `$GV key <user> <provider> <base-url> <key> [model]` sends `/key`, waits for the ticket in the outbox, posts the key form, and never prints the key. Use the local stub provider, never a real provider.
- **Wait for a reminder.** Wake-ups fire on the Durable Object alarm at real wall-clock time. The shortest reminder the agent accepts is 1 minute ahead. Ask for one 2 minutes out and `wait` up to 240 seconds for an outbox row with `intent: "requested"`.
- **Fire a wake-up now (dev clock).** On `main` from 14b4558, `POST /dev/fire {"user","key"}` (DEV_MODE only) makes that pending wake-up due now and arms the Durable Object alarm, so it goes out through the real `alarm()` path with no message needed. The dev page has a "Fire now (dev clock)" button per wake-up. Name the shortcut in the proof. A routine fired early keeps its schedule: its next occurrence is the first one after now.
- **Advance a wake-up (test-only).** There is no fake clock in `wrangler dev`. `$GV advance <user> <wakeup-key> [minutes-late]` rewrites that pending wake-up's `due_at` inside the Durable Object through wrangler's local explorer API. It fires on the agent's next drain, so follow it with any `say`. This skips the real alarm path. Use it for the daily check-in (`daily-checkin`, due 09:00 local) and late-notice cases, and say in the proof that the clock was shortcut.
- **Inspect raw state.** `$GV dosql <user> "<sql>" [params-json]` runs SQL in the person's Durable Object (tables in `app/src/agent/schema.ts`: `agent`, `inbox`, `turn`, `wakeup`, `outbox`, `spend_month`, `reservation`, `log_outbox`, and on later branches also `box`, `plan`, `task`, `admission`, `model_key`, `key_ticket` and more). Read with it. Write only through `advance`.
- **Read the ledger.** `$GV ledger "<sql>"` queries the local D1 and prints one compact JSON object per row (`turn_log`, `model_call`, `unasked_message`, `lifecycle`, the beta tables such as `enrollment` and `task`, and the `gate_*` views in `app/src/ledger/d1-schema.sql`; `spend_lease` exists only before `mvp/model-access`). Rows arrive when a drain flushes logs, normally within a second of the turn.
- **Chat page.** Open `http://127.0.0.1:<worker port>/dev` in the Browser pane. The user field is `input[name=user]` (default `alice`). The message box is `input[name=text]` with placeholder `Message, /follow or /block`, submitted by the `Send` button. The page polls the same snapshot each second and renders turns in `#turns`, deliveries in `#outbox` and wake-ups in `#wakeups`. The header `#meta` reads `<status> · <tz> · <language> · unasked today n/3 · $x this month` (no language before `mvp/fix-core`). The first screenshot can time out while the page settles. Retry it, then copy the saved image into `evidence/`. Close the Browser pane tab before cleanup.

Per-feature recipes live in [`features/README.md`](features/README.md).

## Gates and demo

- `bash scripts/gates.sh <out-dir> <rev>...` runs typecheck, app vitest, the box suite and the private-text check (`.githooks/check-private.mjs tree`, with a known-positive control) per revision, each in a detached worktree with a `node_modules` junction, and writes `gates.tsv`. It fails on zero tests. The junction borrows the main checkout's packages, so before landing also run the gates in a fresh clone with `npm ci`.
- `node scripts/demo-record.mjs <worker-url> <out-dir> [user]` drives the dev page with Playwright (set `PLAYWRIGHT` to the folder of any installed `playwright` package): remember a fact, set a weekday routine, set "Friday 9 am", fire both now, check recall, paste an injection. It checks state after each step through `/dev/transcript`, prints PASS or FAIL per step, and writes a `.webm` and a `.json` of results. Use the bridge backend. It runs headless, so no window needs to be visible.

### Backends

- **bridge.** `claude -p --model haiku` per call, using the operator's own stored `claude` login. It needs no API key, and the CLI still authenticates with every `CLAUDE*` environment variable unset, so launching it from inside a Claude Code session is fine. It spends the operator's own login, so a delegated run uses scripted unless its brief grants the bridge. `doctor` fails when that login has expired. Each turn costs well under a cent and takes about 4 seconds. Model wording varies, so assert on structure (outbox intent and status, wake-up keys and times, ledger outcomes), not exact text.
- **scripted.** No model. What an unscripted person gets depends on the branch:
  - **Before `mvp/model-access`,** every model call for an unscripted person throws. After three failed claims the agent poisons the batch and replies `Sorry, I couldn't process that. Could you say it again?` within a second. That still proves the dev channel, crash recovery, delivery, `/block` and the ledger at zero cost.
  - **On `mvp/fix-core` and later,** `POST /dev/script` loads canned model outputs for one person, each checked against the real turn schema, so model-driven paths run under `wrangler dev`. The body is `{"user": "<user>", "turns": [<turn output>...], "compaction": []}` and a minimal turn output is `{"actions":[{"type":"send","text":"hi"}],"tasks":[],"about":""}`. Other actions: `schedule_wakeup {key, at: "YYYY-MM-DDTHH:mm" local, note, asked, task: ""}`, `cancel_wakeup {key}`, `quiet`, `remember {note}`, `set_locale {timeZone, language}` (schema in `app/src/agent/turn.ts`). Each model call, including a wake-up's or a check-in's, consumes one entry. When the entries run out the call throws, and the batch ends in the apology with outcome `poison` after 3 attempts, each charged at its estimate as `in_doubt`.
  - **The script lives in the Durable Object's memory.** An idle object is evicted within about two minutes, and the script goes with it (`access.lanes` reads `[]` again). Post the script right before the `say` that uses it, and expect a wake-up that fires minutes later to find no script.
  - **On `mvp/model-access` and later,** an unscripted dev person has no model access. Their first message gets the code-written "connect your AI" offer, outcome `no_access`, no `model_call` row. The offer goes out once per local day; later messages that day get outcome `no_access` and no reply. A `/follow` without access gets the same offer and counts as that day's telling (earlier revisions of the branch sent nothing). A scripted person is served on the `included` lane (`backend = included`, model `bridge:claude-haiku-5-5`). A key test runs against `scripts/stub-provider.mjs`, a loopback stand-in for an OpenAI-compatible provider, never a real one. The recipe is [features/model-access.md](features/model-access.md).
- **box.** `$GV prepare scripted --box` plus one local box container with `BOX_HOST=static`. Turns for a person who sent `/claude` run through the real Claude Code CLI in the box, against a mock Messages API, with no operator login. See [`features/box.md`](features/box.md).

## Evidence

Everything goes in `$RUN_DIR/evidence/`. `worker.log` and `bridge.log` are appended there by the processes. Save a snapshot before and after each action (`$GV snapshot <user> <step>`) and redirect `ledger` output there for side effects. A proof shows the action (the `say` line), the resulting state (snapshot with outbox status and pending wake-ups) and the side effect (ledger rows). `prepare` and named snapshots record the app revision and dirty flag in `evidence/`. For box memory, `$GV footprint <container> <workload> [name]` records per-process RSS/anon memory plus cgroup `memory.stat`, labelled with host and image. Drive the real path, `say` or the chat page. `advance` and `dosql` writes are test shortcuts and must be named as such. Report the backend used. A scripted run is not proof of model behavior.

## Cleanup

1. `TaskStop` each background handle. On Windows this kills only the bash wrapper. The node and workerd tree keeps running and keeps the ports.
2. `$GV stop` kills the trees this `RUN_DIR` started (pidfile pid, `taskkill /T /F`), then confirms all three ports are free. It never kills by name.
3. `$GV clean` runs `stop`, then deletes state, config and wrangler cache from `RUN_DIR`. `evidence/` survives. Run `stop` or `clean` after every failed attempt too.

## Gotchas

- Piping `doctor`, `tsc` or `vitest` into `tail` or `grep` reports the pipe's exit status, not the check's. A `doctor | tail -1; <drive>` line drives straight past a FAIL. Run the check unpiped, or read `${PIPESTATUS[0]}`.

- The README flow (`app/.dev.vars`, `npm run dev` on 8787) shares `app/.wrangler/state` with the operator's own chats. This harness never touches it, and its people are invisible there.
- `gv` turns off Git Bash path conversion so `/follow` reaches the Worker verbatim. Calling `node gv.mjs` from Git Bash without `MSYS_NO_PATHCONV=1` turns `/follow` into a Windows path.
- The box suite is `npm test` in `box/` (Node's test runner). `npx vitest run` there prints "no tests" and exits 0, which proves nothing.
- Every worktree checkout, including a `git worktree add --detach` review copy, has no `app/node_modules`. Before `APP_DIR=<worktree>/app`, or before reviewers run tests in a review copy, link it from PowerShell: `New-Item -ItemType Junction -Path <worktree>\app\node_modules -Target <main checkout>\app\node_modules` (`cmd //c mklink /J` from Git Bash fails with "Invalid switch"). Before `git worktree remove`, unlink it with `[System.IO.Directory]::Delete("<worktree>\app\node_modules", $false)`, which removes the link and never the target, then confirm `Test-Path <main checkout>\app\node_modules\vitest` is still `True`.
- `bridge` refuses on a `RUN_DIR` prepared as scripted. Re-run `prepare` after `stop` to switch backends.
- The default time zone is Asia/Bangkok, and on `mvp/fix-core` and later each person has their own (`agent.tz`, changed by a `set_locale` action). Check-ins and agent-originated wake-ups wait out quiet hours 22:00 to 08:00 in the person's zone, so an `advance`d check-in does not fire then. During Bangkok's quiet hours, script a `set_locale` to a zone where it is daytime first. Unasked messages are capped at 3 per local day. Person-requested reminders are exempt from both.
- On a check-in the agent may choose quiet, and a person without model access gets outcome `no_access` and no text. A fired check-in is proven by a `turn_log` row with `event_kind = 'checkin'` and the next `daily-checkin` moving to tomorrow, not by a sent message.
