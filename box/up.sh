#!/usr/bin/env bash
# usage: box/up.sh <name> <host-port> <work-dir>
# Starts the box with a fake model: the mock Messages API runs inside it and every Anthropic host resolves to loopback.
set -euo pipefail
export MSYS_NO_PATHCONV=1
name=$1 port=$2 work=$3
here=$(cd "$(dirname "$0")" && pwd -W 2>/dev/null || pwd)
mkdir -p "$work/dump"
# Docker's default seccomp profile blocks the user namespaces Chromium's sandbox needs; the alternative is --no-sandbox.
docker run -d --name "$name" --init --shm-size=1g --security-opt seccomp=unconfined \
  -p "127.0.0.1:$port:8789" \
  -v "$here:/box:ro" -v "$work:/work" \
  -e ANTHROPIC_BASE_URL=http://127.0.0.1:8788 \
  -e ANTHROPIC_API_KEY=sk-ant-FAKE-spike-not-a-real-key \
  --add-host api.anthropic.com:127.0.0.1 --add-host statsig.anthropic.com:127.0.0.1 \
  --add-host console.anthropic.com:127.0.0.1 --add-host claude.ai:127.0.0.1 \
  --add-host mcp-proxy.anthropic.com:127.0.0.1 --add-host platform.claude.com:127.0.0.1 \
  giraffes-box:spike
docker exec -d -u root "$name" node /box/mock-api.mjs /work/mock.log 8788 /work/dump
for _ in $(seq 1 20); do
  docker logs "$name" 2>&1 | grep -q "claude bridge on" && break
  sleep 0.5
done
docker logs "$name"
