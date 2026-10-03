#!/bin/sh
# Starts the Akash traded-price reader (BUILD-SPEC 16). No key, no RPC of ours; one process (flock).
set -eu
mkdir -p "${AGATE_WALL_HOME:-$HOME/.agate-wall}/akash"
exec "${BUN:-bun}" run apps/akash/src/cli.ts watch
