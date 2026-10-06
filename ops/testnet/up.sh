#!/usr/bin/env bash
# Opens one tmux window per process of an index's stack in the dev session (agate-dev by default), plus the
# processes every index shares (market maker, payer and lister, indexer, repair agent, Akash reader).
#
#   ops/testnet/up.sh production [--restart-shared] [--dry-run] [--fork]
#   ops/testnet/up.sh demo [--restart-shared] [--dry-run] [--fork]
#
# Windows (exact names; a window that already exists is left alone):
#   production: prod-primary prod-standby prod-attest prod-keep prod-health prod-pagecheck
#               (the watcher logger already runs as "wall-log": its log dir is AGATE_KIT_PROD_LOG_DIR, default
#               ~/.agate-wall/watcher/production-0; on a fork, which has no such logger, also prod-log)
#   demo:       demo-replay demo-log demo-primary demo-standby demo-attest demo-keep demo-health demo-pagecheck
#   shared:     shared-maker shared-payer shared-indexer shared-repair shared-akash (and shared-awake, caffeinate,
#               on testnet). --restart-shared restarts them so they pick up a new deployments file or index.
#
# Each window runs a launcher written to $AGATE_KIT_STATE/run/<name>.sh (no key and no URL in it): a clean
# environment (env -i with an allowlist), the app's own run script, restarted 10 s after an unexpected exit
# (launchd's KeepAlive), its output appended to $AGATE_KIT_STATE/logs/<name>.log from its first line (the window
# opens idle, its output pipe is attached, then the launcher starts in it). Keys reach a process only through its key
# command, which the process (or its run script) runs at start: security find-generic-password ... -w.
# RPC URLs reach it only through AGATE_RPC_URLS_CMD, which the process runs itself: the public RPCs, rotated per
# window, and with AGATE_KIT_ALCHEMY=light (the default) Alchemy for the signing windows' own transactions
# (send:<Alchemy>, its key read from the Keychain by the command) and Alchemy's websocket for the attester and the
# keeper (AGATE_WS_KIND=logs); "all" puts Alchemy first everywhere but the indexer, "off" leaves it out (lib.sh).
# AGATE_ALCHEMY_DAILY_CU, when set here, reaches every window (the day's Alchemy budget, default 400,000 CU).
# AGATE_KIT_INDEXER=0 leaves the indexer window out (a fork rehearsal beside a running indexer).
#
# The market maker and the payer get AGATE_MARKET_GAS_LIMITS from ops/testnet/market-gas-limits.json (another file
# with AGATE_KIT_MARKET_GAS_LIMITS=<path>): the LIMIT table override measured on Monad, which prices some calls above
# the Ethereum table the bots ship with. It is checked with the bots' own parser before any window opens. Change the
# file, then `up.sh <stack> --restart-shared`.
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

usage() {
  echo "usage: $0 <production|demo> [--restart-shared] [--dry-run] [--fork]" >&2
  exit 2
}
RESTART_SHARED=0
args=()
for a in "$@"; do
  case "$a" in
    --restart-shared) RESTART_SHARED=1 ;;
    *) args+=("$a") ;;
  esac
done
kit_parse ${args[@]+"${args[@]}"}
[ "${#KIT_POS[@]}" = 1 ] || usage
STACK="${KIT_POS[0]}"
case "$STACK" in production | demo) ;; *) usage ;; esac
need_tools tmux jq bun
check_fork
check_tmux_target

say "up $STACK: $(kit_mode_line)"
ALCHEMY_LINE="$(kit_alchemy_line)"
note "$ALCHEMY_LINE"
note "tmux $([ -n "$TMUX_SOCK" ] && echo "server -L $TMUX_SOCK, ")session $TMUX_SESSION; wall home $KIT_WALL_HOME"

PROD_IX="$(records_get .production.index)"
[ "$(records_get .production.status)" = deployed ] || PROD_IX=""
PROD_BLOCK="$(records_get .production.deployBlock)"
DEMO_IX=""
DEMO_BLOCK=""
DEMO_EPOCH=""
if [ "$(records_get .demo.status)" = deployed ] && [ "$(records_get .demo.session)" = active ]; then
  DEMO_IX="$(records_get .demo.index)"
  DEMO_BLOCK="$(records_get .demo.deployBlock)"
  DEMO_EPOCH="$(records_get .demo.epochTs)"
