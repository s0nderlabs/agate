#!/usr/bin/env bash
# Deploys one AgateIndex on Monad testnet with the owner key (agate.wall.owner) and records it.
#
#   ops/testnet/deploy-index.sh testnet-production [--dry-run] [--fork]
#   ops/testnet/deploy-index.sh testnet-demo [--new] [--dry-run] [--fork]
#
# testnet-production: the real-calendar index. firstDay is the UTC day after the deploy (written into the config
#   first), so no backfill is needed and the watcher logger, running since before that day began, has logged it whole.
#   Refused within 15 minutes of 00:00 UTC (the deploy could land on the other side of midnight).
# testnet-demo: the demo-clock index of one demo session (day 1 = 2026-11-01 starts at the deploy block). An active
#   session's index is reused; --new (or a session marked stopped) deploys a fresh one and moves the old record into
#   demoHistory.
#
# Steps: a read-only simulation (the predicted address and gas), the address recorded as pending with the current
# block (pendingBlock), the signed broadcast (DeployIndex.s.sol: four libraries, the index, six registerGpu), the record
# (address, deploy block, firstDay, clocks) in contracts/deployments/10143-indexes.json, then checks by eth_call: code,
# clocks, roles, forwarder, and every GPU's recipeHash, slot count and firstDay against panels/launch.json.
# Idempotent: a recorded index with code is never deployed again; a deploy cut off after the index landed resumes with
# the GPUs that are missing (registerGpu, owner key). The deploy block is the creation transaction's block (its receipt,
# from forge's broadcast files or read from the chain by its hash), else pendingBlock (a lower bound), never a later
# block; with neither, the script stops. Nothing is sent when a check fails before the broadcast.
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

usage() {
  echo "usage: $0 <testnet-production|testnet-demo> [--new] [--dry-run] [--fork]" >&2
  exit 2
}
NEW=0
args=()
for a in "$@"; do
  case "$a" in
    --new) NEW=1 ;;
    *) args+=("$a") ;;
  esac
done
kit_parse ${args[@]+"${args[@]}"}
[ "${#KIT_POS[@]}" = 1 ] || usage
NAME="${KIT_POS[0]}"
case "$NAME" in
  testnet-production) KIND=production ;;
  testnet-demo) KIND=demo ;;
  *) usage ;;
esac
need_tools forge cast jq bun
check_fork

CFG="$CONTRACTS/script/config/$NAME.json"
[ -f "$CFG" ] || die "$CFG is missing"
OWNER="$(role_addr owner)"
say "deploy-index $NAME: $(kit_mode_line)"
note "owner $OWNER (Keychain $(role_svc owner)), records $KIT_RECORDS"

# The config registers launch.json's six GPUs exactly (read only).
show "(cd wall && bun run packages/sources/scripts/deploy-gpus.ts $NAME --check)"
(cd "$WALL" && bun run packages/sources/scripts/deploy-gpus.ts "$NAME" --check) || die "$NAME.json does not register panels/launch.json: run deploy-gpus.ts $NAME"

prof() { jq -r ".profile.$1" "$CFG"; }
report_deploy_block() {
  if [ "$DEPLOY_BLOCK_FROM" = receipt ]; then
    note "created in block $DEPLOY_BLOCK (the creation transaction's receipt)"
  else
    warn "no receipt of the index's creation in forge's broadcast files: recording block $DEPLOY_BLOCK, read just before the broadcast (the index was created after it, so a scan from it misses none of its events)"
  fi
}
DAY="$(prof day)"
SLICES="$(prof slices)"
EPOCH_DAY="$(prof epochDay)"

