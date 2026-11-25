#!/bin/sh
set -eu
sh /opt/box/lockdown.sh
exec setpriv --reuid=agent --regid=agent --init-groups --no-new-privs --inh-caps=-all --bounding-set=-all \
  node /opt/box/src/main.ts
