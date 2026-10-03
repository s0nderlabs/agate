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
# the RPC list: AGATE_RPC_URLS_CMD (run by the process itself at start, in memory only: 13.6) or AGATE_RPC_URLS
if [ -z "${AGATE_RPC_URLS_CMD:-}" ] && [ -z "${AGATE_RPC_URLS:-}" ] && { [ "$ROLE" != "log" ] || [ -n "${AGATE_INDEX:-}" ]; }; then
  echo "set AGATE_RPC_URLS_CMD (or AGATE_RPC_URLS) for the $ROLE role" >&2
  exit 2
fi
mkdir -p "${AGATE_WALL_HOME:-$HOME/.agate-wall}/watcher"
exec "${BUN:-bun}" run apps/watcher/src/main.ts "$ROLE"
