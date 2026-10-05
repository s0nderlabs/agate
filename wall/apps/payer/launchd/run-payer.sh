#!/bin/sh
# Starts the daily payer and lister (BOTS-SPEC 2.8, 4). The key never passes through this script: the bun process
# runs AGATE_KEY_CMD itself at start and keeps the key in memory (audit M-K1: a key exported here would stay readable
# in the process's exec-time environment, `ps -wwE`, for its whole life). This script only checks the command is set.
# AGATE_DRY_RUN=1 needs no key (then AGATE_PAYER_ADDRESS names the address to simulate from).
# AGATE_PAYER_SIGNER=dynamic: no key at all; a Dynamic server wallet signs (AGATE_DYNAMIC_TOKEN_CMD prints the API
# token, run by the process itself; AGATE_DYNAMIC_WALLET_FILE, mode 600; AGATE_PAYER_ADDRESS is the wallet's address).
set -eu
if [ "${AGATE_PAYER_SIGNER:-}" = "dynamic" ]; then
  : "${AGATE_PAYER_ADDRESS:?set AGATE_PAYER_ADDRESS to the address of the payer Dynamic server wallet}"
  if [ "${AGATE_DRY_RUN:-}" != "1" ]; then
    : "${AGATE_DYNAMIC_TOKEN_CMD:?set AGATE_DYNAMIC_TOKEN_CMD to a command that prints the Dynamic API token}"
  fi
elif [ "${AGATE_DRY_RUN:-}" != "1" ]; then
  : "${AGATE_KEY_CMD:?set AGATE_KEY_CMD to a command that prints the payer key (agate.market.payer)}"
fi
# never a key in a variable: the process takes it from AGATE_KEY_CMD
unset AGATE_PAYER_KEY
# the RPC list: AGATE_RPC_URLS_CMD (run by the process itself at start, in memory only) or AGATE_RPC_URLS
if [ -z "${AGATE_RPC_URLS_CMD:-}" ] && [ -z "${AGATE_RPC_URLS:-}" ]; then
  echo "set AGATE_RPC_URLS_CMD (or AGATE_RPC_URLS) for the payer" >&2
  exit 2
fi
: "${AGATE_DEPLOYMENTS:?set AGATE_DEPLOYMENTS to the deployments file (a copy outside ~/Documents)}"
mkdir -p "${AGATE_WALL_HOME:-$HOME/.agate-wall}/market/payer"
exec "${BUN:-bun}" run apps/payer/src/main.ts run
