#!/usr/bin/env bash
# usage: gates.sh <out-dir> <rev>...   one detached worktree per rev, one TSV row per rev
set -u
export MSYS_NO_PATHCONV=1
HERE=$(cygpath -m "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)")
if [ "$#" -lt 2 ]; then
  echo "usage: gates.sh <out-dir> <rev>..." >&2
  exit 2
fi
CHECKOUT=$(git -C "$HERE" rev-parse --show-toplevel)
REPO=$(cygpath -m "$(cd "$(git -C "$HERE" rev-parse --path-format=absolute --git-common-dir)/.." && pwd)")
CHECK="$CHECKOUT/.githooks/check-private.mjs"
mkdir -p "$1" && OUT=$(cygpath -m "$(cd "$1" && pwd)"); shift
TSV="$OUT/gates.tsv"
[ -f "$TSV" ] || printf 'rev\tsha\ttypecheck\tapp_tests\tbox_tests\tlinux_box\tleak_check\n' > "$TSV"

count() { grep -Eo "$2" "$1" | tail -1 | grep -Eo '[0-9]+' | head -1; }
winrepo=$(cygpath -w "$REPO")

# The clone's private patterns stay untracked; the gate adds the research-note rule itself so a fresh clone
# cannot silently narrow it back to the old A-K range.
PATTERNS="$OUT/private-patterns"
[ -f "$REPO/.git/info/private-patterns" ] && cp "$REPO/.git/info/private-patterns" "$PATTERNS" || : > "$PATTERNS"
grep -qxF 'research/[A-Z]-' "$PATTERNS" || printf 'research/[A-Z]-\n' >> "$PATTERNS"
export PRIVATE_PATTERNS_FILE="$PATTERNS"

