# shellcheck shell=bash
# Shared by the ops/testnet scripts (bash 3.2, macOS). Sourced, never run.
#
# Modes, for every script:
#   (default)   Monad testnet through the key-free public RPC. Every signing command reads its key from the macOS
#               Keychain inline, into the environment of that one command only; nothing else ever holds a key.
#   --dry-run   prints every command it would run and sends nothing: no transaction, no Keychain read, no file
#               written, no tmux window opened. Read-only RPC calls still run unless AGATE_KIT_OFFLINE=1.
#   --fork      the same steps against a local anvil fork of Monad testnet (AGATE_KIT_FORK_RPC, loopback only, an
#               anvil node answering chain id 10143). No Keychain read: forge and the send helper send as the real
#               role addresses with --unlocked (impersonated on the fork). Records, deployments and tmux live apart
#               from the real ones (fork-kit-* files, AGATE_KIT_STATE, a private tmux server). With
#               AGATE_KIT_ROLES=rehearsal the roles that run as processes (both writers, the attester, the keeper, the
#               market maker and the payer) use public rehearsal keys derived from labels, because a process signs
#               its own transactions and no key exists here for the real addresses.
set -euo pipefail
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1
# a stray key in the caller's shell must never reach a forge run that was meant to use --sender
unset AGATE_OWNER_KEY AGATE_DEPLOYER_KEY AGATE_PAYER_KEY 2>/dev/null || true

KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$KIT/../.." && pwd)"
CONTRACTS="$ROOT/contracts"
WALL="$ROOT/wall"
INDEXER="$ROOT/indexer"
CHAIN_ID=10143
PUBLIC_RPC="https://testnet-rpc.monad.xyz"
CRE_SIM_FORWARDER="0xB9F79d863261869B234c481D1f9A7af84AeAd192"
PANELS="$WALL/packages/sources/panels/launch.json"
GAS_GWEI="${AGATE_KIT_GAS_GWEI:-102}"
DEV_SESSION_DEFAULT="agate-dev"
# The market bots' LIMIT table override (AGATE_MARKET_GAS_LIMITS), measured on Monad: up.sh hands it to the maker and
# the payer. RUNBOOK.md, "The market bots' gas limits on Monad".
MARKET_GAS_FILE="${AGATE_KIT_MARKET_GAS_LIMITS:-$KIT/market-gas-limits.json}"
# Monad's own eth_estimateGas of the bots' calls runs 1.0 to 1.7 times anvil's (by call); the MON plan multiplies the
# bots' fork figures by this.
BOT_FACTOR="${AGATE_KIT_BOT_FACTOR:-1.5}"

KIT_DRY=0
KIT_FORK=0
KIT_REHEARSAL=0
KIT_POS=()

# ------------------------------------------------------------------ roles

# The real addresses (Keychain service = role_svc, account "private-key").
role_addr_real() {
  case "$1" in
    deployer) echo 0x62565E5D1533af8C1f711C42E047e5f94C172411 ;;
    owner) echo 0x016575774F23c2c43Ea1217a080FFC7db61EE681 ;;
    primary) echo 0xF0be5c7461c0743acDE590A22BcCb66Fc2112335 ;;
    standby) echo 0x7AB94Da3958d82dF236529c57e46B6D11FE90e92 ;;
    attester) echo 0x98BEd8aD0d00D74F7D540d523a1f7Ee43673fdF1 ;;
    keeper) echo 0x1a18eD8A5776f3D3b05cAb5A56fBF8baeC077881 ;;
    guardian) echo 0x10280466C8c6eF47152523717dd83D3c97f95F02 ;;
    kick) echo 0x220095EB92b3Ec9453d5dFcBdA7e4D05fb43C259 ;;
    bot) echo 0xBFAa70A8b399097FACF4A84B98Da5B304587C8B8 ;;
    payer) echo 0x3786e99fC370506391be896E1D327a49de6A9505 ;;
    *) die "unknown role $1" ;;
  esac
}

