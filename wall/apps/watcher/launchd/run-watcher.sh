#!/bin/sh
# Starts one watcher role. attest and keep read their key from AGATE_KEY_CMD at start (never stored by this script).
set -eu
ROLE="${1:?usage: run-watcher.sh <log|attest|keep|health>}"
case "$ROLE" in
  attest) VAR=AGATE_ATTESTER_KEY ;;
  keep) VAR=AGATE_KEEPER_KEY ;;
  log|health) VAR="" ;;
  *) echo "unknown role $ROLE" >&2; exit 2 ;;
esac
if [ -n "$VAR" ]; then
  : "${AGATE_KEY_CMD:?set AGATE_KEY_CMD to a command that prints the $ROLE key}"
  KEY="$(/bin/sh -c "$AGATE_KEY_CMD")"
  export "$VAR=$KEY"
  unset KEY
fi
unset AGATE_KEY_CMD
mkdir -p "${AGATE_WALL_HOME:-$HOME/.agate-wall}/watcher"
exec "${BUN:-bun}" run apps/watcher/src/main.ts "$ROLE"
