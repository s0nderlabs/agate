#!/usr/bin/env bash
# The market's dress rehearsal on a fork of Monad testnet (docs/market/BUILD-SPEC.md 12.3). Local only: every chain
# runs through wall/scripts/anvil-safe.sh, every sender is a fresh address impersonated on the fork (no key exists
# for any of them), nothing is sent to a public network, and anvil and its state dir are gone when this exits.
#
#   contracts/script/rehearse-market.sh            the dress rehearsal: the demo index (fork-demo.json), the market
#                                                  (market-fork.json, Kuru V1's real Router, then DeployMarket
#                                                  verify()), readings posted and attested until a record is final,
#                                                  ListSeries, one openShort and one openLong through the router,
#                                                  the deployments JSON printed
#   contracts/script/rehearse-market.sh fork-test  forge test against the fork for every test/market test gated on
#                                                  MONAD_FORK_URL (test/market/fork/*, adversarial/KuruSquatFork.t.sol);
#                                                  extra arguments go to forge test, e.g. --isolate
#
# Refuses to start under AGATE_ANVIL_MIN_FREE_GB GB free (default 30, the floor anvil-safe applies too) and checks
# the disk again at the end. Env: AGATE_FORK_PORT (8546), AGATE_FORK_UPSTREAM (https://testnet-rpc.monad.xyz),
# FOUNDRY_OUT / FOUNDRY_CACHE_PATH (default under ~/.agate-build/rehearse, so a parallel build never shares
# contracts/out).
set -euo pipefail

MODE="${1:-rehearse}"
[ $# -gt 0 ] && shift
HERE="$(cd "$(dirname "$0")" && pwd)"
CONTRACTS="$(dirname "$HERE")"
ROOT="$(dirname "$CONTRACTS")"
SAFE="$ROOT/wall/scripts/anvil-safe.sh"
PORT="${AGATE_FORK_PORT:-8546}"
RPC="http://127.0.0.1:$PORT"
UPSTREAM="${AGATE_FORK_UPSTREAM:-https://testnet-rpc.monad.xyz}"
ANVIL_ROOT="${AGATE_ANVIL_ROOT:-$HOME/.cache/agate-anvil}"
MIN_GB="${AGATE_ANVIL_MIN_FREE_GB:-30}" # anvil-safe's floor and default: one setting for both checks
export FOUNDRY_OUT="${FOUNDRY_OUT:-$HOME/.agate-build/rehearse/out}"
export FOUNDRY_CACHE_PATH="${FOUNDRY_CACHE_PATH:-$HOME/.agate-build/rehearse/cache}"
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1
WORK="$(mktemp -d "${TMPDIR:-/tmp}/agate-rehearse.XXXXXX")"
export FOUNDRY_BROADCAST="$WORK/broadcast" # forge script's run logs stay out of the repo
DEPLOYMENTS="$CONTRACTS/deployments/fork-10143.json"

case "$MODE" in
  rehearse | fork-test) ;;
  *) echo "usage: $0 [rehearse|fork-test] [forge test args...]" >&2; exit 2 ;;
esac

say() { printf '\n== %s\n' "$*"; }
free_gb() { df -Pk / | awk 'NR==2 { print int($4 / 1048576) }'; }
anvil_tmp_kb() { { du -sk "$HOME/.foundry/anvil/tmp" 2>/dev/null || echo 0; } | cut -f1; }
run_dirs() { { ls -d "$ANVIL_ROOT"/run.* 2>/dev/null || true; } | wc -l | tr -d ' '; }
# the run dir of the anvil-safe wrapper with pid $1 (anvil-safe writes its pid into the dir it creates). The leak
# check looks at this run's own dir only: other builds' anvil-safe runs and anvil-safe's sweep of stale dirs change
# the count of run dirs, so a count could hide a leak or report a false one.
own_run_dir() {
  for d in "$ANVIL_ROOT"/run.*; do
    [ -d "$d" ] && [ "$(cat "$d/wrapper.pid" 2>/dev/null)" = "$1" ] && echo "$d"
  done
  return 0
}