role_svc() {
  case "$1" in
    deployer) echo agate.deployer ;;
    owner | primary | standby | attester | keeper | guardian | kick) echo "agate.wall.$1" ;;
    bot) echo agate.market.bot ;;
    payer) echo agate.market.payer ;;
    *) die "unknown role $1" ;;
  esac
}

# Rehearsal keys: private key = keccak256("agate kit rehearsal <role>"), public by construction, for a local fork only.
# Their addresses (no code and no balance on Monad testnet, checked Oct 3 2026):
role_addr_rehearsal() {
  case "$1" in
    primary) echo 0x659D83f1f28bA0Dc3056d9aE426fcD9b8f5878cE ;;
    standby) echo 0x8b0153ABB9a995ee399e5acB4FEDaA2936f9c83b ;;
    attester) echo 0x62922A844f0473faBa6fd9bC0688b43a85Bf7959 ;;
    keeper) echo 0xF2aCfEE043510402669f4F120F8BA06e8503cF01 ;;
    bot) echo 0x9A410E49A53115E85b751fE8D3b589bb8F1a717F ;;
    payer) echo 0xe1eCba46ecaeba115f92F15C066FBE5335c409Ee ;;
    *) role_addr_real "$1" ;;
  esac
}

is_process_role() { case "$1" in primary | standby | attester | keeper | bot | payer) return 0 ;; *) return 1 ;; esac; }

# The address a role has in this run.
role_addr() {
  if [ "$KIT_REHEARSAL" = 1 ] && is_process_role "$1"; then role_addr_rehearsal "$1"; else role_addr_real "$1"; fi
}

# The command a process runs at start to print its key (never run by these scripts).
role_key_cmd() {
  if [ "$KIT_REHEARSAL" = 1 ]; then
    is_process_role "$1" || die "no rehearsal key for $1"
    echo "cast keccak 'agate kit rehearsal $1'"
  else
    echo "security find-generic-password -s $(role_svc "$1") -a private-key -w"
  fi
}

# ------------------------------------------------------------------ output

say() { printf '\n== %s\n' "$*"; }
note() { printf '   %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() {
  printf 'stopped: %s\n' "$*" >&2
  exit 1
}

