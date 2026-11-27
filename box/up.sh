#!/usr/bin/env bash
# usage: BOX_TOKEN=<token> box/up.sh <name> <host-port> <data-dir> [--mock [--script <script-file>]]
# Runs the box image (BOX_IMAGE, default giraffes-box:mvp) on 127.0.0.1:<host-port> with the person's state in <data-dir>.
# --mock signs the CLI in with a fake API key against box/mock-api.mjs running inside the box, with every Anthropic host resolved to loopback.
# --script seeds the mock's mock-script.json in a dump folder it creates when needed. Replace that copy, not the seed,
# while the box runs. MOCK_DUMPS=<host-dir> chooses the folder and saves raw requests there.
set -euo pipefail
export MSYS_NO_PATHCONV=1
name=$1 port=$2 data=$3
shift 3
mode=""
script=""
while [ $# -gt 0 ]; do
  case "$1" in
    --mock)
      mode=--mock
      ;;
    --script)
      shift
      [ $# -gt 0 ] || { echo "--script needs a file" >&2; exit 2; }
      [ -z "$script" ] || { echo "only one mock script" >&2; exit 2; }
      script=$1
      ;;
    --*)
      echo "unknown option: $1" >&2
      exit 2
      ;;
    *)
      [ -z "$script" ] || { echo "only one mock script" >&2; exit 2; }
      script=$1
      ;;
  esac
  shift
done
: "${BOX_TOKEN:?set BOX_TOKEN}"
here=$(cd "$(dirname "$0")" && { pwd -W 2>/dev/null || pwd; })
mkdir -p "$data"
data=$(cd "$data" && { pwd -W 2>/dev/null || pwd; })
mock=()
dumps=""
script_in_box=""
dump_host=${MOCK_DUMPS:-}
if [ "$mode" != --mock ] && [ -n "$script" ]; then
  echo "a mock script needs --mock" >&2
  exit 2
fi
if [ "$mode" = --mock ] && [ -n "$script" ]; then
  [ -f "$script" ] || { echo "mock script not found: $script" >&2; exit 1; }
  if [ -z "$dump_host" ]; then dump_host=$(mktemp -d); fi
  mkdir -p "$dump_host"
  if ! cmp -s "$script" "$dump_host/mock-script.json" 2>/dev/null; then cp "$script" "$dump_host/mock-script.json"; fi
fi
if [ "$mode" = --mock ] && [ -n "$dump_host" ]; then
  mkdir -p "$dump_host"
  mock+=(-v "$(cd "$dump_host" && { pwd -W 2>/dev/null || pwd; }):/dumps")
  dumps=/dumps
  script_in_box=/dumps/mock-script.json
fi
if [ "$mode" = --mock ]; then
  mock+=(-v "$here:/box:ro"
    -e ANTHROPIC_BASE_URL=http://127.0.0.1:8788
    -e ANTHROPIC_API_KEY=sk-ant-FAKE-mock-not-a-real-key
    --add-host api.anthropic.com:127.0.0.1 --add-host statsig.anthropic.com:127.0.0.1
    --add-host console.anthropic.com:127.0.0.1 --add-host mcp-proxy.anthropic.com:127.0.0.1
    --add-host claude.ai:127.0.0.1 --add-host claude.com:127.0.0.1 --add-host platform.claude.com:127.0.0.1)
fi
docker run -d --name "$name" --init -p "127.0.0.1:$port:8789" -v "$data:/data" -e BOX_TOKEN "${mock[@]}" "${BOX_IMAGE:-giraffes-box:mvp}"
if [ "$mode" = --mock ]; then
  if [ -n "$dumps" ]; then
    # lockdown.sh takes agent's write access to the dumps mount, so the mock writes there as root.
    docker exec -d "$name" node /box/mock-api.mjs /dumps/mock.log 8788 "$dumps" "$script_in_box"
  else
    docker exec -d -u agent "$name" node /box/mock-api.mjs /tmp/mock.log 8788 "" "$script_in_box"
  fi
fi
for _ in $(seq 1 40); do
  docker logs "$name" 2>&1 | grep -q "box on" && break
  sleep 0.25
done
docker logs "$name"
