#!/bin/sh
# Starts the primary writer (the CRE runner) with its key taken from AGATE_PRIMARY_KEY_CMD at start (never stored by
# this script). The key reaches the CRE CLI child only through its environment. The CLI needs the operator's CRE login
# (cre login, done by hand) under this HOME; without it every run falls back to direct posting (logged "direct").
set -eu
: "${AGATE_PRIMARY_KEY_CMD:?set AGATE_PRIMARY_KEY_CMD to a command that prints the primary key}"
# The RPC list: AGATE_RPC_URLS_CMD (a command the process itself runs once at start, keeping the URLs in memory: the
# Alchemy URL carries a key, 13.6) or AGATE_RPC_URLS. This script never resolves the command.
if [ -z "${AGATE_RPC_URLS_CMD:-}" ] && [ -z "${AGATE_RPC_URLS:-}" ]; then
  echo "set AGATE_RPC_URLS_CMD (a command printing the RPC URLs) or AGATE_RPC_URLS (two or more, comma-separated)" >&2
  exit 64
fi
AGATE_PRIMARY_KEY="$(/bin/sh -c "$AGATE_PRIMARY_KEY_CMD")"
export AGATE_PRIMARY_KEY
unset AGATE_PRIMARY_KEY_CMD
mkdir -p "${AGATE_WALL_HOME:-$HOME/.agate-wall}/primary"
exec "${BUN:-bun}" run apps/writer-cre/src/runner.ts
