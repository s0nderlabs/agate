#!/bin/zsh
# Runs the wallet lab dev server (tmux window dyn-lab in agate-dev): http://localhost:5174
cd "$(dirname "$0")/.."
exec bun run lab
