#!/usr/bin/env bash
# Starts the server's half of the production stack in the tmux session "agate", for the agate-stack systemd unit
# (ops/server/agate-stack.service) at boot or by hand. Idempotent: a window already running is left alone, a stopped
# one is started again. The local machine keeps the standby writer, the repair agent, its own logger and its own health.
#
#   ops/server/stack.sh            start whatever is not running
#   ops/server/stack.sh --windows  print the window list and exit
#
# Besides the kit's windows (up.sh) it runs three of its own, each restarted 10 s after an unexpected exit:
#   wall-log       the watcher logger (no key), on the production index once it is deployed (reader swaps)
#   graphql-proxy  the indexer's public face (ops/server/graphql-proxy.ts), behind Tailscale Funnel on port 8443
#   ai-server      the AI connector and app API (server/), behind Tailscale Funnel on port 443; its non-secret settings
#                  come from ~/agate/run/ai-server.env (KEY=value lines), its secrets from ~/.agate-dynamic
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export PATH="$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin"
export AGATE_KIT_TMUX_SESSION=agate
# the kit's roles on this server (exact window names)
export AGATE_KIT_WINDOWS="prod-primary prod-attest prod-keep prod-pagecheck prod-health shared-maker shared-payer shared-indexer shared-akash"
# (up.sh points this machine's health at the roles it opens here, and gives it the chain-wide checks: the keeper is here)
[ "${1:-}" = --windows ] && { echo "wall-log graphql-proxy ai-server $AGATE_KIT_WINDOWS"; exit 0; }

RUN="$HOME/agate/run"
LOGS="$HOME/agate/logs"
mkdir -p "$RUN" "$LOGS"
tmux has-session -t "=agate" 2>/dev/null || tmux new-session -d -s agate -n home -c "$ROOT"

# own_window NAME DIR CMD...: a launcher (clean environment, restart loop) in its own window, output to $LOGS/NAME.log
own_window() {
  local name="$1" dir="$2" f="$RUN/$1.sh"
  shift 2
  {
    printf '#!/bin/sh\ncd %s || exit 1\n' "$dir"
    printf 'while :; do\n  env -i HOME="$HOME" PATH=%s USER="$USER" LANG=C.UTF-8 %s\n' "$PATH" "$*"
    printf '  rc=$?; case "$rc" in 0|2|3|64|130|143) echo "%s stopped (exit $rc)"; break;; esac\n' "$name"
    printf '  echo "%s exited $rc: restarting in 10 s"; sleep 10\ndone\n' "$name"
  } >"$f"
  chmod 700 "$f"
  if ! tmux list-windows -t "=agate" -F '#{window_name}' | grep -qx "$name"; then
    tmux new-window -d -t "=agate:" -n "$name"
    tmux set-option -w -t "=agate:$name" remain-on-exit on
    tmux pipe-pane -o -t "=agate:$name" "cat >> '$LOGS/$name.log'"
    tmux respawn-pane -k -t "=agate:$name" "/bin/sh $f"
  elif [ "$(tmux display-message -p -t "=agate:$name" '#{pane_dead}')" = 1 ]; then
    tmux respawn-pane -k -t "=agate:$name" "/bin/sh $f"
  fi
}

# The logger reads each page with the reader the index has in force (its reader swaps, 8.6) only when it knows the
# index. Without AGATE_INDEX it runs the pre-deploy profile mode, which keeps the registered readers for good: after a
# reader swap the attester then sees that page as no price and leaves every changed day unsigned (Oct 2026, Nebius).
# own_window joins its arguments with spaces, so a value with a space carries its own single quotes.
REC="$ROOT/contracts/deployments/10143-indexes.json"
IX="$(jq -r '.production.index // empty' "$REC" 2>/dev/null || true)"
if [ -n "$IX" ]; then
  own_window wall-log "$ROOT/wall" AGATE_WALL_HOME="$HOME/.agate-wall" AGATE_CHAIN_ID=10143 AGATE_INDEX="$IX" \
    AGATE_PANELS="$ROOT/wall/packages/sources/panels/launch.json" \
    AGATE_RPC_URLS=https://testnet-rpc.monad.xyz,https://10143.rpc.thirdweb.com,https://rpc.ankr.com/monad_testnet \
    AGATE_FROM_BLOCK="$(jq -r '.production.deployBlock // 0' "$REC")" \
    AGATE_WATCHER_LOG_DIR="$HOME/.agate-wall/watcher/production-0" \
    "AGATE_NOTIFY_CMD='/bin/sh $ROOT/ops/testnet/notify.sh'" "$HOME/.bun/bin/bun" run apps/watcher/src/main.ts log
else
  own_window wall-log "$ROOT/wall" AGATE_PROFILE=PRODUCTION AGATE_EPOCH_TS=0 "$HOME/.bun/bin/bun" run apps/watcher/src/main.ts log
fi
own_window graphql-proxy "$ROOT" "$HOME/.bun/bin/bun" run ops/server/graphql-proxy.ts
# the AI server's non-secret settings: each KEY=value line of ai-server.env (values without spaces or quotes)
AI_ENV=""
if [ -f "$RUN/ai-server.env" ]; then
  while IFS= read -r line; do
    case "$line" in [A-Z]*=*) case "$line" in *[\ \'\"]*) ;; *) AI_ENV="$AI_ENV $line" ;; esac ;; esac
  done <"$RUN/ai-server.env"
fi
own_window ai-server "$ROOT/server" $AI_ENV "$HOME/.bun/bin/bun" run src/index.ts

exec "$ROOT/ops/testnet/up.sh" production