check_index() { # sets C_* and MISSING (indexes into .gpus of the config)
  has_code "$IX" || die "no code at $IX"
  local clk
  clk="$(rcall "$IX" 'clocks()((uint32,uint32,uint32,uint32,uint32,uint32,uint32,uint32,uint32,uint32,uint8,uint8,uint8,bool,bool,uint64,uint32,uint64))' | plain)"
  set -- $clk
  C_DAY="$1" C_SLICE="$2" C_TPEND="$3" C_SLICES="${11}" C_MINR="${12}" C_QMIN="${13}" C_EPOCHTS="${16}" C_EPOCHDAY="${17}" C_SEL="${18}"
  [ "$C_DAY" = "$DAY" ] && [ "$C_SLICES" = "$SLICES" ] && [ "$C_MINR" = "$(prof minReadings)" ] && [ "$C_QMIN" = "$(prof qMin)" ] &&
    [ "$C_EPOCHDAY" = "$EPOCH_DAY" ] || die "clocks() ($clk) do not match $NAME.json"
  [ "$C_SEL" = "$(grep -oE '"chainSelector": [0-9]+' "$CFG" | awk '{ print $2 }')" ] || die "the chain selector $C_SEL differs from $NAME.json"
  note "clocks: day $C_DAY s, slice $C_SLICE s, tPend $C_TPEND s, slices $C_SLICES, minReadings $C_MINR, qMin $C_QMIN, epochTs $C_EPOCHTS, epochDay $C_EPOCHDAY"
  [ "$(rcall "$IX" 'owner()(address)' | lc)" = "$(role_addr_real owner | lc)" ] || die "owner() is not $(role_addr_real owner)"
  local wr gu fw
  wr="$(rcall "$IX" 'writers()(address[2])' | lc)"
  [ "$wr" = "[$(want_role primary | lc), $(want_role standby | lc)]" ] || die "writers() is $wr"
  [ "$(rcall "$IX" 'attester()(address)' | lc)" = "$(want_role attester | lc)" ] || die "attester() differs from the config"
  gu="$(rcall "$IX" 'guardians()(address[2])' | lc)"
  [ "$gu" = "[$(role_addr_real guardian | lc), 0x0000000000000000000000000000000000000000]" ] || die "guardians() is $gu"
  fw="$(rcall "$IX" 'forwarder()(address,uint8)' | lc | tr '\n' ' ')"
  [ "$fw" = "$(echo "$CRE_SIM_FORWARDER" | lc) 0 " ] || die "forwarder() is $fw, expected the CRE simulation forwarder in TX_ORIGIN mode"
  note "roles: owner $(role_addr_real owner), writers $wr, attester $(want_role attester), guardian0 $(role_addr_real guardian)"
  note "forwarder $CRE_SIM_FORWARDER in TX_ORIGIN mode"
  MISSING=()
  local n i g id rh ns gc
  n="$(jq '.gpus | length' "$CFG")"
  i=0
  while [ "$i" -lt "$n" ]; do
    g="$(jq -r ".gpus[$i].gpu" "$CFG")"
    id="$(jq -r ".gpus[$i].gpuId" "$CFG")"
    rh="$(jq -r ".gpus[$i].recipeHash" "$CFG" | lc)"
    ns="$(jq ".gpus[$i].family | length" "$CFG")"
    [ "$(jq -r --arg g "$g" '.deploy[] | select(.gpu == $g) | .recipeHash' "$PANELS" | lc)" = "$rh" ] || die "$g: the config's recipeHash is not launch.json's"
    [ "$(jq -r --arg g "$g" '.deploy[] | select(.gpu == $g) | .gpuId' "$PANELS" | lc)" = "$(echo "$id" | lc)" ] || die "$g: the config's gpuId is not launch.json's"
    gc="$(rcall "$IX" 'gpu(bytes32)((bytes32,uint8,uint8,uint32,uint64,uint64,uint32))' "$id" | plain)"
    set -- $gc
    if [ "$2" = 0 ]; then
      note "$g: NOT registered"
      MISSING+=("$i")
    else
      [ "$(echo "$1" | lc)" = "$rh" ] && [ "$2" = "$ns" ] && [ "$4" = "$FIRST_DAY" ] ||
        die "$g: gpu() is ($gc), expected recipeHash $rh, $ns slots, firstDay $FIRST_DAY"
      note "$g: registered, recipeHash $(echo "$rh" | cut -c1-14)..., $ns slots, firstDay $4, head $7"
    fi
    i=$((i + 1))
  done
}

