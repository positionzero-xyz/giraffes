#!/usr/bin/env bash
# usage: box/push.sh <fly-app>
# Builds the box for Fly's amd64 machines and pushes registry.fly.io/<fly-app>:<git short sha>.
# Log docker in to registry.fly.io first.
set -euo pipefail
export MSYS_NO_PATHCONV=1
app=$1
here=$(cd "$(dirname "$0")" && { pwd -W 2>/dev/null || pwd; })
if [ -n "$(git -C "$here" status --porcelain -- .)" ]; then
  echo "box/ has uncommitted changes; commit them so the tag names what is in the image" >&2
  exit 1
fi
image="registry.fly.io/$app:$(git -C "$here" rev-parse --short HEAD)"
docker build --platform linux/amd64 -t "$image" "$here"
for attempt in 1 2 3; do
  if docker push "$image"; then
    break
  else
    status=$?
  fi
  if [ "$attempt" = 3 ]; then
    exit "$status"
  fi
  echo "docker push failed (attempt $attempt of 3); retrying in 10 seconds" >&2
  sleep 10
done
echo "$image"