# One argument as a shell word for printing (plain words stay bare).
shq() {
  case "$1" in
    "" ) printf "''" ;;
    *[!A-Za-z0-9_./:=,@%+-]*) printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")" ;;
    *) printf '%s' "$1" ;;
  esac
}
cmdline() {
  local out="" a
  for a in "$@"; do out="$out $(shq "$a")"; done
  printf '%s' "${out# }"
}
# Commands print to fd 3 (the terminal), so a step whose output goes to a log still shows what it runs.
exec 3>&1
show() { printf '$ %s\n' "$*" >&3; }
argtail() { if [ $# -gt 0 ]; then printf ' %s' "$(cmdline "$@")"; fi; }

# ------------------------------------------------------------------ arguments and mode

kit_parse() {
  KIT_POS=()
  local a
  for a in "$@"; do
    case "$a" in
      --dry-run) KIT_DRY=1 ;;
      --fork) KIT_FORK=1 ;;
      *) KIT_POS+=("$a") ;;
    esac
  done
  if [ "${AGATE_KIT_ROLES:-}" = rehearsal ]; then
    [ "$KIT_FORK" = 1 ] || die "AGATE_KIT_ROLES=rehearsal is for --fork only"
    KIT_REHEARSAL=1
  elif [ -n "${AGATE_KIT_ROLES:-}" ]; then
    die "AGATE_KIT_ROLES must be unset or rehearsal"
  fi
  if [ "$KIT_FORK" = 1 ]; then
    KIT_RPC="${AGATE_KIT_FORK_RPC:-}"
    [ -n "$KIT_RPC" ] || die "--fork needs AGATE_KIT_FORK_RPC (the anvil fork's loopback URL)"
    case "$KIT_RPC" in
      http://127.0.0.1:[0-9]* | http://localhost:[0-9]*) ;;
      *) die "AGATE_KIT_FORK_RPC must be http://127.0.0.1:<port> or http://localhost:<port>" ;;
    esac
    KIT_STATE="${AGATE_KIT_STATE:-$HOME/.agate-kit-rehearsal}"
    KIT_PREFIX="fork-kit-"
    KIT_WALL_HOME="$KIT_STATE/wall"
  else
    KIT_RPC="$PUBLIC_RPC"
    KIT_STATE="${AGATE_KIT_STATE:-$HOME/.agate-kit}"
    KIT_PREFIX=""
    KIT_WALL_HOME="${AGATE_WALL_HOME:-$HOME/.agate-wall}"
  fi
  [ "$KIT_FORK" = 0 ] || [ "$KIT_WALL_HOME" != "$HOME/.agate-wall" ] || die "a fork run never uses ~/.agate-wall"
  KIT_RECORDS="${AGATE_KIT_RECORDS:-$CONTRACTS/deployments/${KIT_PREFIX}10143-indexes.json}"
  # AGATE_KIT_RECORDS and AGATE_KIT_DEPLOYMENTS: other files to read (the tests; deploy-market.sh refuses the second,
  # since DeployMarket writes the deployments file where its config names it)
  KIT_DEPLOYMENTS="${AGATE_KIT_DEPLOYMENTS:-$CONTRACTS/deployments/${KIT_PREFIX}10143.json}"
  KIT_DEMO_HISTORY="$CONTRACTS/deployments/${KIT_PREFIX}10143-demo-history.json"
  export FOUNDRY_OUT="${FOUNDRY_OUT:-$HOME/.agate-build/testnet-kit/out}"
  export FOUNDRY_CACHE_PATH="${FOUNDRY_CACHE_PATH:-$HOME/.agate-build/testnet-kit/cache}"
  export FOUNDRY_BROADCAST="$KIT_STATE/broadcast"
}

kit_mode_line() {
  local m="Monad testnet ($KIT_RPC)"
  [ "$KIT_FORK" = 1 ] && m="FORK at $KIT_RPC (local anvil; nothing reaches Monad testnet)"
  [ "$KIT_REHEARSAL" = 1 ] && m="$m, rehearsal roles"
  [ "$KIT_DRY" = 1 ] && m="$m, DRY RUN: prints every command, sends nothing"
  echo "$m"
}

need_tools() {
  local t
  for t in "$@"; do command -v "$t" >/dev/null 2>&1 || die "$t is not on PATH"; done
}

offline() { [ "$KIT_DRY" = 1 ] && [ "${AGATE_KIT_OFFLINE:-0}" = 1 ]; }

# The fork must be an anvil node on loopback answering chain id 10143 (never a public node). The fork-kit-* records in
# contracts/deployments belong to one fork: a marker file names it (its port and fork block), and a run against any
# other fork refuses them, so two --fork runs never share or overwrite each other's records.
check_fork() {
  [ "$KIT_FORK" = 1 ] || return 0
  offline && return 0
  local id info port fb marker f
  id="$(cast chain-id --rpc-url "$KIT_RPC" 2>/dev/null)" || die "no chain answers at $KIT_RPC"
  [ "$id" = "$CHAIN_ID" ] || die "the fork answers chain $id, not $CHAIN_ID"
  info="$(cast rpc anvil_nodeInfo --rpc-url "$KIT_RPC" 2>/dev/null)" || die "$KIT_RPC is not an anvil node: --fork refuses it"
  port="${KIT_RPC##*:}"
  port="${port%%/*}"
  fb="$(printf '%s' "$info" | jq -r '.forkConfig.forkBlockNumber // empty')"
  [ -n "$fb" ] || die "$KIT_RPC is not a fork of Monad testnet (anvil_nodeInfo names no fork block)"
  marker="$CONTRACTS/deployments/fork-kit-fork.json"
  if [ -f "$marker" ]; then
    [ "$(jq -r '"\(.port) \(.forkBlock)"' "$marker")" = "$port $fb" ] ||
      die "the fork-kit-* records in contracts/deployments belong to another fork ($(jq -c . "$marker")), not this one (port $port, fork block $fb): finish that run or move its fork-kit-* files away"
    return 0
  fi
  for f in "$CONTRACTS"/deployments/fork-kit-10143*; do
    [ -e "$f" ] && die "$f has no fork-kit-fork.json naming its fork: move the fork-kit-* files away first"
  done
  [ "$KIT_DRY" = 1 ] && return 0
  mkdir -p "$CONTRACTS/deployments"
  printf '{ "port": %s, "forkBlock": %s, "rpc": "%s", "state": "%s" }\n' "$port" "$fb" "$KIT_RPC" "$KIT_STATE" >"$marker"
}

