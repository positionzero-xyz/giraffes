#!/bin/sh
set -eu

docker run --rm -i --network none --entrypoint sh "${1:?pass the box image tag}" -e <<'SH'
  version=$(dpkg-query -W apt | cut -f2)
  printf "apt %s\n" "$version"
  dpkg --compare-versions "$version" ge 2.6.2 || { echo "expected apt >= 2.6.2" >&2; exit 1; }
  if command -v npm || command -v npx; then
    echo "expected npm and npx to be absent" >&2
    exit 1
  fi
  claude --version
SH
