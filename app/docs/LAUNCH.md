# Launch the beta

This puts the Worker live with per-person boxes on Fly in Singapore. Billing stays off, so everyone is on the free beta. We hold no model key: each person brings their own AI, either their Claude plan in their own box or their own API key.

## What you need first

| Account | Why | What the script asks for |
|---|---|---|
| Cloudflare | runs the Worker, Durable Objects and the D1 ledger | a browser login (`wrangler login`) |
| Fly.io, with a card on the org | one box per person | a browser login (`fly auth login`); the script creates the org token itself |
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

It logs you in where needed, creates the ledger, builds and pushes the box image to Fly's registry, deploys the Worker, and sets every secret. It generates `BOX_SECRET`, `KEY_SECRET` and the Telegram webhook secret itself and never prints them, and sets `PUBLIC_URL` to the Worker's URL, where the key page lives. Changing `BOX_SECRET` later orphans every box. The Worker won't start without `KEY_SECRET`. Rotate it as below; changing it any other way makes every saved key unreadable until the old secret is configured again. At the end it offers to provision one throwaway box on Fly and delete it, which proves the Fly path for about a cent.

Run it again whenever you like: it keeps every generated secret, and its dry run prints the same thing twice.

## Then

Text your bot. With no AI connected, it answers with a short code-written message offering two ways in, and no model is called. Each person picks one:

- **Their Claude plan.** `/claude` creates a box, and a sign-in link arrives within a minute or two. They open it on their phone, tap **Open sign-in page**, sign in to Claude, copy the code, paste it and tap **Connect**. The bot says the plan is connected, and their messages then run on their own Claude plan in their box.
- **Their own API key.** `/key` sends a link to a one-time page, valid for 15 minutes. They pick a provider (OpenCode Go, Anthropic, OpenRouter, DeepInfra, Alibaba Model Studio, Mistral, or any Anthropic- or OpenAI-compatible endpoint), paste the key and tap **Connect**. One tiny call checks it, the key is encrypted and kept only in their own Durable Object, and the chat says it is connected. `/key` later shows the key's month against its limit (default $5, `/key cap <dollars>` to change), and `/key remove` deletes it. A key pasted into the chat is removed before it is stored, and the person is told to revoke it.

Someone with both is asked once whether the key may back up their Claude plan. Until they say yes, a box that can't answer never spends their key's money. Reminders a person asked for still arrive as code-written text whatever their access.

## Knobs

- `MAX_BOXES` (the script asks; default 20) caps boxes across everyone.
- `OWN_KEY_CAP_USD` (default 5) is the monthly limit a new key starts with; each person changes theirs with `/key cap`.
- `INCLUDED` stays `off`. Turning on our own quota for a paid plan is configuration (see the README), not a code change.
- `BOX_VOLUME_GB` (default 5) sizes each person's disk.
- Plans and Stripe: see `docs/design/BOX.md`, "Plans and billing". `BILLING=off` until you are ready to charge.
- To remove a person's box and data: `fly apps destroy <name>`. Their name is in the D1 table `boxes`.

## Rotating KEY_SECRET

Every key people save is sealed under `KEY_SECRET`, and each sealed key records a short fingerprint of the secret that sealed it.

1. `npx wrangler secret put KEY_SECRET_PREVIOUS` with the current value.
2. `npx wrangler secret put KEY_SECRET` with a new value of 32 or more random characters.
3. Each key opens with the previous secret on its next use and is resealed with the new one in the same step. Leave `KEY_SECRET_PREVIOUS` set until every person has used their assistant at least once; a key nobody used since is still sealed with the old secret.
4. `npx wrangler secret delete KEY_SECRET_PREVIOUS`.

If a key won't open (the secret was changed without step 1, or deleted), it is marked unreadable together with the fingerprint of the secrets configured at that moment, and the person is told once a day to enter it again. Configure the right secret again, as `KEY_SECRET` or as `KEY_SECRET_PREVIOUS`, and every such key is tried again on its next use, because the configured fingerprint changed.

## Before you turn billing on

In the Stripe dashboard, under **Billing** > **Revenue recovery** > **Retries**, keep the retry window at 2 weeks (the default for new accounts) and set what happens after the retries fail to **Cancel the subscription**. A failed renewal leaves the subscription `past_due` while Stripe retries. The Worker keeps the plan for 14 days from the first `past_due` it sees and then treats the person as lapsed, but the subscription stays open in Stripe until it is cancelled. Cancelling after the retries ends it there too, so the person isn't billed again for a plan they no longer get, and a later `/plan` offers them Checkout cleanly.

Run `scripts/stripe-setup.ts` (see the README) and set `STRIPE_PORTAL_CONFIGURATION` with the other values it prints. People who already pay get a portal link from `/plan` to change or cancel, and the portal needs that configuration.

If someone pays twice, nothing is refunded automatically. Check `SELECT * FROM billing_duplicate` in the ledger, and cancel and refund the extra subscription in the Stripe dashboard.