# ------------------------------------------------------------------ reads (run in a dry run too, unless offline)

chain_now() {
  if offline; then echo "${AGATE_KIT_NOW:-1790000000}"; return 0; fi
  cast block latest --field timestamp --rpc-url "$KIT_RPC"
}
block_now() {
  if offline; then echo 0; return 0; fi
  cast block-number --rpc-url "$KIT_RPC"
}
nonce_of() {
  if offline; then echo 0; return 0; fi
  cast nonce "$1" --rpc-url "$KIT_RPC"
}
code_state() { # code_state ADDRESS: prints "code" or "none"; fails when the RPC call fails (never read as "none")
  offline && { echo none; return 0; }
  local c
  c="$(cast code "$1" --rpc-url "$KIT_RPC" 2>/dev/null)" || return 1
  if [ -n "$c" ] && [ "$c" != 0x ]; then echo code; else echo none; fi
}
has_code() {
  offline && return 1
  local c
  c="$(cast code "$1" --rpc-url "$KIT_RPC" 2>/dev/null)" || return 1
  [ -n "$c" ] && [ "$c" != 0x ]
}
balance_mon() {
  if offline; then echo "?"; return 0; fi
  cast balance "$1" --ether --rpc-url "$KIT_RPC"
}
rcall() { # rcall ADDRESS SIG [ARGS...]: a view call, first word of each output line
  cast call --rpc-url "$KIT_RPC" "$@"
}

# ------------------------------------------------------------------ records (contracts/deployments)

records_get() { # records_get JQ_PATH: the value, or empty
  [ -f "$KIT_RECORDS" ] || return 0
  jq -r "$1 // empty" "$KIT_RECORDS"
}

# records_put JQ_FILTER [jq --arg/--argjson pairs...]: updates the records file (a dry run prints the update only)
records_put() {
  local f="$1"
  shift
  if [ "$KIT_DRY" = 1 ]; then
    show "jq $(cmdline "$@") $(shq "$f") $(shq "$KIT_RECORDS")  (not written in a dry run)"
    return 0
  fi
  mkdir -p "$(dirname "$KIT_RECORDS")"
  [ -f "$KIT_RECORDS" ] || printf '{\n  "chainId": %s\n}\n' "$CHAIN_ID" >"$KIT_RECORDS"
  local tmp="$KIT_RECORDS.tmp.$$"
  jq "$@" "$f" "$KIT_RECORDS" >"$tmp" && mv "$tmp" "$KIT_RECORDS"
}