fi
DEMO_DAY="$(records_get .demo.day)"
DEMO_SLICES="$(records_get .demo.slices)"
if [ "$STACK" = production ] && [ -z "$PROD_IX" ]; then
  [ "$KIT_DRY" = 1 ] || die "no deployed production index in $KIT_RECORDS"
  PROD_IX="0xPRODUCTIONINDEX"; PROD_BLOCK="0"
  note "(dry run: no production index recorded yet; shown as $PROD_IX)"
fi
if [ "$STACK" = demo ] && [ -z "$DEMO_IX" ]; then
  [ "$KIT_DRY" = 1 ] || die "no active demo session in $KIT_RECORDS: run demo-session.sh start"
  DEMO_IX="0xDEMOINDEX"; DEMO_BLOCK="0"; DEMO_EPOCH="0"
  note "(dry run: no active demo index recorded yet; shown as $DEMO_IX)"
fi
# a stopped session is over for the shared bots once its months have ended: the maker winds its books down at each
# demo month's end (5 and 10 hours in), so it keeps the demo factory until two months of at most 31 demo days and an
# hour have passed since the session began
DEMO_OVER=0
if [ -z "$DEMO_IX" ]; then
  _ep="$(records_get .demo.epochTs)"
  case "$_ep" in '' | *[!0-9]*) _ep="" ;; esac
  case "$DEMO_DAY" in '' | *[!0-9]*) _ep="" ;; esac
  # only a recorded session with its clock, and only while the deployments file has the real factory to keep
  if [ -n "$_ep" ] && [ "$(date +%s)" -ge $((_ep + 62 * DEMO_DAY + 3600)) ] && [ -f "$KIT_DEPLOYMENTS" ] &&
    jq -e '.factories.real and .factories.demo' "$KIT_DEPLOYMENTS" >/dev/null 2>&1; then DEMO_OVER=1; fi
fi
[ -f "$KIT_DEPLOYMENTS" ] || warn "no deployments file $KIT_DEPLOYMENTS yet: the market bots and the indexer are not started"

# ------------------------------------------------------------------ the environment of every window
BUN_BIN="$(command -v bun)"
CLAUDE_BIN="$(command -v claude || true)"
LOGDIR="$KIT_STATE/logs"
RUNDIR="$KIT_STATE/run"
REPLAY_PORT="${AGATE_KIT_REPLAY_PORT:-8787}"
REPLAY_URL="http://127.0.0.1:$REPLAY_PORT"
PROD_LOG_DIR="${AGATE_KIT_PROD_LOG_DIR:-$HOME/.agate-wall/watcher/production-0}"

if [ "$KIT_FORK" = 1 ]; then
  PORT="${KIT_RPC##*:}"
  PORT="${PORT%%/*}"
  FORK_LIST="http://127.0.0.1:$PORT,http://localhost:$PORT"
  CRE_RPC="http://127.0.0.1:$PORT"
  # a fork has no production logger: the production processes read the log of a prod-log window
  PROD_LOG_DIR=""
else
  FORK_LIST="" # per window: the public RPCs rotated by its name (lib.sh)
  CRE_RPC="$PUBLIC_RPC"
fi
# the RPC list command of one window (lib.sh rpc_list_cmd): the fork's URLs or the rotated public RPCs, with Alchemy
# where the mode gives it
rpc_cmd_of() { rpc_list_cmd "$1" "$FORK_LIST"; }
# AGATE_RPC_URLS_CMD of a window, and AGATE_WS_KIND=logs when its list carries Alchemy's websocket
rpc_env_of() {
  local k
  echo "AGATE_RPC_URLS_CMD=$(rpc_cmd_of "$1")"
  k="$(alchemy_ws_kind "$1")"
  if [ -n "$k" ]; then echo "AGATE_WS_KIND=$k"; fi
  return 0
}

