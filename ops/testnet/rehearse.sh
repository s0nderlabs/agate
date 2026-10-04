#!/usr/bin/env bash
# The kit's dress rehearsal on local anvil forks of Monad testnet: the same scripts the testnet deploy runs, with
# --fork. Nothing reaches Monad testnet: every chain is a loopback anvil started through wall/scripts/anvil-safe.sh,
# and every sender is impersonated on the fork (no key is read).
#
#   ops/testnet/rehearse.sh deploy            the real configs and the real role addresses: both indexes, both
#                                             factories, fund.sh --send, then index days written as the real writers
#                                             while the fork's clock runs forward, and the lister's real path (the payer
#                                             app's list-once) lists November (SEEDED) and December (RULE) of the real
#                                             factory with their Kuru V1 markets
#   ops/testnet/rehearse.sh session [minutes] (default 40) a demo session's processes against a fork with 1 s blocks:
#                                             rehearsal roles (public keys from labels, AGATE_KIT_ROLES=rehearsal),
#                                             the production index and market, up.sh production, demo-session.sh
#                                             start, then a status print every 5 minutes; at the end it checks that
#                                             the maker and the payer started on market-gas-limits.json and that the
#                                             production windows' logs start with their wait line, then
#                                             demo-session.sh stop, down.sh production
#
# Refuses under AGATE_ANVIL_MIN_FREE_GB GB free (default 30). Processes run in a private tmux server
# (tmux -L agate-rehearsal), never the dev session; the indexer window needs Podman or Docker running
# (AGATE_KIT_INDEXER=0 leaves it out, beside another indexer). Everything the run starts is stopped when it exits; the
# fork-kit-* records and deployments files are moved to the state dir ($AGATE_KIT_STATE, default
# ~/.agate-kit-rehearsal/<mode>-<time>). A fork never uses Alchemy: with AGATE_KIT_ALCHEMY_TEST_URL=<loopback URL> (a
# counting proxy in front of the fork, say) the session's light roles send through that stand-in instead, and the
# attester and the keeper subscribe through its ws:// twin.
set -euo pipefail
MODE="${1:-}"
MINUTES="${2:-40}"
case "$MODE" in deploy | session) ;; *) echo "usage: $0 <deploy|session [minutes]>" >&2; exit 2 ;; esac
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SAFE="$ROOT/wall/scripts/anvil-safe.sh"
PORT="${AGATE_FORK_PORT:-8549}"
RPC="http://127.0.0.1:$PORT"
UPSTREAM="${AGATE_FORK_UPSTREAM:-https://testnet-rpc.monad.xyz}"
MIN_GB="${AGATE_ANVIL_MIN_FREE_GB:-30}"
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1
export AGATE_KIT_FORK_RPC="$RPC"
export AGATE_KIT_STATE="${AGATE_KIT_STATE:-$HOME/.agate-kit-rehearsal/$MODE-$(date +%Y%m%d-%H%M%S)}"
export AGATE_KIT_TMUX_SOCKET=agate-rehearsal
export AGATE_KIT_TMUX_SESSION=rehearsal
DEP="$ROOT/contracts/deployments"
mkdir -p "$AGATE_KIT_STATE/logs"

say() { printf '\n== %s\n' "$*"; }
free_gb() { df -Pk / | awk 'NR==2 { print int($4 / 1048576) }'; }
for f in fork-kit-10143-indexes.json fork-kit-10143.json fork-kit-10143-demo-history.json fork-kit-fork.json; do
  [ ! -e "$DEP/$f" ] || { echo "$DEP/$f exists: another rehearsal runs, or one left it (move it away first)" >&2; exit 1; }
done
say "disk before: $(df -h / | awk 'NR==2 { print $4 }') free; ~/.foundry/anvil/tmp $(du -sh "$HOME/.foundry/anvil/tmp" 2>/dev/null | cut -f1)"
[ "$(free_gb)" -ge "$MIN_GB" ] || { echo "only $(free_gb) GB free (floor $MIN_GB GB): not starting anvil" >&2; exit 1; }

