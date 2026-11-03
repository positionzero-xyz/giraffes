#!/bin/sh
echo "$(date +%s%3N)" >> "$BENCH_LAUNCH_LOG"
if [ "$BENCH_KEEP_TOOLS" = 1 ]; then
  for arg; do
    shift
    if [ "$skip" = 1 ]; then skip=; continue; fi
    if [ "$arg" = "--tools" ]; then skip=1; continue; fi
    set -- "$@" "$arg"
  done
fi
exec /usr/local/bin/claude "$@"