say "disk before"
df -h /
if [ "$(free_gb)" -lt "$MIN_GB" ]; then
  echo "only $(free_gb) GB free (floor $MIN_GB GB): not starting anvil" >&2
  rm -rf "$WORK"
  exit 1
fi
TMP_BEFORE="$(anvil_tmp_kb)"
echo "~/.foundry/anvil/tmp: ${TMP_BEFORE} KB; anvil-safe run dirs (any build): $(run_dirs)"
# the fork's deployments file and DeployMarket's pending twin: put back as they were when this exits
for f in "$DEPLOYMENTS" "$DEPLOYMENTS.pending"; do
  if [ -f "$f" ]; then cp "$f" "$WORK/$(basename "$f").before"; fi
done

SAFE_PID=""
ANVIL_PID=""
RUN_DIR=""
cleanup() {
  status=$?
  set +e
  if [ -n "$SAFE_PID" ]; then
    kill "$SAFE_PID" 2>/dev/null
    wait "$SAFE_PID" 2>/dev/null
  fi
  # the fork's deployments files mean nothing once the fork is gone: put back what was there before
  for f in "$DEPLOYMENTS" "$DEPLOYMENTS.pending"; do
    if [ -f "$WORK/$(basename "$f").before" ]; then cp "$WORK/$(basename "$f").before" "$f"; else rm -f "$f"; fi
  done
  rm -rf "$WORK"
  say "after"
  df -h /
  left=0
  if [ -n "$ANVIL_PID" ] && kill -0 "$ANVIL_PID" 2>/dev/null; then
    echo "anvil $ANVIL_PID is still running" >&2
    left=1
  fi
  [ -z "$RUN_DIR" ] && [ -n "$SAFE_PID" ] && RUN_DIR="$(own_run_dir "$SAFE_PID")"
  echo "~/.foundry/anvil/tmp: $(anvil_tmp_kb) KB (before ${TMP_BEFORE}); this run's anvil-safe dir: ${RUN_DIR:-none}"
  if [ -n "$RUN_DIR" ] && [ -e "$RUN_DIR" ]; then
    echo "this run's anvil-safe dir was left behind: $RUN_DIR" >&2
    left=1
  fi
  [ "$left" = 0 ] && [ "$status" = 0 ] && echo "no anvil and no state dir left"
  [ "$left" = 0 ] || status=1
  exit "$status"
}
trap cleanup EXIT
trap 'exit 143' INT TERM HUP

say "fork of $UPSTREAM on port $PORT (anvil-safe)"
"$SAFE" --fork-url "$UPSTREAM" --code-size-limit 131072 --port "$PORT" >"$WORK/anvil.log" 2>&1 &
SAFE_PID=$!
for _ in $(seq 1 120); do
  if cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then break; fi
  if ! kill -0 "$SAFE_PID" 2>/dev/null; then
    cat "$WORK/anvil.log" >&2
    exit 1
  fi
  sleep 1
done
cast chain-id --rpc-url "$RPC" >/dev/null
RUN_DIR="$(own_run_dir "$SAFE_PID")"
[ -n "$RUN_DIR" ] && ANVIL_PID="$(cat "$RUN_DIR/anvil.pid" 2>/dev/null)"
FORK_BLOCK="$(cast block-number --rpc-url "$RPC")"
echo "chain $(cast chain-id --rpc-url "$RPC"), fork block $FORK_BLOCK, anvil pid ${ANVIL_PID:-?}, run dir ${RUN_DIR:-?}"

cd "$CONTRACTS"

if [ "$MODE" = fork-test ]; then
  # every market test that skips without MONAD_FORK_URL (test/market/fork, the audit's KuruSquatFork, any later one)
  FORK_TESTS="$(grep -rl --include='*.t.sol' MONAD_FORK_URL test/market | sort | paste -sd, -)"
  [ -n "$FORK_TESTS" ] || { echo "no fork-gated test found under test/market" >&2; exit 1; }
  say "fork tests: ${FORK_TESTS//,/ }"
  MONAD_FORK_URL="$RPC" forge test --match-path "{$FORK_TESTS}" --no-storage-caching -vv "$@"
  exit 0