# ------------------------------------------------------------------ an index already recorded?
IX=""
FIRST_DAY=""
REC_IX="$(records_get ".$KIND.index")"
REC_STATUS="$(records_get ".$KIND.status")"
REC_CODE=none
if [ -n "$REC_IX" ]; then
  # fail closed: an RPC error is never read as "no code" (that would deploy a second index over a live record)
  REC_CODE="$(code_state "$REC_IX")" || die "could not read the code at the recorded index $REC_IX (RPC error): nothing sent; run again"
fi
if [ -n "$REC_IX" ] && [ "$REC_STATUS" = pending ] && [ "$REC_CODE" = code ]; then
  # an earlier run's broadcast landed the index but stopped before recording it: check it is this config's index, then
  # record it (another config's index can land at the predicted address: the libraries are reused through CREATE2)
  IX="$REC_IX"
  say "the pending index $IX of an earlier run has code: checking it is $NAME's index, then recording it"
  check_index
  deploy_block_of "$IX" "$KIND"
  [ -n "$DEPLOY_BLOCK" ] || die "the index $IX has code, but the block it was created in is unknown: forge's broadcast files in $FOUNDRY_BROADCAST/DeployIndex.s.sol/$CHAIN_ID hold no receipt or creation transaction of it, and the record has no pendingBlock. Nothing recorded: find the block of the owner's transaction that created $IX, then record it with jq (.$KIND.deployBlock = <block>, .$KIND.status = \"deployed\") in $KIT_RECORDS and rerun"
  report_deploy_block
  records_put ".$KIND.status = \"deployed\" | .$KIND.deployBlock = (\$b | tonumber) | .$KIND.deployBlockFrom = \$from" --arg b "$DEPLOY_BLOCK" --arg from "$DEPLOY_BLOCK_FROM"
  # a demo index recorded as deployed belongs to the active session from now on, so a cut-off start resumes it
  if [ "$KIND" = demo ]; then records_put '.demo.session = "active"'; fi
  FIRST_DAY="$(records_get ".$KIND.firstDay")"
elif [ -n "$REC_IX" ] && [ "$REC_CODE" = code ]; then
  if [ "$KIND" = production ]; then
    IX="$REC_IX"
    say "already deployed: $IX (status ${REC_STATUS:-?}); nothing is sent, checking it"
  elif [ "$NEW" = 0 ] && [ "$(records_get ".demo.session")" = active ]; then
    IX="$REC_IX"
    say "the active demo session's index $IX is reused (--new deploys a fresh one); checking it"
  else
    say "the demo index $REC_IX is moved to demoHistory; a fresh one is deployed"
    records_put '.demoHistory = ((.demoHistory // []) + [.demo + {movedAt: $at}]) | del(.demo)' --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  fi
  if [ -n "$IX" ]; then FIRST_DAY="$(records_get ".$KIND.firstDay")"; fi
elif [ -n "$REC_IX" ] && [ "$REC_STATUS" = pending ]; then
  say "the pending index $REC_IX of an earlier run has no code: that broadcast never landed; deploying again"
fi

