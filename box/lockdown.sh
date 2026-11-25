#!/bin/sh
# The volume at /data mounts owned by root, so the box starts as root only to hand the person's directories to agent.
set -eu
mkdir -p "$HOME" "$CLAUDE_CONFIG_DIR" "$BOX_STATE_DIR"
chown agent:agent "$HOME" "$CLAUDE_CONFIG_DIR" "$BOX_STATE_DIR"
chmod 700 "$HOME" "$CLAUDE_CONFIG_DIR" "$BOX_STATE_DIR"
writable() {
  setpriv --reuid=agent --regid=agent --init-groups \
    find / \( -path /proc -o -path /sys -o -path /tmp -o -path "$HOME" -o -path "$CLAUDE_CONFIG_DIR" -o -path "$BOX_STATE_DIR" \) -prune \
    -o \( -type d -o -type f \) -writable -print 2>/dev/null || true
}
writable | while IFS= read -r path; do chmod go-w "$path"; done
left=$(writable)
if [ -n "$left" ]; then
  echo "agent can still write outside the folders an erase empties: $left" >&2
  exit 1
fi