# KEY=VALUE lines of the base environment (the allowlist), then each window adds its own
base_env() {
  echo "HOME=$HOME"
  echo "PATH=$PATH"
  echo "USER=${USER:-$(id -un)}"
  echo "LOGNAME=${LOGNAME:-$(id -un)}"
  echo "LANG=${LANG:-en_US.UTF-8}"
  echo "TMPDIR=${TMPDIR:-/tmp}"
  echo "TERM=xterm-256color"
  echo "BUN=$BUN_BIN"
  echo "AGATE_WALL_HOME=$KIT_WALL_HOME"
  echo "AGATE_CHAIN_ID=$CHAIN_ID"
  if [ "$KIT_FORK" = 1 ]; then
    echo "FOUNDRY_DISABLE_NIGHTLY_WARNING=1"
  else
    echo "AGATE_NOTIFY_CMD=/bin/sh $KIT/notify.sh"
  fi
  local v
  # optional overrides the operator may set in the shell that runs up.sh (wall/README.md, 18.6); the market bots'
  # gas limits come from MARKET_GAS_FILE only (win_env)
  for v in AGATE_MAX_FEE_GWEI AGATE_GAS_POST AGATE_GAS_ONREPORT AGATE_GAS_CLOSE AGATE_GAS_MEASURED \
    AGATE_KEY_LOW_HOURS AGATE_MM_CONFIG AGATE_PAYER_CONFIG AGATE_ALCHEMY_DAILY_CU AGATE_MM_SESSION_MON \
    AGATE_MM_SESSION_UNTIL AGATE_PAYER_SESSION_MON AGATE_PAYER_SESSION_UNTIL AGATE_HEALTH_CORE AGATE_HEALTH_WRITERS \
    AGATE_HEALTH_EXTRA AGATE_HEALTH_GLOBAL; do
    if [ -n "${!v:-}" ]; then echo "$v=${!v}"; fi
  done
  return 0
}