# ------------------------------------------------------------------ deploy
if [ -z "$IX" ]; then
  NOW="$(chain_now)"
  if [ "$KIND" = production ]; then
    TODAY=$((NOW / 86400))
    FIRST_DAY=$((TODAY + 1))
    LEFT=$((FIRST_DAY * 86400 - NOW))
    note "chain time $(utc_date "$NOW"); firstDay $FIRST_DAY ($(day_date "$FIRST_DAY")), which starts in $((LEFT / 60)) min"
    [ "$LEFT" -ge 900 ] || die "within 15 minutes of 00:00 UTC the deploy could land on the other side of midnight: run it after 00:15 UTC"
  else
    FIRST_DAY="$(prof firstDay)"
    [ "$FIRST_DAY" = "$EPOCH_DAY" ] || die "testnet-demo.json: firstDay must equal epochDay"
    note "demo clock: day $FIRST_DAY ($(day_date "$FIRST_DAY")) starts at the deploy block; a ${DAY}-second day, $SLICES slices"
  fi

  # The config forge reads: the real file (production gets firstDay written in), or on a fork a copy beside it.
  if [ "$KIT_FORK" = 1 ]; then
    RUN_NAME="kit-fork-$NAME"
    RUN_CFG="$CONTRACTS/script/config/$RUN_NAME.json"
    show "write $RUN_CFG (a copy of $NAME.json with firstDay $FIRST_DAY$([ "$KIT_REHEARSAL" = 1 ] && echo ' and the rehearsal roles'))"
    if [ "$KIT_DRY" = 0 ]; then
      trap 'rm -f "$RUN_CFG"' EXIT
      sed -E "s/\"firstDay\": [0-9]+/\"firstDay\": $FIRST_DAY/" "$CFG" >"$RUN_CFG"
      if [ "$KIT_REHEARSAL" = 1 ]; then
        for r in primary standby attester; do
          sed -i '' "s/$(role_addr_real "$r")/$(role_addr_rehearsal "$r")/" "$RUN_CFG"
        done
      fi
    fi
  else
    RUN_NAME="$NAME"
    RUN_CFG="$CFG"
    if [ "$KIND" = production ]; then set_json_number "$CFG" firstDay "$FIRST_DAY"; fi
  fi
  export AGATE_CONFIG="$RUN_NAME"

  say "owner balance: $(balance_mon "$OWNER") MON"
  impersonate "$OWNER"
  say "simulation (read only): the predicted address and gas"
  SIM_LOG="$KIT_STATE/logs/deploy-index-$NAME-sim.log"
  [ "$KIT_DRY" = 1 ] || mkdir -p "$KIT_STATE/logs"
  if [ "$KIT_DRY" = 1 ]; then
    forge_read script/DeployIndex.s.sol --sender "$OWNER"
    PRED="0x(predicted)"
  else
    forge_read script/DeployIndex.s.sol --sender "$OWNER" >"$SIM_LOG" 2>&1 || {
      tail -40 "$SIM_LOG" >&2
      die "the simulation failed: nothing sent (log $SIM_LOG)"
    }
    PRED="$(grep -E '^ *AgateIndex 0x' "$SIM_LOG" | awk '{ print $2 }' | tail -1)"
    [ -n "$PRED" ] || die "the simulation printed no AgateIndex address (log $SIM_LOG)"
    grep -E 'Estimated (total gas used|amount required)' "$SIM_LOG" | sed 's/^/   /' || true
    note "predicted index address $PRED"
  fi
  # pendingBlock: the block before the broadcast, a lower bound of the index's deploy block (deploy_block_of, lib.sh)
  PENDING_BLOCK="$(block_now)"
  records_put ".$KIND = {status: \"pending\", index: \$ix, config: \$cfg, firstDay: (\$fd | tonumber), pendingBlock: (\$pb | tonumber), at: \$at}" \
    --arg ix "$PRED" --arg cfg "$NAME" --arg fd "$FIRST_DAY" --arg pb "$PENDING_BLOCK" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  say "broadcast, signed by the owner"
  DEP_LOG="$KIT_STATE/logs/deploy-index-$NAME.log"
  if [ "$KIT_DRY" = 1 ]; then
    forge_send owner AGATE_OWNER_KEY script/DeployIndex.s.sol
    IX="$PRED"
  else
    rc=0
    STARTED="$(date +%s)"
    forge_send owner AGATE_OWNER_KEY script/DeployIndex.s.sol >"$DEP_LOG" 2>&1 || rc=$?
    IX="$(grep -E '^ *AgateIndex 0x' "$DEP_LOG" | awk '{ print $2 }' | tail -1)"
    if [ "$rc" != 0 ]; then
      tail -40 "$DEP_LOG" >&2
      if [ -n "$IX" ] && has_code "$IX"; then
        warn "the broadcast stopped (exit $rc) after the index landed at $IX: resuming with its checks"
      else
        die "the broadcast failed (exit $rc) before the index landed; rerun this script (log $DEP_LOG)"
      fi
    fi
    [ -n "$IX" ] || die "DeployIndex printed no AgateIndex address (log $DEP_LOG)"
    [ "$(echo "$IX" | tr 'A-F' 'a-f')" = "$(echo "$PRED" | tr 'A-F' 'a-f')" ] || warn "the index landed at $IX, not at the predicted $PRED"
    has_code "$IX" || die "no code at $IX after the broadcast (log $DEP_LOG)"
    RUN_JSON="$FOUNDRY_BROADCAST/DeployIndex.s.sol/$CHAIN_ID/run-latest.json"
    # the gas line only from a broadcast file this run wrote
    if [ -f "$RUN_JSON" ] && [ "$(stat -f %m "$RUN_JSON")" -ge "$STARTED" ]; then
      set -- $(gas_of "$RUN_JSON")
      note "$1 transactions: gas limits $2 (billed on Monad: $(mon "$2") MON at $GAS_GWEI gwei), gas used $3"
    fi
    deploy_block_of "$IX" "$KIND"
    [ -n "$DEPLOY_BLOCK" ] || die "no deploy block found for $IX (and no pendingBlock): nothing recorded as deployed; rerun this script"
    report_deploy_block
    records_put ".$KIND = {status: \"deployed\", index: \$ix, config: \$cfg, firstDay: (\$fd | tonumber), deployBlock: (\$b | tonumber), deployBlockFrom: \$from, pendingBlock: (\$pb | tonumber), at: \$at}" \
      --arg ix "$IX" --arg cfg "$NAME" --arg fd "$FIRST_DAY" --arg b "$DEPLOY_BLOCK" --arg from "$DEPLOY_BLOCK_FROM" --arg pb "$PENDING_BLOCK" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    if [ "$KIND" = demo ]; then records_put '.demo.session = "active"'; fi
    note "deployed at $IX in block $DEPLOY_BLOCK"
  fi
