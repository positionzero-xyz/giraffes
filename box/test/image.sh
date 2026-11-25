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
  if [ -n "$(ls -A /tmp)$(ls -A /var/tmp)" ]; then
    echo "expected /tmp and /var/tmp to be empty: an erase, running as agent, must be able to empty /tmp" >&2
    exit 1
  fi
  sh /opt/box/lockdown.sh
  as_agent() { setpriv --reuid=agent --regid=agent --init-groups sh -c "$1"; }
  for d in /var/tmp /var/lock /run/lock /dev/shm /dev/mqueue /data; do
    if as_agent "touch $d/probe" 2>/dev/null; then
      echo "expected agent unable to write $d, where an erase doesn't reach" >&2
      exit 1
    fi
  done
  for d in /tmp "$HOME" "$CLAUDE_CONFIG_DIR" "$BOX_STATE_DIR"; do as_agent "touch $d/probe && rm $d/probe"; done
  claude --version
SH