# win_env NAME: the extra KEY=VALUE lines of one window; win_cmd NAME: its command (cwd is wall/)
idx_of() { case "$1" in prod-*) echo "$PROD_IX" ;; demo-*) echo "$DEMO_IX" ;; esac; }
block_of() { case "$1" in prod-*) echo "$PROD_BLOCK" ;; demo-*) echo "$DEMO_BLOCK" ;; esac; }
win_env() {
  local n="$1" ix blk
  ix="$(idx_of "$n")"
  blk="$(block_of "$n")"
  case "$n" in
    *-primary | *-standby | *-attest | *-keep | *-health | *-log | *-pagecheck)
      echo "AGATE_INDEX=$ix"
      echo "AGATE_PANELS=$PANELS"
      ;;
  esac
  case "$n" in
    *-primary | *-standby | *-attest | *-keep | *-health | *-log) rpc_env_of "$n" ;;
  esac
  case "$n" in
    *-attest | *-keep | *-health | *-log) echo "AGATE_FROM_BLOCK=${blk:-0}" ;;
  esac
  case "$n" in
    prod-attest | prod-keep | prod-health | prod-pagecheck) if [ -n "$PROD_LOG_DIR" ]; then echo "AGATE_WATCHER_LOG_DIR=$PROD_LOG_DIR"; fi ;;
  esac
  case "$n" in
    demo-primary | demo-standby | demo-log) echo "SOURCE_BASE_URL=$REPLAY_URL" ;;
    demo-pagecheck) echo "TRACKER_BASE_URL=$REPLAY_URL" ;;
  esac
  case "$n" in
    *-primary)
      echo "AGATE_PRIMARY_KEY_CMD=$(role_key_cmd primary)"
      echo "AGATE_CRE_RPC_URLS=$CRE_RPC"
      ;;
    *-standby) echo "AGATE_STANDBY_KEY_CMD=$(role_key_cmd standby)" ;;
    *-attest) echo "AGATE_KEY_CMD=$(role_key_cmd attester)" ;;
    *-keep) echo "AGATE_KEY_CMD=$(role_key_cmd keeper)" ;;
    *-health)
      echo "AGATE_KEEPER_ADDRESS=$(role_addr keeper)"
      echo "AGATE_GUARDIAN_ADDRESS=$(role_addr guardian)"
      ;;
    shared-maker | shared-payer)
      rpc_env_of "$n"
      echo "AGATE_DEPLOYMENTS=$KIT_DEPLOYMENTS"
      echo "AGATE_MARKET_GAS_LIMITS=$MARKET_GAS_JSON"
      # between demo sessions, once the last one's months are over, the bots leave the demo factory alone: its
      # writers are stopped, so its days never close and every tick raised MM_INDEX_BEHIND and LISTER_STUCK (Oct 5).
      # Both variables name a config FILE; the operator's own wins
      if [ "$DEMO_OVER" = 1 ]; then
        if [ "$n" = shared-maker ] && [ -z "${AGATE_MM_CONFIG:-}" ]; then echo "AGATE_MM_CONFIG=$KIT/bots-real-only.json"; fi
        if [ "$n" = shared-payer ] && [ -z "${AGATE_PAYER_CONFIG:-}" ]; then echo "AGATE_PAYER_CONFIG=$KIT/bots-real-only.json"; fi
      fi
      if [ "$n" = shared-maker ]; then
        echo "AGATE_KEY_CMD=$(role_key_cmd bot)"
      elif [ "$PAYER_SIGNER" = dynamic ]; then
        payer_dynamic_env
      else
        echo "AGATE_KEY_CMD=$(role_key_cmd payer)"
      fi
      ;;
    shared-indexer)
      echo "AGATE_RPC_URLS_CMD=$(rpc_cmd_of "$n")"
      echo "AGATE_DEPLOYMENTS=$KIT_DEPLOYMENTS"
      echo "AGATE_KIT_RECORDS=$KIT_RECORDS"
      echo "AGATE_KIT_STATE=$KIT_STATE"
      # Envio's terminal UI redraws into the window's log: about 600 MB by Oct 6 on the local machine. Plain log lines instead.
      echo "TUI_OFF=true"
      if [ "$KIT_FORK" = 1 ]; then echo "AGATE_KIT_FORK_RPC=$KIT_RPC"; fi
      ;;
    shared-repair)
      echo "AGATE_INDEXES=$(echo "$PROD_IX,$DEMO_IX" | sed 's/^,//; s/,$//')"
      echo "AGATE_PANELS=$PANELS"
      rpc_env_of "$n"
      echo "AGATE_REPO=$ROOT"
      [ -n "$CLAUDE_BIN" ] && echo "AGATE_CLAUDE_BIN=$CLAUDE_BIN"
      if [ -n "$PROD_IX" ] && [ -n "$PROD_LOG_DIR" ]; then echo "AGATE_WATCHER_LOG_DIR_$(index8 "$PROD_IX")=$PROD_LOG_DIR"; fi
      if [ "$KIT_FORK" = 1 ]; then
        echo "AGATE_REPAIR_MAX_CALLS_DAY=0"
        echo "AGATE_REPAIR_NOTIFY=0"
      fi
      ;;
  esac
  return 0
}
win_cmd() {
  case "$1" in
    *-primary) echo "/bin/sh apps/writer-cre/launchd/run-primary.sh" ;;
    *-standby) echo "/bin/sh apps/writer-standby/launchd/run-standby.sh" ;;
    *-attest) echo "/bin/sh apps/watcher/launchd/run-watcher.sh attest" ;;
    *-keep) echo "/bin/sh apps/watcher/launchd/run-watcher.sh keep" ;;
    *-health) echo "/bin/sh apps/watcher/launchd/run-watcher.sh health" ;;
    *-log) echo "/bin/sh apps/watcher/launchd/run-watcher.sh log" ;;
    *-pagecheck) echo "/bin/sh apps/pagecheck/launchd/run-pagecheck.sh" ;;
    demo-replay) echo "$BUN_BIN run packages/sources/scripts/replay.ts --t0 $DEMO_EPOCH --day ${DEMO_DAY:-600} --slices ${DEMO_SLICES:-4} --port $REPLAY_PORT" ;;
    shared-maker) echo "/bin/sh apps/marketmaker/launchd/run-marketmaker.sh" ;;
    shared-payer) echo "/bin/sh apps/payer/launchd/run-payer.sh" ;;
    shared-indexer) echo "/bin/bash $KIT/indexer.sh run$([ "$KIT_FORK" = 1 ] && echo ' --fork')" ;;
    shared-repair) echo "/bin/sh apps/repair/launchd/run-repair.sh" ;;
    shared-akash) echo "/bin/sh apps/akash/launchd/run-akash.sh" ;;
    shared-awake) echo "/usr/bin/caffeinate -i -s" ;;
  esac
}

