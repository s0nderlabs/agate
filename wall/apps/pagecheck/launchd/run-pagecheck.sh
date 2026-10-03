#!/bin/sh
# Starts the page check for one index (BUILD-SPEC 15.1). No key, no RPC; one process per index (flock).
set -eu
: "${AGATE_INDEX:?set AGATE_INDEX to the index address}"
: "${AGATE_PANELS:?set AGATE_PANELS to the panel file of the index}"
[ -n "${TRACKER_BASE_URL:-}" ] || unset TRACKER_BASE_URL
mkdir -p "${AGATE_WALL_HOME:-$HOME/.agate-wall}/pagecheck"
exec "${BUN:-bun}" run apps/pagecheck/src/main.ts
