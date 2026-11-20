# Giraffe

A personal AI assistant you text. Each person gets one always-on assistant that remembers what they tell it, turns plain words into reminders and routines, and messages first when one is due. People bring their own AI: their own Claude plan, run in an unmodified Claude Code on a small per-person machine ("box"), or their own API key.

Status: closed beta in preparation (November 2026). This file says what works today and how it was checked. It changes as the beta lands.

## What works, and how it was checked

| Piece | State |
|---|---|
| 1:1 chat with durable memory notes | Works on the local dev page with a real model (the `claude` CLI bridge) |
| Reminders from plain words ("remind me Friday 9 am"), in the person's time zone | Works on the dev page with a real model; fires on the Durable Object alarm |
| Routines ("every weekday at 8"), rescheduled by code, not by the model | Works on the dev page; covered by tests, including a clock change |
| Messages first when a reminder or routine is due | Works on the dev page; a real two-minute reminder fired without a shortcut |
| Limits enforced in code: 20 pending reminders, 3 unasked messages a day, quiet hours 22:00 to 08:00, message length | Covered by tests |
| A turn on the person's own Claude plan: unmodified Claude Code in their box as the agent, acting only through Giraffe's tools | Tested against the real Claude Code CLI with a mock model API; not yet run on a real Claude plan |
| Bring your own API key (one-time page, sealed per person, pasted keys removed from chat) | Covered by tests and a local stub provider; not yet run against a real provider |
| Invite-only beta admission | Covered by tests |
| Telegram and LINE adapters | Covered by tests with recorded fixtures; not yet live |
| Deployed on Cloudflare | Not yet |
| Booking, browsing, coding, group chats, calendar and other integrations | Not built |

## Try it locally with no accounts

You need Node 24.

```sh
cd app
npm ci
npm test                 # the Worker and Durable Object in the Workers runtime, no network
```

To chat on the local dev page without any model account, use the scripted backend, which answers from canned turns:

```sh
cd app
printf 'MODEL_BACKEND=scripted\nDEV_MODE=1\n' > .dev.vars
npx wrangler d1 execute giraffes-ledger --local --file src/ledger/d1-schema.sql
npx wrangler dev                                   # http://localhost:8787
curl -X POST http://localhost:8787/dev/script \
  -d '{"user":"alice","turns":[{"actions":[{"type":"send","text":"Hi! I am a scripted reply."}],"tasks":[],"about":""}]}'
```

Then open http://localhost:8787/dev, keep the user `alice`, and send a message. With your own Claude login, `app/README.md` shows how to run the dev page on a real model through the `claude` CLI bridge.

## How it is built

- `app/`: a Cloudflare Worker with one SQLite-backed Durable Object per person. It holds the person's queue, memory, wake-ups and outgoing messages, and enforces every limit in code. The model only proposes actions.
- `box/`: the per-person machine for people who bring a Claude plan. It runs the unmodified Claude Code CLI signed in to that person's plan, as an agent with Giraffe's tools and none of Claude Code's built-in tools.
- More detail: [`app/README.md`](app/README.md) (tests, local runs, deploy steps), [`box/README.md`](box/README.md) (the box), and the design notes in `app/docs/design/`.

## License

Giraffe's own code is licensed under the GNU Affero General Public License v3.0 (`LICENSE`).

Claude Code is a separate program from Anthropic under its own terms. Giraffe installs and drives it in the box; it is not part of this release, and any built box image contains it, so built images are not published.