# single-quote a value for the launcher (sh)
sq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

# The production writers and health start 10 minutes before firstDay: a reading of an earlier day is skipped by the
# index (E3) yet billed (about 0.17 MON a slice on the primary, 0.15 on the standby), and health would flag writers
# that have not started. Their windows open at once and wait.
PROD_FD="$(records_get .production.firstDay)"
wait_until() {
  case "$1" in
    prod-primary | prod-standby) [ -n "$PROD_FD" ] && echo $((PROD_FD * 86400 - 600)) ;;
    prod-health) [ -n "$PROD_FD" ] && echo $((PROD_FD * 86400 - 540)) ;;
  esac
  return 0
}

launcher() { # the launcher script text of window NAME
  local n="$1" line w
  printf '#!/bin/sh\n'
  printf '# %s: written by ops/testnet/up.sh (%s). Holds no key and no URL: keys and URLs come from the commands.\n' "$n" "$STACK"
  printf 'cd %s || exit 1\n' "$(sq "$WALL")"
  w="$(wait_until "$n")"
  if [ -n "$w" ] && [ "$w" -gt "$(date +%s)" ]; then
    printf 'echo "%s waits until %s (%s minutes before firstDay)"\n' "$n" "$(utc_date "$w")" $(((PROD_FD * 86400 - w) / 60))
    printf 'while [ "$(date +%%s)" -lt %s ]; do sleep 20; done\n' "$w"
  fi
  printf 'while :; do\n  env -i'
  { base_env; win_env "$n"; } | while IFS= read -r line; do
    printf ' \\\n    %s=%s' "${line%%=*}" "$(sq "${line#*=}")"
  done
  printf ' \\\n    %s\n' "$(win_cmd "$n")"
  printf '  rc=$?\n'
  printf '  case "$rc" in 0 | 2 | 3 | 64 | 130 | 143) echo "%s stopped (exit $rc)"; break ;; esac\n' "$n"
  printf '  echo "%s exited $rc: restarting in 10 s"; sleep 10\n' "$n"
  printf 'done\n'
}

# ------------------------------------------------------------------ which windows
PER=""
case "$STACK" in
  production)
    PER="prod-primary prod-standby prod-attest prod-keep prod-pagecheck prod-health"
    [ -z "$PROD_LOG_DIR" ] && PER="prod-log $PER"
    ;;
  demo) PER="demo-replay demo-log demo-primary demo-standby demo-attest demo-keep demo-pagecheck demo-health" ;;
esac
SHARED="shared-repair shared-akash"
if [ -f "$KIT_DEPLOYMENTS" ]; then
  if [ "${AGATE_KIT_INDEXER:-1}" = 0 ]; then
    SHARED="shared-maker shared-payer $SHARED"
    note "AGATE_KIT_INDEXER=0: no indexer window"
  else
    SHARED="shared-maker shared-payer shared-indexer $SHARED"
  fi
fi
# caffeinate keeps a Mac awake; a Linux server has no such window
[ "$KIT_FORK" = 1 ] || [ "$(uname)" != Darwin ] || SHARED="$SHARED shared-awake"
# AGATE_KIT_WINDOWS (Oct 6): open only these windows (exact names, space or comma separated), for a stack split across
# machines: the server runs most roles, the local machine keeps the standby writer. Only the keys of the opened windows are checked.
if [ -n "${AGATE_KIT_WINDOWS:-}" ]; then
  only() {
    local out="" n
    for n in $1; do
      case " $(printf '%s' "$AGATE_KIT_WINDOWS" | tr ',' ' ') " in *" $n "*) out="$out $n" ;; esac
    done
    echo "${out# }"
  }
  PER="$(only "$PER")"
  SHARED="$(only "$SHARED")"
  [ -n "$PER$SHARED" ] || die "AGATE_KIT_WINDOWS ($AGATE_KIT_WINDOWS) names none of this stack's windows: nothing opened"
  note "AGATE_KIT_WINDOWS: only $PER $SHARED"
