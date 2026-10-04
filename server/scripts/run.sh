#!/bin/zsh
# Runs the agate server in the foreground (tmux window dyn-server in agate-dev). Secrets are read from
# AGATE_DYNAMIC_HOME (default ~/.agate-dynamic) by the server itself; nothing is sourced or echoed here.
cd "$(dirname "$0")/.."
exec bun run src/index.ts