# deploy_block_of INDEX KIND: sets DEPLOY_BLOCK and DEPLOY_BLOCK_FROM to the block the index was created in, never a
# later one (the watchers' AGATE_FROM_BLOCK and the indexer's --index-start come from it, and a later block would hide
# the GpuRegistered events before it). In this order:
#   1. a receipt of the index's creation saved by forge in a DeployIndex broadcast file (run-latest.json or an earlier
#      run-<time>.json): the block exactly;
#   2. a creation transaction named in those files (forge saved its hash but no receipt): its receipt read from the
#      chain, if it created this address and succeeded: the block exactly;
#   3. the record's pendingBlock, the block read just before the broadcast: the index was created after it, so a scan
#      from it misses none of the index's events (a lower bound, by a few blocks).
# None of them: both stay empty, and the caller stops rather than guess.
deploy_block_of() {
  local ix f b h r
  ix="$(printf '%s' "$1" | tr 'A-F' 'a-f')"
  DEPLOY_BLOCK=""
  DEPLOY_BLOCK_FROM=""
  for f in "$FOUNDRY_BROADCAST/DeployIndex.s.sol/$CHAIN_ID"/run-*.json; do
    [ -f "$f" ] || continue
    b="$(jq -r --arg ix "$ix" '[.receipts[]? | select((.contractAddress // "" | ascii_downcase) == $ix and .status == "0x1") | .blockNumber][0] // empty' "$f")"
    if [ -n "$b" ]; then
      DEPLOY_BLOCK=$((b))
      DEPLOY_BLOCK_FROM="receipt"
      return 0
    fi
  done
  for f in "$FOUNDRY_BROADCAST/DeployIndex.s.sol/$CHAIN_ID"/run-*.json; do
    [ -f "$f" ] || continue
    for h in $(jq -r --arg ix "$ix" '.transactions[]? | select((.transactionType // "" | startswith("CREATE")) and (.contractAddress // "" | ascii_downcase) == $ix) | .hash // empty' "$f"); do
      r="$(cast rpc eth_getTransactionReceipt "$h" --rpc-url "$KIT_RPC" 2>/dev/null)" || continue
      [ "$(printf '%s' "$r" | jq -r '(.contractAddress // "" | ascii_downcase) + " " + (.status // "")' 2>/dev/null)" = "$ix 0x1" ] || continue
      DEPLOY_BLOCK=$(($(printf '%s' "$r" | jq -r .blockNumber)))
      DEPLOY_BLOCK_FROM="receipt"
      return 0
    done
  done
  b="$(records_get ".$2.pendingBlock")"
  if [ -n "$b" ] && [ "$b" != 0 ]; then
    DEPLOY_BLOCK="$b"
    DEPLOY_BLOCK_FROM="pendingBlock"
  fi
  return 0
}

index8() { printf '%s' "$1" | cut -c3-10 | tr 'A-F' 'a-f'; }
utc_date() { date -u -r "$1" '+%Y-%m-%d %H:%M:%S UTC'; }
day_date() { date -u -r "$(($1 * 86400))" '+%Y-%m-%d'; }
# hexsum: the sum of the 0x-hex (or decimal) numbers on stdin, one per line
hexsum() {
  local t=0 x
  while IFS= read -r x; do
    [ -n "$x" ] && [ "$x" != null ] && t=$((t + x))
  done
  echo "$t"
}
# gas_of RUN_JSON: "<n> <sum of gas limits> <sum of gas used>" of a forge broadcast file
gas_of() {
  printf '%s %s %s' "$(jq '.transactions | length' "$1")" \
    "$(jq -r '.transactions[].transaction.gas' "$1" | hexsum)" "$(jq -r '.receipts[].gasUsed' "$1" | hexsum)"
}
mon() { # mon GAS: MON at GAS_GWEI, 4 decimals
  awk -v g="$1" -v p="$GAS_GWEI" 'BEGIN { printf "%.4f", g * p / 1e9 }'
}

# ------------------------------------------------------------------ sending