fi
# $KIT_STATE/elsewhere (this machine only): window names that run on another machine, never opened here, so a plain
# up.sh on the local machine cannot start a second copy of a role the server runs (two processes on one key)
ELSEWHERE_FILE="$KIT_STATE/elsewhere"
if [ -f "$ELSEWHERE_FILE" ]; then
  ELSEWHERE=" $(tr ',\n' '  ' <"$ELSEWHERE_FILE") "
  skip() {
    local out="" n
    for n in $1; do case "$ELSEWHERE" in *" $n "*) note "$n: runs on another machine ($ELSEWHERE_FILE): not opened here" >&2 ;; *) out="$out $n" ;; esac; done
    echo "${out# }"
  }
  PER="$(skip "$PER")"
  SHARED="$(skip "$SHARED")"
fi
# health on a split stack watches the roles opened on this machine only (heartbeat files are local), and only the
# machine that runs the keeper checks the chain-wide items (late days, key balances), so the local machine and the server never
# raise one alert twice. An AGATE_HEALTH_* set in the shell wins; "none" is an empty list (an empty value is not passed).
if [ -n "${AGATE_KIT_WINDOWS:-}" ] || [ -f "$ELSEWHERE_FILE" ]; then
  h_core="log" h_writers="" h_extra="" h_global=0
  for n in $PER $SHARED; do
    case "$n" in
      *-attest) h_core="$h_core,attest" ;;
      *-keep) h_core="$h_core,keep" h_global=1 ;;
      *-primary) h_writers="$h_writers,primary" ;;
      *-standby) h_writers="$h_writers,standby" ;;
      *-pagecheck) h_extra="$h_extra,pagecheck" ;;
      shared-repair) h_extra="$h_extra,repair" ;;
      shared-akash) h_extra="$h_extra,akash" ;;
    esac
  done
  h_writers="${h_writers#,}" h_extra="${h_extra#,}"
  AGATE_HEALTH_CORE="${AGATE_HEALTH_CORE:-$h_core}"
  AGATE_HEALTH_WRITERS="${AGATE_HEALTH_WRITERS:-${h_writers:-none}}"
  AGATE_HEALTH_EXTRA="${AGATE_HEALTH_EXTRA:-${h_extra:-none}}"
  AGATE_HEALTH_GLOBAL="${AGATE_HEALTH_GLOBAL:-$h_global}"
fi

if [ "$STACK" = production ] && [ "$KIT_FORK" = 0 ] && [ "$KIT_DRY" = 0 ]; then
  HB="$PROD_LOG_DIR/heartbeat-log.json"
  if [ ! -f "$HB" ]; then
    warn "no watcher logger heartbeat at $HB: is the logger (wall-log) running?"
  elif [ $(($(date +%s) - $(file_mtime "$HB"))) -gt 7200 ]; then
    warn "the watcher logger's heartbeat $HB is over 2 h old"
  fi
fi
if [ "$STACK" = production ] && [ -n "$PROD_FD" ] && [ "$(date +%s)" -lt $((PROD_FD * 86400 - 600)) ]; then
  note "firstDay $(day_date "$PROD_FD") begins $(utc_date $((PROD_FD * 86400))): prod-primary and prod-standby start at $(utc_date $((PROD_FD * 86400 - 600))), prod-health a minute later"
fi

# the payer on its Dynamic server wallet: the real testnet stack only (a fork or a rehearsal must never sign with the
# real wallet), and its wallet file must exist, owner-only (attributes only: nothing is read here)
PAYER_SIGNER="$(payer_signer)" || exit 1 # an invalid AGATE_PAYER_SIGNER: payer_signer said why
if [ "$PAYER_SIGNER" = dynamic ]; then
  [ "$KIT_FORK" = 0 ] && [ "$KIT_REHEARSAL" = 0 ] || die "AGATE_PAYER_SIGNER=dynamic is for the real testnet stack only (not --fork or a rehearsal): unset it; nothing opened"
