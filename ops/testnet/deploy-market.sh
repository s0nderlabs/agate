#!/usr/bin/env bash
# Deploys the market on Monad testnet with the deployer key (agate.deployer), then verify() writes the deployments
# file the bots, the indexer and the app read.
#
#   ops/testnet/deploy-market.sh production [--dry-run] [--fork]
#   ops/testnet/deploy-market.sh demo [--dry-run] [--fork]
#
# production: the real-calendar index from contracts/deployments/10143-indexes.json goes into the "real" factory of a
#   copy of market-testnet.json (the demo entry disabled), then DeployMarket: the test dollar (tUSD) and the market
#   maker's float (first run only) and the real factory with its router.
# demo: the active demo session's index (deploy-index.sh testnet-demo first). A demo factory of an earlier session
#   (another index) is moved out of the deployments file into 10143-demo-history.json, then DeployMarket runs on a
#   copy of market-testnet.json with the demo entry enabled for this index (the real factory, if deployed, is reused
#   untouched; the dollar is reused).
# market-testnet.json itself stays as committed (a test pins its bytes): the copy, contracts/script/config/
# market-kit-<production|demo>.json, lives for the run only; the addresses that landed are in 10143.json.
#
# Each run: a read-only simulation (plan and gas), the signed broadcast, then DeployMarket verify(), which writes
# contracts/deployments/10143.json only once every address has code. Idempotent: DeployMarket reuses every address
# that landed; after a cut-off run, run this again.
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

usage() {
  echo "usage: $0 <production|demo> [--dry-run] [--fork]" >&2
  exit 2
}
kit_parse "$@"
[ "${#KIT_POS[@]}" = 1 ] || usage
KIND="${KIT_POS[0]}"
case "$KIND" in production | demo) ;; *) usage ;; esac
need_tools forge cast jq
check_fork
[ -z "${AGATE_KIT_DEPLOYMENTS:-}" ] || [ "$KIT_DRY" = 1 ] || die "DeployMarket writes the deployments file where its config names it: unset AGATE_KIT_DEPLOYMENTS"

BASE="$CONTRACTS/script/config/market-testnet.json"
DEPLOYER="$(role_addr deployer)"
lc() { tr 'A-F' 'a-f'; }
say "deploy-market $KIND: $(kit_mode_line)"
note "deployer $DEPLOYER (Keychain $(role_svc deployer)), deployments $KIT_DEPLOYMENTS"

PROD_IX="$(records_get .production.index)"
[ "$(records_get .production.status)" = deployed ] || PROD_IX=""
if [ -n "$PROD_IX" ] && ! offline && ! has_code "$PROD_IX"; then die "the recorded production index $PROD_IX has no code"; fi

# ------------------------------------------------------------------ the config DeployMarket reads
RUN_CFG=""
cleanup() { if [ -n "$RUN_CFG" ] && [ "$KIT_DRY" = 0 ]; then rm -f "$RUN_CFG"; fi; }
trap cleanup EXIT

if [ "$KIND" = production ]; then
  if [ -z "$PROD_IX" ]; then
    [ "$KIT_DRY" = 1 ] || die "no deployed production index in $KIT_RECORDS: run deploy-index.sh testnet-production first"
    PROD_IX="0x(the production index deploy-index.sh records)"
    note "(dry run: no production index recorded yet; shown as $PROD_IX)"
  fi
  if [ "$KIT_FORK" = 1 ]; then RUN_CFG="$CONTRACTS/script/config/market-kit-fork-production.json"; else RUN_CFG="$CONTRACTS/script/config/market-kit-production.json"; fi
  show "write $RUN_CFG (market-testnet.json with the real factory on $PROD_IX, the demo entry disabled$([ "$KIT_FORK" = 1 ] && echo ", deploymentsFile $(basename "$KIT_DEPLOYMENTS")"))"
  if [ "$KIT_DRY" = 0 ]; then
    jq --arg ix "$PROD_IX" --arg f "$(basename "$KIT_DEPLOYMENTS")" --argjson fork "$KIT_FORK" '
      (if $fork == 1 then .deploymentsFile = $f else . end)
      | .factories |= map(
          if .name == "real" then .index = $ix
          elif .name == "demo" then .enabled = false
          else . end)' "$BASE" >"$RUN_CFG"
  fi
  export AGATE_MARKET_CONFIG="$(basename "$RUN_CFG" .json | sed 's/^market-//')"
