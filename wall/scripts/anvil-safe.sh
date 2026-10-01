#!/bin/sh
# Runs anvil so a test chain can never fill the disk: pruned history, a private HOME (anvil keeps its
# state dir there) deleted on exit, and a watchdog that stops anvil once the process that started it is gone.
# Usage: anvil-safe.sh [anvil args...]
PARENT="${AGATE_ANVIL_PARENT:-$PPID}"
H=$(mktemp -d -t agate-anvil) || exit 1
HOME="$H" anvil --prune-history "$@" &
A=$!
cleanup() {
  kill "$A" 2>/dev/null
  wait "$A" 2>/dev/null
  case "$H" in */agate-anvil.*) rm -rf "$H" ;; esac
}
trap cleanup EXIT
trap 'exit 143' INT TERM HUP
while kill -0 "$A" 2>/dev/null && kill -0 "$PARENT" 2>/dev/null; do sleep 1; done