fi
# its wallet file only when this run opens the payer (on a split stack it may run on the other machine)
if [ "$PAYER_SIGNER" = dynamic ] && case " $PER $SHARED " in *" shared-payer "*) true ;; *) false ;; esac; then
  [ -f "$(payer_wallet_file)" ] || die "no Dynamic wallet file $(payer_wallet_file) (server/scripts/payer-wallet.ts export): nothing opened"
  [ "$(file_mode "$(payer_wallet_file)")" = 600 ] || die "$(payer_wallet_file) must be mode 600: nothing opened"
fi

# every Keychain item the windows' key commands will read exists (attributes only: no secret is read here)
if [ "$KIT_FORK" = 0 ] && [ "$KIT_DRY" = 0 ]; then
  # the roles of the windows this run opens (all of them unless AGATE_KIT_WINDOWS narrows it); the payer on its Dynamic
  # server wallet has no Keychain key (its wallet file is checked above)
  roles=""
  for n in $PER $SHARED; do
    case "$n" in
      *-primary) roles="$roles primary" ;;
      *-standby) roles="$roles standby" ;;
      *-attest) roles="$roles attester" ;;
      *-keep) roles="$roles keeper" ;;
      shared-maker) roles="$roles bot" ;;
      shared-payer) [ "$PAYER_SIGNER" = dynamic ] || roles="$roles payer" ;;
    esac
  done
  for r in $roles; do
    keychain_has "$(role_svc "$r")" || die "no Keychain item $(role_svc "$r") (account private-key): nothing opened"
  done
  # light or all: the Alchemy key's item (its attributes; the key itself is read by each command at its start)
  if alchemy_real; then
    security find-generic-password -s agate.alchemy-api-key -a api-key >/dev/null 2>&1 || die "no Keychain item agate.alchemy-api-key (account api-key): nothing opened"
  fi
fi

# the market bots' gas limits: one source, the file, checked by the bots' own parser before anything opens
[ -z "${AGATE_MARKET_GAS_LIMITS:-}" ] || die "AGATE_MARKET_GAS_LIMITS is set in this shell: put the limits in $MARKET_GAS_FILE (or point AGATE_KIT_MARKET_GAS_LIMITS at another file), unset it and run again; nothing opened"
[ -f "$MARKET_GAS_FILE" ] || die "no market gas limits file $MARKET_GAS_FILE: nothing opened"
MARKET_GAS_JSON="$(jq -c . "$MARKET_GAS_FILE")" || die "$MARKET_GAS_FILE is not JSON: nothing opened"
(cd "$WALL" && AGATE_MARKET_GAS_LIMITS="$MARKET_GAS_JSON" "$BUN_BIN" -e 'import { LimitTable } from "./packages/market/src/limits.ts"; LimitTable.fromEnv();' >/dev/null 2>&1) ||
  die "$MARKET_GAS_FILE is refused by the bots' parser (shapes and limits: wall/packages/market/src/limits.ts): nothing opened"
note "market bots' gas limits (AGATE_MARKET_GAS_LIMITS, from $(basename "$MARKET_GAS_FILE")): $MARKET_GAS_JSON"

# ------------------------------------------------------------------ open
if [ "$KIT_DRY" = 0 ]; then
  mkdir -p "$LOGDIR" "$RUNDIR"
  if ! tmx has-session -t "=$TMUX_SESSION" 2>/dev/null; then
    [ "$KIT_FORK" = 1 ] || die "no tmux session $TMUX_SESSION: start your dev session first"
    tmx new-session -d -s "$TMUX_SESSION" -n kit -c "$ROOT"
  fi
fi