else
  DEMO_IX="$(records_get .demo.index)"
  if [ -z "$DEMO_IX" ] || [ "$(records_get .demo.status)" != deployed ] || [ "$(records_get .demo.session)" != active ]; then
    [ "$KIT_DRY" = 1 ] || die "no active demo index in $KIT_RECORDS: run deploy-index.sh testnet-demo first"
    DEMO_IX="0x(the demo index deploy-index.sh records)"
    note "(dry run: no active demo index recorded yet; shown as $DEMO_IX)"
  elif ! offline && ! has_code "$DEMO_IX"; then
    die "the demo index $DEMO_IX has no code"
  fi
  # an earlier session's demo factory (another index) leaves the deployments file first
  for f in "$KIT_DEPLOYMENTS" "$KIT_DEPLOYMENTS.pending"; do
    [ -f "$f" ] || continue
    OLD="$(jq -r '.factories.demo.index // empty' "$f")"
    if [ -n "$OLD" ] && [ "$(echo "$OLD" | lc)" != "$(echo "$DEMO_IX" | lc)" ]; then
      show "move factories.demo (index $OLD) from $(basename "$f") into $(basename "$KIT_DEMO_HISTORY")"
      if [ "$KIT_DRY" = 0 ]; then
        [ -f "$KIT_DEMO_HISTORY" ] || echo '{ "chainId": 10143, "demo": [] }' >"$KIT_DEMO_HISTORY"
        jq --slurpfile d "$f" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '.demo += [$d[0].factories.demo + {movedAt: $at}]' \
          "$KIT_DEMO_HISTORY" >"$KIT_DEMO_HISTORY.tmp" && mv "$KIT_DEMO_HISTORY.tmp" "$KIT_DEMO_HISTORY"
        jq 'del(.factories.demo)' "$f" >"$f.tmp" && mv "$f.tmp" "$f"
      fi
    fi
  done
  if [ "$KIT_FORK" = 1 ]; then RUN_CFG="$CONTRACTS/script/config/market-kit-fork-demo.json"; else RUN_CFG="$CONTRACTS/script/config/market-kit-demo.json"; fi
  show "write $RUN_CFG (market-testnet.json with the demo entry enabled on $DEMO_IX$([ -n "$PROD_IX" ] && echo ", the real factory's index $PROD_IX" || echo ', the real entry disabled: no production index yet'))"
  if [ "$KIT_DRY" = 0 ]; then
    jq --arg dx "$DEMO_IX" --arg px "$PROD_IX" --arg f "$(basename "$KIT_DEPLOYMENTS")" --argjson fork "$KIT_FORK" '
      (if $fork == 1 then .deploymentsFile = $f else . end)
      | .factories |= map(
          if .name == "demo" then .index = $dx | .enabled = true
          elif .name == "real" then (if $px == "" then .enabled = false else .index = $px end)
          else . end)' "$BASE" >"$RUN_CFG"
  fi
  export AGATE_MARKET_CONFIG="$(basename "$RUN_CFG" .json | sed 's/^market-//')"
fi
note "AGATE_MARKET_CONFIG=$AGATE_MARKET_CONFIG"

# ------------------------------------------------------------------ simulate, broadcast, verify
say "deployer balance: $(balance_mon "$DEPLOYER") MON"
LOGS="$KIT_STATE/logs"
[ "$KIT_DRY" = 1 ] || mkdir -p "$LOGS"
say "simulation (read only; writes nothing)"
if [ "$KIT_DRY" = 1 ]; then
  forge_read script/DeployMarket.s.sol --sender "$DEPLOYER" --non-interactive