fi

# ------------------------------------------------------------------ the dress rehearsal
# fork-demo.json roles and market-fork.json's deployer, minter and maker: fresh addresses (keccak256 of a label)
OWNER=0x3E8F5a1021e0e0da13fC93fa0788fFf75E112F16
PRIMARY=0xb2aC5cd5058220A88E59130fFCc1fff7d89d20D8
ATTESTER=0x406A4ef9602F9D527Ea9A748EE26aC2343a7Ea39
DEPLOYER=0xAd207bd58C60899A88ca302aD897D14517a80B1c # market-fork.json: dollar minter and market admin
MAKER=0xcFF75274bE1b48C0F75617A4f7A1F43763Bc30c7    # market-fork.json: the bot float's recipient
LISTER=0x486E00dEa49662518f0266Ddd7731f0793CDb7B2    # keccak256("agate rehearsal lister")
AGUSER=0x3Be950e907f0096c77C0Cdb1e1A8E23B9B3dfBC5      # keccak256("agate rehearsal user")
MARGIN=0xd029C2D98ff85D8F64799017fE00a59B1159CE02
H100=0x12aa97fa8c2e1cc1914a2e4d86b36c7b36fdccec7c4caacb5f202ccc6d9be955
H200=0xf7b3c4797305bd1433be196119ae5d6df4a433cffbf8d02c22048cc3a487b30d
B200=0x0a5bf357b491308f9e8b00f22d9d58b1c984046be5b4a94a21a59038b996dd27
SELECTOR=2183018362218727504
DAY1=20727
NOPERMIT="(0,0,0,0x0000000000000000000000000000000000000000000000000000000000000000,0x0000000000000000000000000000000000000000000000000000000000000000)"
MAX=115792089237316195423570985008687907853269984665640564039457584007913129639935

rpc() { cast rpc "$@" --rpc-url "$RPC" >/dev/null; }
send() { # send FROM TO SIG ARGS...
  local from="$1"
  shift
  cast send --unlocked --from "$from" --rpc-url "$RPC" "$@" >/dev/null
}
call() { cast call --rpc-url "$RPC" "$@" | awk '{ print $1 }'; }
now() { cast block latest --field timestamp --rpc-url "$RPC"; }
at() { # the next block at second $1 (only forward)
  if [ "$1" -gt "$(now)" ]; then rpc evm_setNextBlockTimestamp "$1"; fi
}
fscript() { # fscript SENDER FILE: a forge script broadcast as SENDER (impersonated)
  local sender="$1"
  shift
  forge script "$@" --rpc-url "$RPC" --broadcast --slow --non-interactive --unlocked --sender "$sender" \
    --no-storage-caching
}

say "fresh senders: impersonated and funded on the fork"
for a in $OWNER $PRIMARY $ATTESTER $DEPLOYER $MAKER $LISTER $AGUSER; do
  [ "$(cast code "$a" --rpc-url "$RPC")" = 0x ] || { echo "$a has code on the fork" >&2; exit 1; }
  rpc anvil_impersonateAccount "$a"
  rpc anvil_setBalance "$a" 0x3635C9ADC5DEA00000 # 1,000 MON on the fork only
done

say "the demo index (DeployIndex, fork-demo.json)"
AGATE_CONFIG=fork-demo fscript "$OWNER" script/DeployIndex.s.sol >"$WORK/deploy-index.log" 2>&1 ||
  { cat "$WORK/deploy-index.log" >&2; exit 1; }
INDEX="$(grep -E '^ *AgateIndex 0x' "$WORK/deploy-index.log" | awk '{ print $2 }' | tail -1)"
[ -n "$INDEX" ] && [ "$(cast code "$INDEX" --rpc-url "$RPC")" != 0x ] || { cat "$WORK/deploy-index.log" >&2; exit 1; }
START="$(call "$INDEX" 'dayStart(uint32)(uint64)' $DAY1)"
echo "AgateIndex $INDEX, day $DAY1 (2026-10-01) starts at $START"

