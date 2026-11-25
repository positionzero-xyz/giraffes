#!/usr/bin/env bash
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
ask_required() { local v=""; while [ -z "$v" ]; do read -r -p "$1: " v; done; printf '%s' "$v"; }
ask_secret() { local v; read -r -s -p "$1 (input hidden, Enter to skip): " v; echo >&2; printf '%s' "$v"; }
random() { node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))'; }
put() {
  if [ $dry = 1 ]; then printf '   would set secret %s\n' "$1"; return; fi
  printf '%s' "$2" | npx wrangler secret put "$1" >/dev/null && printf '   set %s\n' "$1"
}
has() { printf '%s' "$existing" | grep -q "\"name\": *\"$1\""; }
put_once() { if has "$1"; then printf '   kept %s\n' "$1"; else put "$1" "$2"; fi; }
privacy_secrets() {
  if has PRIVACY_CONTROLLER; then echo "   kept PRIVACY_CONTROLLER"; else put PRIVACY_CONTROLLER "$(ask_required "Operator's legal name and address, shown on the privacy notice")"; fi
  if has PRIVACY_CONTACT; then echo "   kept PRIVACY_CONTACT"; else put PRIVACY_CONTACT "$(ask_required "Email for privacy requests, shown on the privacy notice")"; fi
}
need() { command -v "$1" >/dev/null || { echo "$1 is not installed: $2" >&2; exit 1; }; }

need node "https://nodejs.org"
need docker "https://docs.docker.com/get-docker/"
need fly "https://fly.io/docs/flyctl/install/"
if [ $dry = 1 ]; then
  # Any call that slips past run() or a dry check hits these instead of a real account.
  shims=$(mktemp -d)
  trap 'rm -rf "$shims"' EXIT
  for c in fly flyctl npx npm wrangler docker curl stripe; do
    printf '#!/usr/bin/env bash\necho "dry run refused to run: %s $*" >&2\nexit 97\n' "$c" > "$shims/$c"
    chmod +x "$shims/$c"
  done
  PATH="$shims:$PATH"
fi
[ -d node_modules ] || run npm ci

say "Accounts"
if [ $dry = 0 ]; then
  npx wrangler whoami 2>/dev/null | grep -q "You are logged in" || npx wrangler login
  fly auth whoami >/dev/null 2>&1 || fly auth login
fi
if [ -f .launch.env ]; then
  . ./.launch.env
  echo "   using org $org, region $region, prefix $prefix from app/.launch.env"
else
  org=$(ask "Fly organization slug" personal)
  region=$(ask "Fly region for boxes" sin)
  if [ $dry = 1 ]; then suggested="gx<random>-"; else suggested="gx$(node -e 'console.log(require("crypto").randomBytes(2).toString("hex"))')-"; fi
  prefix=$(ask "Prefix for box app names (globally unique on Fly; never change it later)" "$suggested")
  max_boxes=$(ask "Most boxes to create in total" 20)
  [ $dry = 1 ] || printf 'org=%s\nregion=%s\nprefix=%s\nmax_boxes=%s\n' "$org" "$region" "$prefix" "$max_boxes" > .launch.env
fi

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

if [ $dry = 0 ] && existing=$(npx wrangler secret list 2>/dev/null); then
  say "Privacy notice (set before deploying, since this version won't start without it)"
  privacy_secrets
fi

say "Deploy"
if [ $dry = 1 ]; then url="https://giraffes.<you>.workers.dev"; echo "   would run: npx wrangler deploy"; else
  url=$(npx wrangler deploy 2>&1 | tee /dev/stderr | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1)
fi
echo "   worker $url"

say "Secrets"
if [ $dry = 1 ]; then existing="[]"; else existing=$(npx wrangler secret list 2>/dev/null || echo "[]"); fi
put_once KEY_SECRET "$(random)"
put PUBLIC_URL "$url"
privacy_secrets
if has FLY_API_TOKEN || [ $dry = 1 ]; then put_once FLY_API_TOKEN dry; else put FLY_API_TOKEN "$(fly tokens create org --org "$org" --name giraffes-worker --expiry 8760h)"; fi
put_once BOX_SECRET "$(random)"
put_once BOX_HOST fly
put_once FLY_ORG "$org"
put BOX_IMAGE "$image"
put_once BOX_REGION "$region"
put_once BOX_APP_PREFIX "$prefix"
put_once MAX_BOXES "$max_boxes"
put_once BILLING off
echo "   BOX_SECRET is generated once and never shown. Changing it orphans every box, so this script never does."
echo "   KEY_SECRET seals every API key people save. It is generated once and never shown, and this script never changes it."

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
  FLY_API_TOKEN="$(fly tokens create org --org "$org" --name giraffes-verify --expiry 1h)" FLY_ORG="$org" BOX_IMAGE="$image" BOX_SECRET="$(random)" BOX_REGION="$region" BOX_APP_PREFIX="$prefix" \
    node scripts/fly-verify.ts --yes
fi

say "Done"
echo "   Text your bot. With no AI connected it offers /claude, to sign in with a Claude plan in your own box,"
echo "   and /key, to add your own API key (such as OpenCode Go) on a one-time page."
