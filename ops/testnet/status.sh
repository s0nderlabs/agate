#!/usr/bin/env bash
# Read-only status of one index's stack: the guardian CLI's status (heads, last final fixes, writers, queued owner
# actions, the page check, every heartbeat, the open alerts), then the market maker's and the payer's status (files
# only) and which of the kit's windows are open. Sends nothing and holds no key; the RPC list comes from the same
# command the processes use.
#
#   ops/testnet/status.sh <production|demo> [--dry-run] [--fork]
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

kit_parse "$@"
STACK="${KIT_POS[0]:-}"
case "$STACK" in production | demo) ;; *) die "usage: $0 <production|demo> [--dry-run] [--fork]" ;; esac
need_tools bun jq
check_fork
check_tmux_target

IX="$(records_get ".$STACK.index")"
BLOCK="$(records_get ".$STACK.deployBlock")"
if [ -z "$IX" ]; then
  [ "$KIT_DRY" = 1 ] || die "no $STACK index in $KIT_RECORDS"
  IX="0x$(printf '%040d' 0)"
  BLOCK=0
fi
if [ "$KIT_FORK" = 1 ]; then
  PORT="${KIT_RPC##*:}"
  PORT="${PORT%%/*}"
  RPC_CMD="printf 'http://127.0.0.1:$PORT,http://localhost:$PORT'"
else
  RPC_CMD='k="$(security find-generic-password -s agate.alchemy-api-key -a api-key -w)" && printf '"'"'https://monad-testnet.g.alchemy.com/v2/%s,https://testnet-rpc.monad.xyz'"'"' "$k"'
fi
LOGDIR_ENV=""
if [ "$STACK" = production ] && [ "$KIT_FORK" = 0 ]; then
  LOGDIR_ENV="${AGATE_KIT_PROD_LOG_DIR:-$HOME/.agate-wall/watcher/production-0}"
fi

say "status $STACK: $(kit_mode_line)"
note "index $IX (deploy block $BLOCK)"
show "(cd wall && env -i HOME=\$HOME PATH=\$PATH AGATE_WALL_HOME=$KIT_WALL_HOME AGATE_INDEX=$IX AGATE_PANELS=$PANELS AGATE_FROM_BLOCK=$BLOCK${LOGDIR_ENV:+ AGATE_WATCHER_LOG_DIR=$LOGDIR_ENV} AGATE_RPC_URLS_CMD=$(shq "$RPC_CMD") bun run apps/guardian/src/cli.ts status)"
show "(cd wall && AGATE_WALL_HOME=$KIT_WALL_HOME bun run apps/marketmaker/src/main.ts status; ... apps/payer/src/main.ts status)"
[ "$KIT_DRY" = 1 ] && exit 0

(cd "$WALL" && env -i HOME="$HOME" PATH="$PATH" FOUNDRY_DISABLE_NIGHTLY_WARNING=1 AGATE_WALL_HOME="$KIT_WALL_HOME" \
  AGATE_INDEX="$IX" AGATE_PANELS="$PANELS" AGATE_FROM_BLOCK="$BLOCK" ${LOGDIR_ENV:+AGATE_WATCHER_LOG_DIR="$LOGDIR_ENV"} \
  AGATE_RPC_URLS_CMD="$RPC_CMD" bun run apps/guardian/src/cli.ts status) || warn "guardian status failed"
say "market maker"
(cd "$WALL" && env -i HOME="$HOME" PATH="$PATH" AGATE_WALL_HOME="$KIT_WALL_HOME" bun run apps/marketmaker/src/main.ts status 2>&1 | tail -20) || true
say "payer"
(cd "$WALL" && env -i HOME="$HOME" PATH="$PATH" AGATE_WALL_HOME="$KIT_WALL_HOME" bun run apps/payer/src/main.ts status 2>&1 | tail -20) || true
say "the kit's windows"
for n in prod-log prod-primary prod-standby prod-attest prod-keep prod-pagecheck prod-health demo-replay demo-log demo-primary \
  demo-standby demo-attest demo-keep demo-pagecheck demo-health shared-maker shared-payer shared-indexer shared-repair shared-akash shared-awake; do
  id="$(win_id "$n")"
  [ -n "$id" ] && note "$n: open ($id, $([ "$(tmx display-message -p -t "$id" '#{pane_dead}')" = 1 ] && echo 'process ended' || echo running))"
done
exit 0
