#!/bin/zsh
# Restarts the wallet lab in the dev tmux session (ops/testnet/dev-session.sh), window dyn-lab (both by exact name),
# forwarding AGATE_EXTRA_ROUTERS and AGATE_SERVER_URL when set (the lab must sign the same router list as the server).
S=$(/bin/sh "$(cd "$(dirname "$0")/../../ops/testnet" && pwd)/dev-session.sh")
W=dyn-lab
ENVS=()
for v in AGATE_EXTRA_ROUTERS AGATE_SERVER_URL; do
  [ -n "${(P)v}" ] && ENVS+=(-e "$v=${(P)v}")
done
tmux list-windows -t "=$S" -F '#{window_name}' | grep -qx $W && tmux kill-window -t "=$S:$W"
tmux new-window -d "${ENVS[@]}" -t "=$S" -n $W "$(cd "$(dirname "$0")" && pwd)/run.sh"
sleep 3
tmux capture-pane -p -t "=$S:$W" | grep -v '^$' | tail -3