# A window opens idle (a placeholder sleep), its output pipe to the log is attached, and only then does the launcher
# replace the placeholder (respawn-pane): the log gets the launcher's first line too. The pipe stays with the pane.
IDLE="/bin/sh -c 'exec sleep 300'"
open_win() {
  local n="$1" f="$RUNDIR/$1.sh" id
  if [ "$KIT_DRY" = 1 ]; then
    show "write $f:"
    launcher "$n" | sed 's/^/    | /'
    tmx_show new-window -d -P -F '#{window_id}' -t "=$TMUX_SESSION:" -n "$n" -c "$WALL" "$IDLE"
    tmx_show set-option -w -t "<id of $n>" remain-on-exit on
    tmx_show pipe-pane -o -t "<id of $n>" "cat >> $LOGDIR/$n.log"
    tmx_show respawn-pane -k -t "<id of $n>" -c "$WALL" "/bin/sh $f"
    [ "$n" = shared-payer ] && PAYER_STARTED=1
    return 0
  fi
  id="$(win_id "$n")"
  if [ -n "$id" ]; then
    # a window whose launcher stopped (exit 0, 2, 3 or 64: kept open by remain-on-exit) is started again, not skipped
    if [ "$(tmx display-message -p -t "$id" '#{pane_dead}')" = 1 ]; then
      launcher "$n" >"$f"
      tmx respawn-pane -k -t "$id" -c "$WALL" "/bin/sh $f" || die "$n: the launcher did not restart in window $id"
      [ "$n" = shared-payer ] && PAYER_STARTED=1
      note "$n: its launcher had stopped: started again ($id)"
    else
      note "$n: already open (left alone)"
    fi
    return 0
  fi
  launcher "$n" >"$f"
  id="$(tmx new-window -d -P -F '#{window_id}' -t "=$TMUX_SESSION:" -n "$n" -c "$WALL" "$IDLE")"
  tmx set-option -w -t "$id" remain-on-exit on >/dev/null
  tmx set-option -w -t "$id" automatic-rename off >/dev/null
  tmx pipe-pane -o -t "$id" "cat >> '$LOGDIR/$n.log'"
  tmx respawn-pane -k -t "$id" -c "$WALL" "/bin/sh $f" || die "$n: the launcher did not start in window $id (left idle; close it with down.sh)"
  [ "$n" = shared-payer ] && PAYER_STARTED=1
  note "$n: opened ($id)"
}

if [ "$RESTART_SHARED" = 1 ]; then
  say "restarting the shared windows"
  for n in $SHARED; do
    if [ "$KIT_DRY" = 1 ]; then
      show "$KIT/down.sh: stop the window named exactly $n"
    else
      AGATE_KIT_ONLY="$n" "$KIT/down.sh" "$STACK" $([ "$KIT_FORK" = 1 ] && echo --fork) --only-named
    fi
  done
fi

say "windows of the $STACK index ($(idx_of "$(echo "$PER" | awk '{ print $1 }')"))"
HEALTH=""
for n in $PER; do
  case "$n" in *-health) HEALTH="$n" ;; *) open_win "$n" ;; esac
done
say "shared windows"
PAYER_STARTED=0
for n in $SHARED; do open_win "$n"; done
# an explicit AGATE_PAYER_SIGNER on the real stack is remembered (payerSigner in the records file) once shared-payer has
# started with it, so a later up.sh or demo-session.sh run without the variable keeps the payer on the same signer
# (Oct 5). Never on a run that stopped before its windows, and never while a running payer was left alone.
if [ -n "${AGATE_PAYER_SIGNER:-}" ] && [ "$KIT_FORK" = 0 ] && [ "$KIT_REHEARSAL" = 0 ] && [ "$(records_get .payerSigner)" != "$PAYER_SIGNER" ]; then
  if [ "$PAYER_STARTED" = 1 ]; then
    records_put '.payerSigner = $s' --arg s "$PAYER_SIGNER"
    note "the payer's signer is now $PAYER_SIGNER, remembered in $KIT_RECORDS (AGATE_PAYER_SIGNER=key or dynamic changes it)"
  else
    note "AGATE_PAYER_SIGNER=$PAYER_SIGNER not applied: shared-payer is running and was left alone (add --restart-shared)"
  fi
fi
# health last, once the roles it watches have written a first heartbeat (else a HEARTBEAT_LOST per role at start)
if [ -n "$HEALTH" ]; then
  if [ "$KIT_DRY" = 0 ] && [ -z "$(win_id "$HEALTH")" ]; then sleep 30; fi
  open_win "$HEALTH"
fi
say "up $STACK: done"
note "logs: $LOGDIR/<window>.log; status: bun run apps/guardian/src/cli.ts status (AGATE_INDEX=<index>) and the health window"
