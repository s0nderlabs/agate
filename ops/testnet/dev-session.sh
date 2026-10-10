#!/bin/sh
# Prints the name of this machine's dev tmux session: AGATE_KIT_DEV_SESSION, else the first line of
# ~/.agate-kit/dev-session (a machine's own name, kept out of the repo; spaces and a CR trimmed), else agate-dev.
# The one place this rule lives: ops/testnet/lib.sh, server/scripts/restart.sh and wallet/lab/restart.sh call it.
s="${AGATE_KIT_DEV_SESSION:-}"
if [ -z "$s" ] && [ -n "${HOME:-}" ] && [ -r "$HOME/.agate-kit/dev-session" ]; then
  s="$(head -n 1 "$HOME/.agate-kit/dev-session" | tr -d '\r' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
fi
printf '%s\n' "${s:-agate-dev}"