else
  impersonate "$DEPLOYER"
  forge_read script/DeployMarket.s.sol --sender "$DEPLOYER" --non-interactive >"$LOGS/deploy-market-$KIND-sim.log" 2>&1 || {
    tail -40 "$LOGS/deploy-market-$KIND-sim.log" >&2
    die "the simulation failed: nothing sent"
  }
  sed -n '/== Logs ==/,/^$/p' "$LOGS/deploy-market-$KIND-sim.log" | sed 's/^/   /'
  grep -E 'Estimated (total gas used|amount required)' "$LOGS/deploy-market-$KIND-sim.log" | sed 's/^/   /' || true
fi

say "broadcast, signed by the deployer"
if [ "$KIT_DRY" = 1 ]; then
  forge_send deployer AGATE_DEPLOYER_KEY script/DeployMarket.s.sol
else
  rc=0
  STARTED="$(date +%s)"
  NONCE0="$(nonce_of "$DEPLOYER")"
  forge_send deployer AGATE_DEPLOYER_KEY script/DeployMarket.s.sol >"$LOGS/deploy-market-$KIND.log" 2>&1 || rc=$?
  sed -n '/== Logs ==/,/^$/p' "$LOGS/deploy-market-$KIND.log" | sed 's/^/   /'
  if [ "$rc" != 0 ]; then
    tail -40 "$LOGS/deploy-market-$KIND.log" >&2
    die "the broadcast failed (exit $rc); rerun this script: DeployMarket reuses what landed (log $LOGS/deploy-market-$KIND.log)"
  fi
  SENT=$(($(nonce_of "$DEPLOYER") - NONCE0))
  RUN_JSON="$FOUNDRY_BROADCAST/DeployMarket.s.sol/$CHAIN_ID/run-latest.json"
  if [ "$SENT" = 0 ]; then
    note "nothing sent: every address of this plan already has code (DeployMarket reused them)"
  elif [ -f "$RUN_JSON" ] && [ "$(stat -f %m "$RUN_JSON")" -ge "$STARTED" ]; then
    set -- $(gas_of "$RUN_JSON")
    note "$1 transactions: gas limits $2 (billed on Monad: $(mon "$2") MON at $GAS_GWEI gwei), gas used $3"
  else
    note "$SENT transaction(s) sent (forge's broadcast file of this run is missing: no gas figures)"
  fi
fi

say "verify(): every address must have code before the deployments file is written"
if [ "$KIT_DRY" = 1 ]; then
  forge_read script/DeployMarket.s.sol --sig 'verify()'
  exit 0
fi
forge_read script/DeployMarket.s.sol --sig 'verify()' >"$LOGS/deploy-market-$KIND-verify.log" 2>&1 || {
  tail -30 "$LOGS/deploy-market-$KIND-verify.log" >&2
  die "verify() refused: rerun this script (DeployMarket reuses what landed), then it verifies again"
}
[ -f "$KIT_DEPLOYMENTS" ] && [ ! -f "$KIT_DEPLOYMENTS.pending" ] || die "verify() left no deployments file or left the pending one"

say "deployments ($KIT_DEPLOYMENTS)"
jq . "$KIT_DEPLOYMENTS"
for n in $(jq -r '.factories | keys[]' "$KIT_DEPLOYMENTS"); do
  F="$(jq -r ".factories.$n.factory" "$KIT_DEPLOYMENTS")"
  IXF="$(rcall "$F" 'index()(address)')"
  [ "$(echo "$IXF" | lc)" = "$(jq -r ".factories.$n.index" "$KIT_DEPLOYMENTS" | lc)" ] || die "factory $n reads index $IXF"
  note "factory $n $F: index $IXF, router $(rcall "$F" 'router()(address)'), GPUs $(rcall "$F" 'gpuIds()(bytes32[])' | tr -d '[]' | tr ',' '\n' | wc -l | tr -d ' ')"
done
if [ "$KIND" = demo ]; then
  [ "$(jq -r '.factories.demo.index' "$KIT_DEPLOYMENTS" | lc)" = "$(echo "$DEMO_IX" | lc)" ] || die "the deployments file's demo factory is not on the demo index"
fi
say "market $KIND deployed and verified"
