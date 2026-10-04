#!/bin/zsh
# Restarts the agate server in tmux agate-dev, window dyn-server (by exact name). Non-secret settings are
# forwarded when set in the calling shell; secrets stay in AGATE_DYNAMIC_HOME and are read by the server itself.
# The live-test endpoint (lab-trade) stays off unless the calling shell sets AGATE_LAB=1.
S=agate-dev
W=dyn-server
ENVS=(-e AGATE_LAB=${AGATE_LAB:-0})
for v in AGATE_PUBLIC_BASE AGATE_APP_BASE AGATE_APP_ORIGINS AGATE_EXTRA_ROUTERS AGATE_FACTORY AGATE_DEPLOYMENTS_FILE AGATE_GRAPHQL_URL MONAD_RPC_URL; do
  [ -n "${(P)v}" ] && ENVS+=(-e "$v=${(P)v}")
done
tmux list-windows -t $S -F '#{window_name}' | grep -qx $W && tmux kill-window -t "$S:$W"
tmux new-window -d "${ENVS[@]}" -t $S -n $W "$(cd "$(dirname "$0")" && pwd)/run.sh"
sleep 2
tmux capture-pane -p -t "$S:$W" | grep -v '^$' | tail -2
