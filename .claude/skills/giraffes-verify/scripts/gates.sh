#!/usr/bin/env bash
# usage: gates.sh <out-dir> <rev>...   one detached worktree per rev, one TSV row per rev
set -u
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CHECKOUT=$(git -C "$HERE" rev-parse --show-toplevel)
REPO=$(cd "$(git -C "$HERE" rev-parse --path-format=absolute --git-common-dir)/.." && pwd)
CHECK="$CHECKOUT/.githooks/check-private.mjs"
mkdir -p "$1" && OUT=$(cd "$1" && pwd); shift
TSV="$OUT/gates.tsv"
[ -f "$TSV" ] || printf 'rev\tsha\ttypecheck\tapp_tests\tbox_tests\tleak_check\n' > "$TSV"

count() { grep -Eo "$2" "$1" | tail -1 | grep -Eo '[0-9]+' | head -1; }
winrepo=$(cygpath -w "$REPO")

for rev in "$@"; do
  sha=$(git -C "$REPO" rev-parse --short "$rev")
  name=$(echo "$rev" | tr '/' '-')
  wt="$OUT/wt/$name"
  log="$OUT/$name"
  for d in app box; do
    if [ -e "$wt/$d/node_modules" ]; then
      powershell -NoProfile -Command "[System.IO.Directory]::Delete('$(cygpath -w "$wt")\\$d\\node_modules', \$false)"
    fi
  done
  git -C "$REPO" worktree remove --force "$wt" 2>/dev/null
  git -C "$REPO" worktree add --detach "$wt" "$sha" >/dev/null 2>&1 || { printf '%s\t%s\tWORKTREE_FAIL\t\t\t\n' "$rev" "$sha" >> "$TSV"; continue; }
  winwt=$(cygpath -w "$wt")
  powershell -NoProfile -Command "New-Item -ItemType Junction -Path '$winwt\\app\\node_modules' -Target '$winrepo\\app\\node_modules' | Out-Null"
  [ -d "$wt/app/node_modules/vitest" ] || { printf '%s\t%s\tNO_NODE_MODULES\t\t\t\n' "$rev" "$sha" >> "$TSV"; continue; }
  if [ -d "$wt/box" ] && [ -d "$REPO/box/node_modules" ]; then
    powershell -NoProfile -Command "New-Item -ItemType Junction -Path '$winwt\\box\\node_modules' -Target '$winrepo\\box\\node_modules' | Out-Null"
  fi

  (cd "$wt/app" && npx tsc --noEmit > "$log.tsc.log" 2>&1); tc=$?
  (cd "$wt/app" && npx vitest run > "$log.vitest.log" 2>&1); vt=$?
  passed=$(count "$log.vitest.log" 'Tests +[0-9]+ passed'); failed=$(count "$log.vitest.log" '[0-9]+ failed')
  if [ "$vt" = 0 ] && [ "${passed:-0}" -gt 0 ]; then app="PASS ${passed}"; else app="FAIL exit=$vt passed=${passed:-0} failed=${failed:-?}"; fi

  if [ -d "$wt/box/test" ]; then
    (cd "$wt/box" && npm test > "$log.box.log" 2>&1); bt=$?
    bp=$(count "$log.box.log" '^(# |ℹ )pass [0-9]+')
    if [ "$bt" = 0 ] && [ "${bp:-0}" -gt 0 ]; then box="PASS ${bp}"; else box="FAIL exit=$bt pass=${bp:-0}"; fi
  else box="n/a"; fi

  printf 'C:%sUsers%sx%sy\n' / / / | (cd "$wt" && node "$CHECK" stdin) >/dev/null 2>&1; ctl=$?
  (cd "$wt" && node "$CHECK" tree > "$log.leak.log" 2>&1); lk=$?
  if [ "$ctl" != 1 ]; then leak="CONTROL_FAIL"; elif [ "$lk" = 0 ]; then leak="PASS"; else leak="FAIL see $name.leak.log"; fi

  [ "$tc" = 0 ] && tcs=PASS || tcs="FAIL exit=$tc"
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$rev" "$sha" "$tcs" "$app" "$box" "$leak" >> "$TSV"

  powershell -NoProfile -Command "[System.IO.Directory]::Delete('$winwt\\app\\node_modules', \$false)"
  [ -e "$wt/box/node_modules" ] && powershell -NoProfile -Command "[System.IO.Directory]::Delete('$winwt\\box\\node_modules', \$false)"
  git -C "$REPO" worktree remove --force "$wt" >/dev/null 2>&1
done
[ -d "$REPO/app/node_modules/vitest" ] && [ -d "$REPO/box/node_modules/@anthropic-ai/claude-code" ] && echo "main node_modules intact" || echo "WARNING: main node_modules missing"
cat "$TSV"
! tail -n "$#" "$TSV" | grep -qE 'FAIL|WORKTREE_FAIL|NO_NODE_MODULES'
