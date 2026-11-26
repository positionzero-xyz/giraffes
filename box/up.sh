#!/usr/bin/env bash
# usage: BOX_TOKEN=<token> box/up.sh <name> <host-port> <data-dir> [--mock [script-file]]
# Runs the box image (BOX_IMAGE, default giraffes-box:mvp) on 127.0.0.1:<host-port> with the person's state in <data-dir>.
# --mock signs the CLI in with a fake API key against box/mock-api.mjs running inside the box, with every Anthropic host resolved to loopback.
# With --mock, a script file can make the mock call Giraffe tools; MOCK_DUMPS=<host-dir> keeps each raw request the mock gets as a file there.
set -euo pipefail
export MSYS_NO_PATHCONV=1
name=$1 port=$2 data=$3 mode=${4:-} script=${5:-}
: "${BOX_TOKEN:?set BOX_TOKEN}"
here=$(cd "$(dirname "$0")" && { pwd -W 2>/dev/null || pwd; })
mkdir -p "$data"
data=$(cd "$data" && { pwd -W 2>/dev/null || pwd; })
mock=()
dumps=""
script_in_box=""
if [ "$mode" != --mock ] && [ -n "$script" ]; then
  echo "a mock script needs --mock" >&2
  exit 2
fi
if [ "$mode" = --mock ] && [ -n "$script" ]; then
  [ -f "$script" ] || { echo "mock script not found: $script" >&2; exit 1; }
  script_dir=$(cd "$(dirname "$script")" && { pwd -W 2>/dev/null || pwd; })
  mock+=(-v "$script_dir/$(basename "$script"):/mock-script.json:ro")
  script_in_box=/mock-script.json
fi
if [ "$mode" = --mock ] && [ -n "${MOCK_DUMPS:-}" ]; then
  mkdir -p "$MOCK_DUMPS"
  mock+=(-v "$(cd "$MOCK_DUMPS" && { pwd -W 2>/dev/null || pwd; }):/dumps")
  dumps=/dumps
  # An explicit script file wins; otherwise the rewritable default lives in the dumps mount.
  [ -z "$script_in_box" ] && script_in_box=/dumps/mock-script.json
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
