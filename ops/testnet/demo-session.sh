#!/usr/bin/env bash
# One demo session on Monad testnet: a fresh demo-clock index (a 600 s day, day 1 = 2026-11-01 at the deploy), its
# market factory, the replay server and the demo stack, all in the dev tmux session.
#
#   ops/testnet/demo-session.sh start [--hours H] [--dry-run] [--fork]
#   ops/testnet/demo-session.sh stop [--dry-run] [--fork]
#
# start: prints the MON the session will spend, then deploy-index.sh testnet-demo (an active session's index is
#   reused, so a start cut off halfway resumes), deploy-market.sh demo, up.sh demo --restart-shared (the maker, the
#   payer, the indexer and the repair agent restart to take the new factory and index).
# stop: down.sh demo, then the session is marked stopped (the next start deploys a fresh index). The demo factory
#   stays in the deployments file until the next session replaces it; the maker winds its books down at each demo
#   month's end. To cancel them at once, stop production too and run down.sh production --cancel-books: the maker has
#   one kill switch for every factory, so down.sh refuses --cancel-books while the other stack runs.
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

HOURS=5
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --hours) HOURS="${2:?}"; shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
kit_parse ${args[@]+"${args[@]}"}
ACTION="${KIT_POS[0]:-}"
case "$ACTION" in start | stop) ;; *) die "usage: $0 <start|stop> [--hours H] [--dry-run] [--fork]" ;; esac
# an unknown argument is refused, never dropped (a dropped --cancel-books would leave the books resting unannounced)
[ "${#KIT_POS[@]}" -le 1 ] || die "unknown argument(s): ${KIT_POS[*]:1}; usage: $0 <start|stop> [--hours H] [--dry-run] [--fork]"
case "$HOURS" in '' | *[!0-9.]*) die "--hours takes a number" ;; esac
# a stack split across machines (since Oct 6): the shared bots and the indexer this session restarts may run on the
# other machine, which this run cannot reach, so the new demo market would get no maker, payer or indexer
if [ -n "${AGATE_KIT_WINDOWS:-}" ] || [ -f "$KIT_STATE/elsewhere" ]; then
  die "this machine runs part of a split stack (AGATE_KIT_WINDOWS or $KIT_STATE/elsewhere): a demo session restarts the shared windows, so run it where the whole stack runs; nothing deployed or stopped"
fi
FLAGS=()
[ "$KIT_DRY" = 1 ] && FLAGS+=(--dry-run)
[ "$KIT_FORK" = 1 ] && FLAGS+=(--fork)

if [ "$ACTION" = stop ]; then
  say "demo session stop: $(kit_mode_line)"
  "$KIT/down.sh" demo ${FLAGS[@]+"${FLAGS[@]}"}
  # the shared bots still hold the session's MON on top of their daily budget (AGATE_*_SESSION_MON): while the
  # production stack runs, restart them without it (its windows are open, so up.sh opens nothing else)
  if [ "$KIT_DRY" = 1 ] || [ -n "$(win_id prod-primary)" ]; then
    env -u AGATE_MM_SESSION_MON -u AGATE_PAYER_SESSION_MON -u AGATE_MM_SESSION_UNTIL -u AGATE_PAYER_SESSION_UNTIL \
      "$KIT/up.sh" production --restart-shared ${FLAGS[@]+"${FLAGS[@]}"}
  fi
  if [ -n "$(records_get .demo.index)" ]; then
    records_put '.demo.session = "stopped" | .demo.stoppedAt = $at' --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  fi
  say "demo session stopped"
  exit 0
fi

# up.sh takes the market bots' gas limits from its file only: refuse a shell override before anything is deployed
[ -z "${AGATE_MARKET_GAS_LIMITS:-}" ] || die "AGATE_MARKET_GAS_LIMITS is set in this shell: put the limits in $MARKET_GAS_FILE, unset it and run again; nothing sent"
check_fork