fi

# ------------------------------------------------------------------ checks (eth_call)
lc() { tr 'A-F' 'a-f'; }
plain() { tr -d '()' | sed -E 's/ \[[^]]*\]//g' | tr ',' ' '; } # cast's "[1.79e9]" notes out, one field per value
want_role() { if [ "$KIT_REHEARSAL" = 1 ] && is_process_role "$1"; then role_addr_rehearsal "$1"; else role_addr_real "$1"; fi; }


say "checks by eth_call"
if [ "$KIT_DRY" = 1 ] && ! has_code "$IX"; then
  note "(dry run: these run after a real deploy) clocks(), owner(), writers(), attester(), guardians(), forwarder(), and gpu(id) of each GPU against launch.json"
  exit 0
fi
[ -n "$FIRST_DAY" ] || FIRST_DAY="$(records_get ".$KIND.firstDay")"
check_index
if [ "${#MISSING[@]}" -gt 0 ]; then
  say "registering the ${#MISSING[@]} missing GPU(s), signed by the owner"
  for i in "${MISSING[@]}"; do
    ARGS="$(jq -c --argjson fd "$FIRST_DAY" "[.gpus[$i].gpuId, .gpus[$i].recipeHash, .gpus[$i].family, .gpus[$i].famQ, \$fd, .gpus[$i].liveAtStartMask]" "$CFG")"
    send_as owner AGATE_OWNER_KEY call "$IX" 'registerGpu(bytes32,bytes32,uint8[],uint8[],uint32,uint32)' "$ARGS"
  done
  [ "$KIT_DRY" = 1 ] && exit 0
  say "checks again"
  check_index
  [ "${#MISSING[@]}" = 0 ] || die "GPUs still missing after registerGpu"
fi

if [ "$KIT_DRY" = 0 ]; then
  records_put ".$KIND.status = \"deployed\" | .$KIND.epochTs = (\$e | tonumber) | .$KIND.day = (\$d | tonumber) | .$KIND.slices = (\$s | tonumber) | .$KIND.tPend = (\$t | tonumber)" \
    --arg e "$C_EPOCHTS" --arg d "$C_DAY" --arg s "$C_SLICES" --arg t "$C_TPEND"
  if [ "$KIND" = demo ]; then records_put '.demo.session = (.demo.session // "active")'; fi
fi
say "index $NAME at $IX: every check passed"
if [ "$KIND" = production ]; then
  note "firstDay $FIRST_DAY = $(day_date "$FIRST_DAY"), from $(utc_date $((FIRST_DAY * 86400)))"
else
  note "demo day $FIRST_DAY (2026-11-01) began at $(utc_date "$C_EPOCHTS"); a demo day is $DAY s"
fi
