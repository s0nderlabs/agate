#!/bin/sh
# Starts the standby writer with its key taken from AGATE_STANDBY_KEY_CMD at start (never stored by this script).
# One process per index: a second copy exits with code 3 (flock), and launchd's KeepAlive retries it harmlessly.
set -eu
: "${AGATE_STANDBY_KEY_CMD:?set AGATE_STANDBY_KEY_CMD to a command that prints the standby key}"
# The RPC list: AGATE_RPC_URLS_CMD (a command the process itself runs once at start, keeping the URLs in memory: the
# Alchemy URL carries a key, 13.6) or AGATE_RPC_URLS. This script never resolves the command.
if [ -z "${AGATE_RPC_URLS_CMD:-}" ] && [ -z "${AGATE_RPC_URLS:-}" ]; then
  echo "set AGATE_RPC_URLS_CMD (a command printing the RPC URLs) or AGATE_RPC_URLS (two or more, comma-separated)" >&2
  exit 64
fi
AGATE_STANDBY_KEY="$(/bin/sh -c "$AGATE_STANDBY_KEY_CMD")"
export AGATE_STANDBY_KEY
unset AGATE_STANDBY_KEY_CMD
mkdir -p "${AGATE_WALL_HOME:-$HOME/.agate-wall}/standby"
exec "${BUN:-bun}" run apps/writer-standby/src/main.ts