# fork only: impersonate an address, and load it into the fork's own state by setting its balance to what it holds.
# An anvil fork answers eth_getProof for an account it has not loaded yet with nonce 0 and balance 0, and forge's
# simulation reads accounts that way: a sender whose real nonce is not 0 (the deployer's is 13) then simulates its
# CREATEs at the wrong addresses and the run stops (CreateCollision). A fork artifact; Monad's RPC is not affected.
impersonate() {
  [ "$KIT_FORK" = 1 ] || return 0
  if [ "$KIT_DRY" = 1 ]; then show "cast rpc anvil_impersonateAccount $1 --rpc-url $KIT_RPC"; return 0; fi
  cast rpc anvil_impersonateAccount "$1" --rpc-url "$KIT_RPC" >/dev/null
  local b
  b="$(cast balance "$1" --rpc-url "$KIT_RPC")"
  cast rpc anvil_setBalance "$1" "$(cast to-hex "$b")" --rpc-url "$KIT_RPC" >/dev/null
}

keychain_has() { # the item exists (attributes only: never the secret)
  security find-generic-password -s "$1" -a private-key >/dev/null 2>&1
}

# The environment a forge script reads, as a printed prefix (AGATE_CONFIG=... and the like).
script_env() {
  local v out=""
  for v in AGATE_CONFIG AGATE_MARKET_CONFIG AGATE_FACTORY; do
    if [ -n "${!v:-}" ]; then out="$out$v=$(shq "${!v}") "; fi
  done
  printf '%s' "$out"
}

# key_prefix ROLE KEYVAR: the printed inline Keychain read of a signing command
key_prefix() { printf '%s="$(security find-generic-password -s %s -a private-key -w)"' "$2" "$(role_svc "$1")"; }

# signed ROLE KEYVAR CMD...: runs CMD with the role's key in KEYVAR, read from the Keychain inline into the
# environment of that one command (the caller prints the operator form). A failed or malformed read stops here,
# before CMD starts; nothing else ever holds the key.
signed() {
  local role="$1" var="$2" svc
  shift 2
  svc="$(role_svc "$role")"
  [ "$KIT_DRY" = 1 ] && return 0
  keychain_has "$svc" || die "no Keychain item $svc (account private-key): nothing sent"
  local rc=0
  (
    { set +x; } 2>/dev/null # never trace the key, even when the script runs under bash -x
    k="$(security find-generic-password -s "$svc" -a private-key -w)" || exit 70
    case "$k" in 0x*) ;; *) exit 70 ;; esac
    [ "${#k}" -eq 66 ] || exit 70
    export "$var=$k"
    unset k
    exec "$@"
  ) || rc=$?
  [ "$rc" = 70 ] && die "the Keychain read of $svc failed or did not give a 0x key: nothing sent"
  return "$rc"
}

# A forge script that sends as ROLE: the key in KEYVAR (testnet) or --unlocked --sender (fork).
# forge_send ROLE KEYVAR SCRIPT [forge args...]   (the caller exports AGATE_CONFIG / AGATE_MARKET_CONFIG)
forge_send() {
  local role="$1" var="$2" script="$3"
  shift 3
  if [ "$KIT_FORK" = 1 ]; then
    local who
    who="$(role_addr "$role")"
    impersonate "$who"
    show "(cd contracts && $(script_env)forge script $script --rpc-url $KIT_RPC --broadcast --slow --non-interactive --unlocked --sender $who --no-storage-caching$(argtail "$@"))"
    [ "$KIT_DRY" = 1 ] && return 0
    (cd "$CONTRACTS" && forge script "$script" --rpc-url "$KIT_RPC" --broadcast --slow --non-interactive \
      --unlocked --sender "$who" --no-storage-caching "$@")
  else
    show "(cd contracts && $(key_prefix "$role" "$var") $(script_env)forge script $script --rpc-url $KIT_RPC --broadcast --slow --non-interactive$(argtail "$@"))"
    [ "$KIT_DRY" = 1 ] && return 0
    (cd "$CONTRACTS" && signed "$role" "$var" forge script "$script" --rpc-url "$KIT_RPC" --broadcast --slow \
      --non-interactive "$@")
  fi
}