SAFE_PID=""
cleanup() {
  status=$?
  set +e
  if [ "$MODE" = session ]; then
    AGATE_KIT_ROLES=rehearsal "$HERE/demo-session.sh" stop --fork >/dev/null 2>&1
    AGATE_KIT_ROLES=rehearsal "$HERE/down.sh" production --fork --shared >/dev/null 2>&1
    # the indexer's Postgres and Hasura containers outlive its window: removed with their database
    [ "${AGATE_KIT_INDEXER:-1}" = 0 ] || "$HERE/indexer.sh" stop --fork >/dev/null 2>&1
  fi
  tmux -L agate-rehearsal kill-server 2>/dev/null
  if [ -n "$SAFE_PID" ]; then
    kill "$SAFE_PID" 2>/dev/null
    wait "$SAFE_PID" 2>/dev/null
  fi
  for f in fork-kit-10143-indexes.json fork-kit-10143.json fork-kit-10143-demo-history.json fork-kit-10143.json.pending fork-kit-fork.json; do
    [ -e "$DEP/$f" ] && mv "$DEP/$f" "$AGATE_KIT_STATE/"
  done
  rm -f "$ROOT"/contracts/script/config/kit-fork-*.json "$ROOT"/contracts/script/config/market-kit-*.json
  say "after: $(df -h / | awk 'NR==2 { print $4 }') free; ~/.foundry/anvil/tmp $(du -sh "$HOME/.foundry/anvil/tmp" 2>/dev/null | cut -f1); records in $AGATE_KIT_STATE"
  pgrep -f "anvil --prune-history .*--port $PORT" >/dev/null && { echo "an anvil on port $PORT is still running" >&2; status=1; }
  exit "$status"
}
trap cleanup EXIT
trap 'exit 143' INT TERM HUP

say "fork of $UPSTREAM on port $PORT (anvil-safe)"
if [ "$MODE" = session ]; then
  # one-second blocks keep the chain's clock with the processes' clocks; 600 states kept for forge's pinned reads
  "$SAFE" 600 --fork-url "$UPSTREAM" --code-size-limit 131072 --port "$PORT" --slots-in-an-epoch 1 --block-time 1 >"$AGATE_KIT_STATE/logs/anvil.log" 2>&1 &
else
  "$SAFE" --fork-url "$UPSTREAM" --code-size-limit 131072 --port "$PORT" --slots-in-an-epoch 1 >"$AGATE_KIT_STATE/logs/anvil.log" 2>&1 &
fi
SAFE_PID=$!
for _ in $(seq 1 120); do
  cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break
  kill -0 "$SAFE_PID" 2>/dev/null || { cat "$AGATE_KIT_STATE/logs/anvil.log" >&2; exit 1; }
  sleep 1
done
echo "chain $(cast chain-id --rpc-url "$RPC"), fork block $(cast block-number --rpc-url "$RPC")"

