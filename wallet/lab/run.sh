#!/bin/zsh
# Runs the wallet lab dev server (tmux window dyn-lab in the dev session): http://localhost:5174
cd "$(dirname "$0")/.."
exec bun run lab