for rev in "$@"; do
  sha=$(git -C "$CHECKOUT" rev-parse --short "$rev")
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
  boxdeps=missing
  if [ -d "$wt/box" ]; then
    if [ -d "$REPO/box/node_modules" ]; then
      powershell -NoProfile -Command "New-Item -ItemType Junction -Path '$winwt\\box\\node_modules' -Target '$winrepo\\box\\node_modules' | Out-Null"
      boxdeps=junction
    else
      (cd "$wt/box" && npm ci > "$log.box-install.log" 2>&1)
      boxdeps=installed
    fi
  fi

  (cd "$wt/app" && npx tsc --noEmit > "$log.tsc.log" 2>&1); tc=$?
  (cd "$wt/app" && npx vitest run > "$log.vitest.log" 2>&1); vt=$?
  passed=$(count "$log.vitest.log" 'Tests +[0-9]+ passed'); failed=$(count "$log.vitest.log" '[0-9]+ failed')
  if [ "$vt" = 0 ] && [ "${passed:-0}" -gt 0 ]; then app="PASS ${passed}"; else app="FAIL exit=$vt passed=${passed:-0} failed=${failed:-?}"; fi

  if [ -d "$wt/box/test" ]; then
    if [ ! -d "$wt/box/node_modules/@anthropic-ai/claude-code" ]; then
      box="FAIL deps=$boxdeps"
    else
      (cd "$wt/box" && npm test > "$log.box.log" 2>&1); bt=$?
      bp=$(count "$log.box.log" '^(# |ℹ )pass [0-9]+')
      bs=$(count "$log.box.log" '^(# |ℹ )skipped [0-9]+')
      if [ "$bt" != 0 ]; then box="FAIL exit=$bt pass=${bp:-0} skipped=${bs:-0}"
      elif [ "${bs:-0}" -gt 0 ]; then box="SKIP pass=${bp:-0} skipped=$bs"
      elif [ "${bp:-0}" -gt 0 ]; then box="PASS ${bp}"
      else box="FAIL exit=$bt pass=${bp:-0} skipped=${bs:-0}"; fi
    fi
  else box="n/a"; fi

  # Linux box gate: build the revision's own image, then run the whole box suite inside it against
  # the image's Linux CLI, plus the image hardening check. A skip inside the container is a failure here.
  lbox="n/a"
  if [ -d "$wt/box/test" ] && [ -f "$wt/box/Dockerfile" ]; then
    img="giraffes-box-gate-$sha"
    stage="$OUT/linux-stage-$name"
    rm -rf "$stage"
    mkdir -p "$stage"
    cp -r "$wt/box/src" "$stage/src" && cp -r "$wt/box/test" "$stage/test" && cp "$wt/box/mock-api.mjs" "$stage/mock-api.mjs"
    if ! docker info >/dev/null 2>&1; then
      lbox="FAIL docker unavailable"
    elif ! docker build -q -t "$img" "$(cygpath -w "$wt/box")" > "$log.dockerbuild.log" 2>&1; then
      lbox="FAIL docker build"
    else
      docker run --rm -v "$(cygpath -m "$stage"):/boxtest:ro" \
        -e BOX_TEST_CLI=/opt/box/node_modules/@anthropic-ai/claude-code/bin/claude.exe \
        "$img" sh -c 'cd /boxtest && node --test test/*.test.ts' > "$log.linuxbox.log" 2>&1; lb=$?
      lbp=$(count "$log.linuxbox.log" '^(# |ℹ )pass [0-9]+')
      lbs=$(count "$log.linuxbox.log" '^(# |ℹ )skipped [0-9]+')
      lskiplines=$(grep -c '^﹣' "$log.linuxbox.log" || true)
      if [ -f "$wt/box/test/image.sh" ]; then sh "$wt/box/test/image.sh" "$img" > "$log.image.log" 2>&1; im=$?; else im=0; fi
      if [ "$lb" != 0 ]; then lbox="FAIL exit=$lb pass=${lbp:-0}"
      elif [ "${lbs:-0}" -gt 0 ] || [ "${lskiplines:-0}" -gt 0 ]; then lbox="SKIP pass=${lbp:-0} skipped=$lskiplines"
      elif [ "${lbp:-0}" -eq 0 ]; then lbox="FAIL zero tests"
      elif [ "$im" != 0 ]; then lbox="FAIL image.sh exit=$im"
      else lbox="PASS ${lbp}"; fi
      docker rmi "$img" >/dev/null 2>&1
    fi
    rm -rf "$stage"
  fi

  control_note="research/$(printf 'Z')-note"
  printf 'see %s\n' "$control_note" | (cd "$wt" && node "$CHECK" stdin) >/dev/null 2>&1; ctl=$?
  (cd "$wt" && node "$CHECK" tree > "$log.leak.log" 2>&1); lk=$?
  if [ "$ctl" != 1 ]; then leak="CONTROL_FAIL"; elif [ "$lk" = 0 ]; then leak="PASS"; else leak="FAIL see $name.leak.log"; fi

  [ "$tc" = 0 ] && tcs=PASS || tcs="FAIL exit=$tc"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$rev" "$sha" "$tcs" "$app" "$box" "$lbox" "$leak" >> "$TSV"

  powershell -NoProfile -Command "[System.IO.Directory]::Delete('$winwt\\app\\node_modules', \$false)"
  [ -e "$wt/box/node_modules" ] && powershell -NoProfile -Command "[System.IO.Directory]::Delete('$winwt\\box\\node_modules', \$false)"
  git -C "$REPO" worktree remove --force "$wt" >/dev/null 2>&1
done
[ -d "$REPO/app/node_modules/vitest" ] && [ -d "$REPO/box/node_modules/@anthropic-ai/claude-code" ] && echo "main node_modules intact" || echo "WARNING: main node_modules missing"
cat "$TSV"
! tail -n "$#" "$TSV" | grep -qE 'FAIL|WORKTREE_FAIL|NO_NODE_MODULES|SKIP'
