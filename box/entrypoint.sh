#!/bin/sh
# The volume at /data mounts owned by root, so the box starts as root only to hand the person's directories to agent.
set -eu
mkdir -p "$HOME" "$CLAUDE_CONFIG_DIR"
chown agent:agent "$HOME" "$CLAUDE_CONFIG_DIR"
chmod 700 "$HOME" "$CLAUDE_CONFIG_DIR"
exec setpriv --reuid=agent --regid=agent --init-groups --no-new-privs --inh-caps=-all --bounding-set=-all \
  node /opt/box/src/main.ts
