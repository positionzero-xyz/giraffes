# Box

A person's own Claude plan, run in an unmodified Claude Code inside their box. Locally the box is one Docker container and the Worker uses the static host, so every person shares that one box. Needs Docker running.

## Setup

1. `$GV prepare scripted --box`. It adds `BOX_HOST=static`, `BOX_SECRET` and `BOX_STATIC_URL` to `RUN_DIR/.dev.vars`, writes the box's bearer token to `RUN_DIR/box-token`, and prints the two commands for the next step. A re-run keeps the secret, so a running box stays valid. The box listens on `BOX_PORT` (default 18790).
2. Run the printed `docker build` and `up.sh ... --mock` lines. Build under your own tag and pass it as `BOX_IMAGE=<tag>` to `up.sh`, so the shared `giraffes-box:mvp` stays as it is. To keep every raw Messages API request the mock gets, add `MOCK_DUMPS=$RUN_DIR/evidence/dumps` to the `up.sh` line (on branches that have `box_session`). Keep it outside the box data folder, which a lost-volume check deletes.
3. Start `$GV worker`. `$GV doctor` adds `GET box /health -> 200, signedIn true`.

`--mock` signs the CLI in with a fake API key against `box/mock-api.mjs` inside the container, with every Anthropic host resolved to loopback. Without `--mock` the box starts signed out.

## Checks

- **Connect.** `$GV say <user> /claude`. A mock box is already signed in, so no link is sent. The outbox gets a "Setting up" reply and then a pushed "Your Claude plan is connected" within a second (`$GV wait <user> 's.turns.some(t => /plan is connected/.test(t.text))' 60`). `$GV dosql <user> "SELECT state FROM box"` reads `signed_in`, and the snapshot's `access.lanes` is `["box"]`.
- **Turn through the box.** Any message after connecting gets a sent reply (`ok` from the mock's agent path), and `$GV ledger "SELECT backend, model, status, cost_micro FROM model_call ORDER BY at"` shows `box`, `claude-plan:claude-haiku-5-5`, `settled`, `0`. A person who never sent `/claude` stays on whatever else they have (on `mvp/model-access`, the no-access offer).
- **One chat record (branches with `box_session`).** `$GV dosql <user> "SELECT id, seen_seq, length(memory) FROM box_session"` shows the session the DO names and the newest turn it has seen. In the dumps, a session's first request carries the memory at the end of `system`. A resumed request keeps that first `system`, because Claude Code 2.1.316 keeps the system prompt a session started with. Its newest user message carries `## Conversation you haven't seen` (turns another lane answered, or that the box missed) and, when memory changed, `## Memory (replaces the memory you had)`. To make the backup key answer, `docker stop gbox-e2e`, then restart the worker to clear the box skip window, and start the box again with `docker rm -f gbox-e2e` and the same `up.sh` line on the same data folder (a plain `docker start` leaves the mock stopped). For a lost volume, `docker rm -f gbox-e2e`, delete the data folder, and run `up.sh` again. The box log says `session not found on this box, starting a new one`, and the next request carries every recent turn.
- **Signed out.** `docker rm -f gbox-e2e`, start it again without `--mock` on a fresh data directory, and send a message. The person gets one pushed outbox text holding `/signin#t=` (the turn history shows `<sign-in link>` in its place), the box row moves to `signed_out`, and the ledger shows a `box` call `rejected`. On `mvp/model-access` there is no API fallback. With no backup key, the notice says nothing answers until they sign in and asks them to resend, the turn ends `no_access`, and later messages that day get no reply. With a key set as backup (`/key`, then `/key backup on`, against the stub from [model-access](./model-access.md)), the notice says the backup key answers for now and a `key` call answers the message. Before `mvp/model-access` the `rejected` row is followed by `api` calls.
- **Sign-in page.** Open the link from the outbox in the Browser pane. With a signed-out box, tapping **Open sign-in page** yields a real `claude.com/cai/oauth/authorize` URL, also left on the page as the "Tap here if the page didn't open" link. Never finish that sign-in with the operator's account.

## Box skip window

After any `box` call with status `unavailable` (a stopped container, a Docker outage), the agent skips the box for `BOX.skipAfterUnavailableMs` (5 minutes), held only in the Durable Object's memory. `doctor` reads green through it, and every drive inside it falls through to the key, the apology or `no_access`. Read when it started with `$GV ledger "SELECT max(at) FROM model_call WHERE backend='box' AND status='unavailable'"`, then wait it out or restart the worker, and throw away drives made inside it. A person who wrote during the outage saw the apology; record that as what a real person gets.

## Limits

The mock proves the Worker, the box server and the CLI wiring, not a real Claude plan, real Fly provisioning or suspend and resume. Say so in the proof. Clean up with `docker rm -f gbox-e2e` before `$GV clean`.
