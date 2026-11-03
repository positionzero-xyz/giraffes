#!/usr/bin/env bash
# usage: app/scripts/launch.sh [--dry-run]
# Deploys the Worker with per-person boxes on Fly. Run it from Git Bash or any POSIX shell, logged in to
# nothing in particular: it opens the Cloudflare and Fly logins when they are needed. Secrets are read
# without echo or generated here, and go straight to `wrangler secret put` on stdin, never to a file.
# Re-running it is safe: every step checks what already exists.
set -euo pipefail
export MSYS_NO_PATHCONV=1

dry=0
[ "${1:-}" = "--dry-run" ] && dry=1
app=$(cd "$(dirname "$0")/.." && pwd)
repo=$(cd "$app/.." && pwd)
cd "$app"

say() { printf '\n== %s\n' "$*"; }
run() { if [ $dry = 1 ]; then printf '   would run: %s\n' "$*"; else "$@"; fi; }
ask() { local v; read -r -p "$1 [$2]: " v; printf '%s' "${v:-$2}"; }
ask_secret() { local v; read -r -s -p "$1 (input hidden, Enter to skip): " v; echo >&2; printf '%s' "$v"; }
random() { node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))'; }
put() {
  if [ $dry = 1 ]; then printf '   would set secret %s\n' "$1"; return; fi
  printf '%s' "$2" | npx wrangler secret put "$1" >/dev/null && printf '   set %s\n' "$1"
}
need() { command -v "$1" >/dev/null || { echo "$1 is not installed: $2" >&2; exit 1; }; }

need node "https://nodejs.org"
need docker "https://docs.docker.com/get-docker/"
need fly "https://fly.io/docs/flyctl/install/"
[ -d node_modules ] || run npm ci

say "Accounts"
if [ $dry = 0 ]; then
  npx wrangler whoami 2>/dev/null | grep -q "You are logged in" || npx wrangler login
  fly auth whoami >/dev/null 2>&1 || fly auth login
fi
org=$(ask "Fly organization slug" personal)
region=$(ask "Fly region for boxes" sin)
prefix=$(ask "Prefix for box app names (globally unique on Fly)" "gx$(node -e 'console.log(require("crypto").randomBytes(2).toString("hex"))')-")
max_boxes=$(ask "Most boxes to create in total" 20)

say "Ledger (D1)"
if grep -q '<set on first deploy>' wrangler.jsonc; then
  if [ $dry = 1 ]; then
    echo "   would create giraffes-ledger and write its id into wrangler.jsonc"
  else
    id=$(npx wrangler d1 create giraffes-ledger 2>&1 | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
    [ -n "$id" ] || { echo "could not read the new database id; create it by hand and put it in wrangler.jsonc" >&2; exit 1; }
    sed -i "s/<set on first deploy>/$id/" wrangler.jsonc
    echo "   created $id"
  fi
fi
run npx wrangler d1 execute giraffes-ledger --remote --file src/ledger/d1-schema.sql

say "Box image"
images="${prefix}images"
[ $dry = 1 ] || fly apps list --org "$org" 2>/dev/null | grep -q "^$images\b" || fly apps create "$images" --org "$org"
run fly auth docker
if [ $dry = 1 ]; then image="registry.fly.io/$images:<sha>"; echo "   would push $image"; else image=$("$repo/box/push.sh" "$images" | tail -1); fi
echo "   image $image"

say "Deploy"
if [ $dry = 1 ]; then url="https://giraffes.<you>.workers.dev"; echo "   would run: npx wrangler deploy"; else
  url=$(npx wrangler deploy 2>&1 | tee /dev/stderr | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1)
fi
echo "   worker $url"

say "Secrets"
key=$(ask_secret "Anthropic API key, used for people without a connected Claude plan and as fallback (required)")
[ -n "$key" ] || [ $dry = 1 ] || { echo "an Anthropic API key is required while MODEL_BACKEND=anthropic" >&2; exit 1; }
[ -n "$key" ] && put ANTHROPIC_API_KEY "$key"
box_secret=$(random)
if [ $dry = 1 ]; then fly_token="dry"; else fly_token=$(fly tokens create org --org "$org" --name giraffes-worker --expiry 8760h); fi
put FLY_API_TOKEN "$fly_token"
put BOX_SECRET "$box_secret"
put BOX_HOST fly
put FLY_ORG "$org"
put BOX_IMAGE "$image"
put BOX_REGION "$region"
put BOX_APP_PREFIX "$prefix"
put MAX_BOXES "$max_boxes"
put BILLING off
echo "   BOX_SECRET was generated and never shown. Changing it later orphans every box."

tg=$(ask_secret "Telegram bot token from @BotFather")
if [ -n "$tg" ]; then
  tg_secret=$(random)
  put TELEGRAM_BOT_TOKEN "$tg"
  put TELEGRAM_WEBHOOK_SECRET "$tg_secret"
  if [ $dry = 0 ]; then
    curl -fsS "https://api.telegram.org/bot$tg/setWebhook" --data-urlencode "url=$url/webhook/telegram" --data-urlencode "secret_token=$tg_secret" >/dev/null
    echo "   Telegram webhook points at $url/webhook/telegram"
  fi
fi
line_secret=$(ask_secret "LINE channel secret")
if [ -n "$line_secret" ]; then
  line_token=$(ask_secret "LINE channel access token")
  put LINE_CHANNEL_SECRET "$line_secret"
  put LINE_CHANNEL_ACCESS_TOKEN "$line_token"
  echo "   In the LINE console set the webhook to $url/webhook/line and turn on Webhook redelivery."
fi

say "Check one throwaway box on Fly (about a cent; it deletes itself)"
if [ "$(ask "Run it now? y/n" y)" = y ] && [ $dry = 0 ]; then
  FLY_API_TOKEN="$fly_token" FLY_ORG="$org" BOX_IMAGE="$image" BOX_SECRET="$box_secret" BOX_REGION="$region" BOX_APP_PREFIX="$prefix" \
    node scripts/fly-verify.ts --yes
fi

say "Done"
echo "   Text your bot /claude. You get a sign-in link to your own box; sign in with your Claude plan."