# MON at GAS_GWEI for H hours (fund.sh's figures): the wall's demo keys, the market bots (their fork figures times
# BOT_FACTOR: Monad prices their calls higher than the fork), the two deploys
est() { awk "BEGIN { printf \"%.1f\", ($1) * $GAS_GWEI / 102 }"; }
say "demo session start: $(kit_mode_line)"
ALCHEMY_LINE="$(kit_alchemy_line)"
note "$ALCHEMY_LINE"
# Alchemy compute units at the rates two light fork rehearsals measured (Oct 4, a counting stand-in in front of the
# fork, the higher of the two each): the demo's own sends about 20,400 CU an hour (the listings and a user's journey in
# the first half hour included), the demo attester's and keeper's websocket about 53,000 an hour once the session runs
# steady (46,700 over its first 36 minutes), the production stack about 50,500 a UTC day (its sends 12,400, its
# websocket 38,000). The meter stops Alchemy for the rest of the UTC day at AGATE_ALCHEMY_DAILY_CU; the stop is
# graceful (the sends go to the public RPCs, polling takes the wake-ups), so a session that reaches it runs on.
if [ "$(alchemy_effective)" = light ]; then
  BUDGET="${AGATE_ALCHEMY_DAILY_CU:-400000}"
  [[ "$BUDGET" =~ ^[0-9]+$ ]] && [ "$BUDGET" -gt 0 ] || die "AGATE_ALCHEMY_DAILY_CU must be a whole number of compute units above 0"
  SENDH=20400
  WSH=53000
  PRODD=50500
  case "${AGATE_KIT_ALCHEMY_WS:-on}" in
    prod) WSH=0 ;;
    off) WSH=0 PRODD=12400 ;;
  esac
  cu() { awk "BEGIN { printf \"%d\", ($1) }"; }
  DAYCU="$(cu "$HOURS * ($SENDH + $WSH) + $PRODD")"
  PCT="$(cu "100 * $DAYCU / $BUDGET")"
  note "Alchemy over $HOURS h: about $(cu "$HOURS * $SENDH") CU for the sends and $(cu "$HOURS * $WSH") for the demo websocket; with the production stack's $PRODD a UTC day, about $DAYCU: $PCT% of the budget ($BUDGET CU a UTC day)"
  if [ "$PCT" -ge 90 ]; then
    warn "this session and the production stack may spend the day's Alchemy budget before the session ends (about $PCT%): from then until 00:00 UTC every process sends through the public RPCs and polls without the websocket; AGATE_KIT_ALCHEMY_WS=prod leaves the demo windows without the websocket (about $(cu "100 * ($HOURS * $SENDH + $PRODD) / $BUDGET")%)"
  fi
fi
note "MON this session spends at $GAS_GWEI gwei over $HOURS h (Monad bills the gas limit; ceilings, the bots pace themselves):"
note "  owner     $(est 0.75) (the demo index deploy)"
note "  deployer  $(est 1.26) (the demo factory and router)"
note "  primary   up to $(est "$HOURS * 7.42") (576 reports and 864 closes a real day at the shipped limits; 5.79 an hour measured)"
note "  standby   about $(est "$HOURS * 4.00")"
note "  attester  up to $(est "$HOURS * 0.39"); keeper up to $(est "$HOURS * 1.83") (closes the writers leave, carries)"
note "  maker     up to $(est "$BOT_FACTOR * $HOURS * 5.20"); payer about $(est "$BOT_FACTOR * (4 + $HOURS * 0.50)") (six series and markets, then claims; the fork's figures x $BOT_FACTOR for Monad's prices)"
note "  total     up to $(est "2 + $HOURS * (7.42 + 4.00 + 0.39 + 1.83) + $BOT_FACTOR * (4 + $HOURS * (5.20 + 0.50))")"

# The market bots' daily MON budget is paced for the production horizon (about 1.4 MON a day for the payer, 3 for the
# maker); a session lists six series at once and quotes six books. Each bot gets its share of the plan above once, on
# top and unpaced, until an hour after the session's planned end (the bots keep what it used in session-<until>.json,
# so a restart or a new UTC day never grants it twice; stop restarts the shared windows without it; the floor holds).
export AGATE_MM_SESSION_MON AGATE_PAYER_SESSION_MON AGATE_MM_SESSION_UNTIL AGATE_PAYER_SESSION_UNTIL
AGATE_MM_SESSION_MON="$(est "$BOT_FACTOR * $HOURS * 5.20")"
AGATE_PAYER_SESSION_MON="$(est "$BOT_FACTOR * (4 + $HOURS * 0.50)")"
# the bots refuse to start on more than 1000 MON (sessionFromEnv): stop here, before anything is deployed
for v in "$AGATE_MM_SESSION_MON" "$AGATE_PAYER_SESSION_MON"; do
  awk -v x="$v" 'BEGIN { exit !(x <= 1000) }' || die "this session plans $v MON for one bot, above the 1000 the bots accept: use fewer --hours or a lower gas price"
done
AGATE_MM_SESSION_UNTIL="$(awk -v h="$HOURS" -v now="$(date +%s)" 'BEGIN { printf "%d", now + (h + 1) * 3600 }')"
AGATE_PAYER_SESSION_UNTIL="$AGATE_MM_SESSION_UNTIL"
note "  the maker and the payer get $AGATE_MM_SESSION_MON and $AGATE_PAYER_SESSION_MON MON on top of their daily budget, once, until $(utc_fmt "$AGATE_MM_SESSION_UNTIL" +%H:%M) UTC (AGATE_*_SESSION_MON, AGATE_*_SESSION_UNTIL)"
"$KIT/deploy-index.sh" testnet-demo ${FLAGS[@]+"${FLAGS[@]}"}
"$KIT/deploy-market.sh" demo ${FLAGS[@]+"${FLAGS[@]}"}
"$KIT/up.sh" demo --restart-shared ${FLAGS[@]+"${FLAGS[@]}"}
say "demo session running; stop it with: ops/testnet/demo-session.sh stop$([ "$KIT_FORK" = 1 ] && echo ' --fork')"
