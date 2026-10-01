#!/bin/sh
# Starts the standby writer with its key taken from AGATE_STANDBY_KEY_CMD at start (never stored by this script).
# One process per index: a second copy exits with code 3 (flock), and launchd's KeepAlive retries it harmlessly.
set -eu
: "${AGATE_STANDBY_KEY_CMD:?set AGATE_STANDBY_KEY_CMD to a command that prints the standby key}"
: "${AGATE_RPC_URLS:?set AGATE_RPC_URLS to two or more RPC URLs, comma-separated}"
AGATE_STANDBY_KEY="$(/bin/sh -c "$AGATE_STANDBY_KEY_CMD")"
export AGATE_STANDBY_KEY
unset AGATE_STANDBY_KEY_CMD
mkdir -p "${AGATE_WALL_HOME:-$HOME/.agate-wall}/standby"
exec "${BUN:-bun}" run apps/writer-standby/src/main.ts