if [ "$MODE" = deploy ]; then
  "$HERE/deploy-index.sh" testnet-production --fork
  "$HERE/deploy-index.sh" testnet-demo --fork
  "$HERE/deploy-market.sh" production --fork
  "$HERE/deploy-market.sh" demo --fork
  "$HERE/fund.sh" --fork --send
  PX="$(jq -r .production.index "$DEP/fork-kit-10143-indexes.json")"
  FD="$(jq -r .production.firstDay "$DEP/fork-kit-10143-indexes.json")"
  # the lister: a rehearsal key (list and createMarket are open to anyone; the real payer key has no key here)
  PAYER=0xe1eCba46ecaeba115f92F15C066FBE5335c409Ee
  cast rpc anvil_setBalance "$PAYER" 0x56BC75E2D63100000 --rpc-url "$RPC" >/dev/null
  lister() {
    (cd "$ROOT/wall" && env -i HOME="$HOME" PATH="$PATH" FOUNDRY_DISABLE_NIGHTLY_WARNING=1 \
      AGATE_KEY_CMD="cast keccak 'agate kit rehearsal payer'" AGATE_RPC_URLS="$RPC,http://localhost:$PORT" \
      AGATE_CHAIN_ID=10143 AGATE_DEPLOYMENTS="$DEP/fork-kit-10143.json" AGATE_WALL_HOME="$AGATE_KIT_STATE/wall" \
      AGATE_MARKET_GAS_LIMITS="$(jq -c . "$HERE/market-gas-limits.json")" bun run apps/payer/src/main.ts list-once) | tee -a "$AGATE_KIT_STATE/logs/lister.log" | grep -E '"event":"(listed|market_created|done)"'
  }
  say "the first day ($FD) written and final, then the lister"
  bun run "$HERE/rehearse/days.ts" --rpc "$RPC" --index "$PX" --to "$FD"
  lister
  say "every day to Oct 31 (20757) written and final, then the lister on Nov 1"
  bun run "$HERE/rehearse/days.ts" --rpc "$RPC" --index "$PX" --to 20757 | tail -2
  lister
  F="$(jq -r .factories.real.factory "$DEP/fork-kit-10143.json")"
  n=0
  for g in $(jq -r '.gpus[].gpuId' "$ROOT/contracts/script/config/market-testnet.json"); do
    for m in 24322 24323; do
      S="$(cast call "$F" 'seriesOf(bytes32,uint32)(address)' "$g" "$m" --rpc-url "$RPC")"
      V="$(cast call "$F" 'marketOf(address)(address,uint8)' "$S" --rpc-url "$RPC" | tail -1)"
      T="$(cast call "$S" 'token()(address)' --rpc-url "$RPC")"
      echo "$(cast call "$T" 'symbol()(string)' --rpc-url "$RPC") series $S venue $V"
      [ "$V" = 1 ] && n=$((n + 1))
    done
  done
  [ "$n" = 6 ] || { echo "only $n of 6 series have a Kuru V1 market" >&2; exit 1; }
  say "deploy rehearsal passed: November and December listed on the real factory with Kuru V1 markets"
  exit 0
fi

# ------------------------------------------------------------------ session
export AGATE_KIT_ROLES=rehearsal
"$HERE/deploy-index.sh" testnet-production --fork
"$HERE/deploy-market.sh" production --fork
"$HERE/fund.sh" --fork --send
# the maker's float went to the real maker address; the rehearsal maker takes it over
DOL="$(jq -r .dollar "$DEP/fork-kit-10143.json")"
cast rpc anvil_impersonateAccount 0xBFAa70A8b399097FACF4A84B98Da5B304587C8B8 --rpc-url "$RPC" >/dev/null
cast send --unlocked --from 0xBFAa70A8b399097FACF4A84B98Da5B304587C8B8 "$DOL" 'transfer(address,uint256)' \
  0x9A410E49A53115E85b751fE8D3b589bb8F1a717F 10000000000000 --rpc-url "$RPC" >/dev/null
"$HERE/up.sh" production --fork
"$HERE/demo-session.sh" start --fork --hours 1
FROM="$(jq -r .demo.deployBlock "$DEP/fork-kit-10143-indexes.json")"
END=$(($(date +%s) + MINUTES * 60))
while [ "$(date +%s)" -lt "$END" ]; do
  sleep 300
  bun run "$HERE/rehearse/status.ts" "$RPC" "$DEP/fork-kit-10143-indexes.json" "$DEP/fork-kit-10143.json" "$FROM" |
    tee "$AGATE_KIT_STATE/status.json" | jq -c '{at, demoDayNow, head, posts: .postsByWriter, closed: (.closedDays | length), attested: (.attestedDays | length), listed: (.listed | length), markets: .marketsRecorded}'
done
# the market bots started on the kit's gas limits file, and each window's log holds its launcher's first line
L="$AGATE_KIT_STATE/logs"
for w in shared-maker shared-payer; do
  grep -q '"gasLimits":"AGATE_MARKET_GAS_LIMITS"' "$L/$w.log" || { echo "$w did not start on AGATE_MARKET_GAS_LIMITS" >&2; exit 1; }
done
for w in prod-primary prod-standby prod-health; do
  head -1 "$L/$w.log" | grep -q "waits until" || { echo "$w.log does not start with its wait line" >&2; exit 1; }
done
say "session rehearsal: final status in $AGATE_KIT_STATE/status.json"