say "the market (DeployMarket, market-fork.json, Kuru V1's Router)"
AGATE_MARKET_CONFIG=fork AGATE_INDEX_demo="$INDEX" fscript "$DEPLOYER" script/DeployMarket.s.sol \
  >"$WORK/deploy-market.log" 2>&1 || { cat "$WORK/deploy-market.log" >&2; exit 1; }
# the broadcast landed: verify() checks every address of the pending file has code, then writes the deployments file
AGATE_MARKET_CONFIG=fork forge script script/DeployMarket.s.sol --sig 'verify()' --rpc-url "$RPC" \
  --no-storage-caching >"$WORK/verify-market.log" 2>&1 || { cat "$WORK/verify-market.log" >&2; exit 1; }
[ ! -f "$DEPLOYMENTS.pending" ] || { echo "verify() left the pending file" >&2; exit 1; }
FACTORY="$(jq -r '.factories.demo.factory' "$DEPLOYMENTS")"
ROUTER="$(jq -r '.factories.demo.router' "$DEPLOYMENTS")"
DOLLAR="$(jq -r '.dollar' "$DEPLOYMENTS")"
echo "dollar $DOLLAR, factory $FACTORY, router $ROUTER"

say "readings for 2026-10-01 through the direct path, closed and attested until final"
report() { # report SLICE READAT: one slice for the three GPUs (H100 five slots; H200, B200 three live of four)
  cast abi-encode "f(uint8,uint64,address,(bytes32,uint32,uint8,uint64,uint32[])[])" 1 $SELECTOR "$INDEX" \
    "[($H100,$DAY1,$1,$2,[3600000,3600000,3600000,3600000,3600000]),($H200,$DAY1,$1,$2,[4200000,4200000,4200000,0]),($B200,$DAY1,$1,$2,[5000000,5000000,5000000,0])]"
}
for h in 0 1 2 3; do
  READ_AT=$((START + h * 150 + 25))
  at "$READ_AT"
  send "$PRIMARY" "$INDEX" 'postReport(bytes)' "$(report "$h" "$READ_AT")"
done
at $((START + 600 + 150)) # the day's end plus CLOSE_GRACE
for g in $H100 $H200 $B200; do
  send "$PRIMARY" "$INDEX" 'closeDay(bytes32)' "$g"
done
for g in $H100 $H200 $B200; do # the first record of a GPU needs the attester's countersign
  DIGEST="$(cast call --rpc-url "$RPC" "$INDEX" \
    'record(bytes32,uint32)(bool,bool,(uint32,uint8,uint8,uint8,uint8,uint32,bool,bool,bool,bool,bool,address,uint64,uint64,uint64,address,bytes32))' \
    "$g" $DAY1 | grep -oE '0x[0-9a-f]{64}' | tail -1)"
  send "$ATTESTER" "$INDEX" 'attest(bytes32,uint32,address,bytes32)' "$g" $DAY1 "$PRIMARY" "$DIGEST"
done
rpc evm_increaseTime 211 # T_PEND on the demo clock is 210 s
rpc evm_mine
for g in $H100 $H200 $B200; do
  [ "$(call "$INDEX" 'finalFix(bytes32,uint32)(bool,uint32,uint8,uint8,bool,bool)' "$g" $DAY1 | head -1)" = true ] ||
    { echo "the record of $g is not final" >&2; exit 1; }
done
echo "2026-10-01 final for H100 (3.60), H200 (4.20), B200 (5.00)"

say "ListSeries: current and next month for every GPU, with their Kuru V1 markets"
AGATE_FACTORY="$FACTORY" fscript "$LISTER" script/ListSeries.s.sol >"$WORK/list.log" 2>&1 ||
  { cat "$WORK/list.log" >&2; exit 1; }