# A forge script that sends nothing (simulation or a view step).
# On a fork, forge's RPC storage cache is off: the fork's blocks carry real block numbers with other state, and a
# cached fork block would later be read as the real one (and the reverse).
forge_read() {
  local script="$1"
  shift
  if [ "$KIT_FORK" = 1 ]; then set -- "$@" --no-storage-caching; fi
  show "(cd contracts && $(script_env)forge script $script --rpc-url $KIT_RPC$(argtail "$@"))"
  [ "$KIT_DRY" = 1 ] && return 0
  (cd "$CONTRACTS" && forge script "$script" --rpc-url "$KIT_RPC" "$@")
}

# The send helper (ops/testnet/send.ts) as ROLE: transfers or one contract call.
# send_as ROLE KEYVAR SUBCOMMAND [args...]
send_as() {
  local role="$1" var="$2" who
  shift 2
  who="$(role_addr "$role")"
  if [ "$KIT_FORK" = 1 ]; then
    impersonate "$who"
    show "bun run ops/testnet/send.ts $(cmdline "$@") --rpc $KIT_RPC --from $who --unlocked"
    [ "$KIT_DRY" = 1 ] && return 0
    bun run "$KIT/send.ts" "$@" --rpc "$KIT_RPC" --from "$who" --unlocked
  else
    show "$(key_prefix "$role" "$var") bun run ops/testnet/send.ts $(cmdline "$@") --rpc $KIT_RPC --from $who --key-env $var"
    [ "$KIT_DRY" = 1 ] && return 0
    signed "$role" "$var" bun run "$KIT/send.ts" "$@" --rpc "$KIT_RPC" --from "$who" --key-env "$var"
  fi
}

# ------------------------------------------------------------------ text edits of config files

# set_json_number FILE KEY VALUE: rewrites the single `"KEY": <digits>` in FILE (text edit: the configs hold a
# chainSelector above 2^53, so they are never parsed and written back whole).
set_json_number() {
  local file="$1" key="$2" val="$3" n
  n="$(grep -c "\"$key\": [0-9][0-9]*" "$file" || true)"
  [ "$n" = 1 ] || die "$file has $n \"$key\" numbers, expected 1"
  if [ "$KIT_DRY" = 1 ]; then show "set \"$key\": $val in $file  (not written in a dry run)"; return 0; fi
  sed -E -i '' "s/\"$key\": [0-9]+/\"$key\": $val/" "$file"
}

# ------------------------------------------------------------------ tmux (exact window names only)

TMUX_SOCK="${AGATE_KIT_TMUX_SOCKET:-}"
TMUX_SESSION="${AGATE_KIT_TMUX_SESSION:-$DEV_SESSION_DEFAULT}"
tmx() {
  if [ -n "$TMUX_SOCK" ]; then tmux -L "$TMUX_SOCK" "$@"; else tmux "$@"; fi
}
tmx_show() { # the printed form of a tmux command
  if [ -n "$TMUX_SOCK" ]; then show "tmux -L $TMUX_SOCK $(cmdline "$@")"; else show "tmux $(cmdline "$@")"; fi
}
check_tmux_target() {
  if [ "$KIT_FORK" = 1 ]; then
    [ -n "$TMUX_SOCK" ] && [ "$TMUX_SOCK" != default ] ||
      die "a fork run uses a private tmux server: set AGATE_KIT_TMUX_SOCKET (e.g. agate-rehearsal)"
    [ "$TMUX_SESSION" != "$DEV_SESSION_DEFAULT" ] || die "a fork run never uses the session $DEV_SESSION_DEFAULT"
  fi
}
# The id (@N) of the window named exactly NAME in the session, or empty. Ids never shift when windows close.
win_id() {
  tmx list-windows -t "=$TMUX_SESSION" -F '#{window_id} #{window_name}' 2>/dev/null |
    awk -v n="$1" '{ id = $1; $1 = ""; sub(/^ /, ""); if ($0 == n) print id }' | head -1
}
