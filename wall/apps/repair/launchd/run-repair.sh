#!/bin/sh
# Starts the repair agent (BUILD-SPEC 15.2), one process for every index. It holds no key and reads none: the RPC
# list (optional, read only) comes from AGATE_RPC_URLS_CMD, which the process runs itself at start (13.6).
set -eu
: "${AGATE_INDEXES:?set AGATE_INDEXES to the served index addresses, comma separated}"
: "${AGATE_PANELS:?set AGATE_PANELS to the panel file}"
[ -n "${AGATE_RPC_URLS_CMD:-}" ] || unset AGATE_RPC_URLS_CMD
mkdir -p "${AGATE_WALL_HOME:-$HOME/.agate-wall}/repair"
exec "${BUN:-bun}" run apps/repair/src/main.ts watch
