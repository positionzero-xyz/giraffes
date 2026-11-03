# Launch the beta

This puts the Worker live with per-person boxes on Fly in Singapore. Billing stays off, so everyone is on the free beta.

## What you need first

| Account | Why | What the script asks for |
|---|---|---|
| Cloudflare | runs the Worker, Durable Objects and the D1 ledger | a browser login (`wrangler login`) |
| Fly.io, with a card on the org | one box per person | a browser login (`fly auth login`); the script creates the org token itself |
| Anthropic Console | the API key for people who haven't connected a Claude plan, and the fallback when a box is down | `ANTHROPIC_API_KEY` |
| Telegram | the chat channel | the bot token from @BotFather |
| LINE (optional) | the second channel | channel secret and access token |

You also need Node 24, Docker running, and `fly` installed.

## Run it

```bash
bash app/scripts/launch.sh --dry-run
```

```bash
bash app/scripts/launch.sh
```

It logs you in where needed, creates the ledger, builds and pushes the box image to Fly's registry, deploys the Worker, and sets every secret. It generates `BOX_SECRET` and the Telegram webhook secret itself and never prints them. Changing `BOX_SECRET` later orphans every box. At the end it offers to provision one throwaway box on Fly and delete it, which proves the Fly path for about a cent.

## Then

1. Text your bot `/claude`. A box is created for you, and a sign-in link arrives within a minute or two.
2. Open the link on your phone, tap **Open sign-in page**, sign in to Claude, copy the code, paste it, and tap **Connect**.
3. The bot says your plan is connected. Your next message runs on your own Claude plan in your box.

People who don't send `/claude` stay on the API key, with the usual monthly cap.

## Knobs

- `MAX_BOXES` (the script asks; default 20) caps boxes across everyone.
- `BOX_VOLUME_GB` (default 5) sizes each person's disk.
- Plans and Stripe: see `docs/design/BOX.md`, "Plans and billing". `BILLING=off` until you are ready to charge.
- To remove a person's box and data: `fly apps destroy <name>`. Their name is in the D1 table `boxes`.