grep -E 'listed|market created|not listable|refused' "$WORK/list.log" | sed 's/^ *//'
CUR="$(call "$FACTORY" 'currentMonth()(uint32)')"
NEXT=$((CUR + 1))
SERIES="$(call "$FACTORY" 'seriesOf(bytes32,uint32)(address)' $H100 $NEXT)"
MARKET="$(call "$FACTORY" 'marketOf(address)(address,uint8)' "$SERIES" | head -1)"
TOKEN="$(call "$SERIES" 'token()(address)')"
echo "H100 month $NEXT: series $SERIES, token $(cast call --rpc-url "$RPC" "$TOKEN" 'symbol()(string)'), market $MARKET"

say "a maker book: 1,000 tokens asked at 3.64 and bid at 3.60, from Kuru's MarginAccount"
send "$MAKER" "$DOLLAR" 'approve(address,uint256)' "$SERIES" $MAX
send "$MAKER" "$SERIES" 'mint(uint256,address)' 2000000000 "$MAKER"
send "$MAKER" "$TOKEN" 'approve(address,uint256)' $MARGIN $MAX
send "$MAKER" "$DOLLAR" 'approve(address,uint256)' $MARGIN $MAX
send "$MAKER" $MARGIN 'deposit(address,address,uint256)' "$MAKER" "$TOKEN" 2000000000
send "$MAKER" $MARGIN 'deposit(address,address,uint256)' "$MAKER" "$DOLLAR" 10000000000
send "$MAKER" "$MARKET" 'addSellOrder(uint32,uint96,bool)' 3640000 10000000 false
send "$MAKER" "$MARKET" 'addBuyOrder(uint32,uint96,bool)' 3600000 10000000 false

say "a user: the faucet, then openShort (100 tokens) and openLong (364 tUSD) through the router"
send "$AGUSER" "$DOLLAR" 'drip()'
send "$AGUSER" "$DOLLAR" 'approve(address,uint256)' "$ROUTER" $MAX
D0="$(call "$DOLLAR" 'balanceOf(address)(uint256)' "$AGUSER")"
send "$AGUSER" "$ROUTER" 'openShort(address,uint256,uint256,uint256,address,bool,(uint256,uint256,uint8,bytes32,bytes32))' \
  "$SERIES" 100000000 1 1 "$AGUSER" true "$NOPERMIT"
D1="$(call "$DOLLAR" 'balanceOf(address)(uint256)' "$AGUSER")"
OWNER1="$(cast call --rpc-url "$RPC" "$SERIES" 'position(uint256)((address,uint8,bool,uint8,address,uint64,address,uint96))' 1 | tr -d '(' | cut -d, -f1)"
echo "openShort: the user paid $((D0 - D1)) u net (720 tUSD in, the sale at 3.60 back); position 1 belongs to $OWNER1"
[ "$OWNER1" = "$AGUSER" ] || { echo "position 1 is not the user's" >&2; exit 1; }
send "$AGUSER" "$ROUTER" 'openLong(address,uint256,uint256,(uint256,uint256,uint8,bytes32,bytes32))' \
  "$SERIES" 364000000 100000000 "$NOPERMIT"
echo "openLong: the user holds $(call "$TOKEN" 'balanceOf(address)(uint256)' "$AGUSER") token base units"

say "the router holds nothing (wallet, short, Kuru's MarginAccount)"
for v in "$(call "$DOLLAR" 'balanceOf(address)(uint256)' "$ROUTER")" \
  "$(call "$TOKEN" 'balanceOf(address)(uint256)' "$ROUTER")" \
  "$(call "$SERIES" 'shortOf(address)(uint256)' "$ROUTER")" \
  "$(call $MARGIN 'getBalance(address,address)(uint256)' "$ROUTER" "$DOLLAR")" \
  "$(call $MARGIN 'getBalance(address,address)(uint256)' "$ROUTER" "$TOKEN")"; do
  [ "$v" = 0 ] || { echo "the router holds $v" >&2; exit 1; }
done
echo "0 / 0 / 0 / 0 / 0"

say "deployments JSON (fork block $FORK_BLOCK)"
cat "$DEPLOYMENTS"
echo
say "dress rehearsal passed"
