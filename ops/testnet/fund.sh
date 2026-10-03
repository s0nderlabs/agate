#!/usr/bin/env bash
# Prints every role key's MON balance and what the chosen plan needs; with --send tops each key up from the deployer
# (agate.deployer), one plain transfer per key, never taking the deployer under its reserve.
#
#   ops/testnet/fund.sh [--days N] [--sessions M] [--hours H] [--reserve R] [--send] [--dry-run] [--fork]
#
#   --days N       days the real-calendar index runs (default 12: through the Oct 14 submission close and a margin)
#   --sessions M   demo sessions (default 2), each --hours H long (default 5: a 30-demo-day month)
#   --reserve R    MON the deployer keeps after the top-ups and its own deploys (default 50)
#
# The figures are Monad's billing of the gas LIMIT at AGATE_KIT_GAS_GWEI (default 102) gwei, from wall/README.md
# (the wall's measured limits), docs/market BOTS-SPEC section 7 (the bots), and the fork rehearsal of this kit
# (the deploys). The bots set each limit from the chain's own estimate, and Monad's estimates of their calls run 1.0 to
# 1.7 times the fork's (by call), so the maker's and the payer's figures are multiplied by AGATE_KIT_BOT_FACTOR
# (default 1.5). Every sending key also keeps a 10 MON floor (Monad's reserve balance); the payer is funded to stay
# over its 60 MON low-balance alert. The plan is a ceiling: KEY_LOW and the bots' own daily budgets pace the real spend.
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

DAYS=12
SESSIONS=2
HOURS=5
RESERVE=50
SEND=0
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --days) DAYS="${2:?}"; shift 2 ;;
    --sessions) SESSIONS="${2:?}"; shift 2 ;;
    --hours) HOURS="${2:?}"; shift 2 ;;
    --reserve) RESERVE="${2:?}"; shift 2 ;;
    --send) SEND=1; shift ;;
    *) args+=("$1"); shift ;;
  esac
done
kit_parse ${args[@]+"${args[@]}"}
[ "${#KIT_POS[@]}" = 0 ] || die "usage: $0 [--days N] [--sessions M] [--hours H] [--reserve R] [--send] [--dry-run] [--fork]"
for v in "$DAYS" "$SESSIONS" "$HOURS" "$RESERVE" "$BOT_FACTOR"; do
  case "$v" in '' | *[!0-9.]*) die "numbers only: $v" ;; esac
done
need_tools cast jq bun
check_fork

# MON at 102 gwei, scaled to GAS_GWEI below. Per real day of the real-calendar index (wall/README.md "MON a real day
# per key"). Per real hour of a demo session: the wall's shipped limits (the DEMO column / 24; the keeper's is its
# worst case, every GPU carried), raised where the fork rehearsal measured more (standby 3.96 an hour against 3.65;
# measured over 46 minutes: primary 5.79, attester 0.25, keeper 0.65, maker 4.11, payer 4.69 with its one-off
# listing of six series and markets, 3.6 MON; the maker 5.13 in a 47-minute run with two users trading against it, so
# 5.20). The deploys: the fork's gas limits (2.47, 0.75, 1.39, 1.26 MON) with a margin.
P_PRIMARY_DAY=4.53; P_STANDBY_DAY=3.65; P_ATTESTER_DAY=0.06; P_KEEPER_DAY=0.30
D_PRIMARY_H=7.42; D_STANDBY_H=4.00; D_ATTESTER_H=0.39; D_KEEPER_H=1.83
P_MAKER_DAY=0.50; P_MAKER_ONCE=2.00; D_MAKER_H=5.20
P_PAYER_ONCE=3.70; P_PAYER_DAY=0.50; D_PAYER_SESSION=4.00; D_PAYER_H=0.50
DEPLOY_INDEX_PROD=3.00; DEPLOY_INDEX_DEMO=1.00; DEPLOY_MARKET_PROD=2.00; DEPLOY_MARKET_DEMO=1.50
FLOOR=10; PAYER_LOW=60; MAKER_KEEP=20; PAYER_KEEP=15

calc() { awk "BEGIN { printf \"%.2f\", ($1) * $GAS_GWEI / 102 }"; }
plus() { awk "BEGIN { printf \"%.2f\", $1 }"; }
PROD_DONE=0
[ "$(records_get .production.status)" = deployed ] && PROD_DONE=1
MKT_DONE=0
[ -f "$KIT_DEPLOYMENTS" ] && [ -n "$(jq -r '.factories.real.factory // empty' "$KIT_DEPLOYMENTS")" ] && MKT_DONE=1

need_of() {
  local d="$DAYS" m="$SESSIONS" h="$HOURS"
  case "$1" in
    owner) calc "$( [ "$PROD_DONE" = 1 ] && echo 0 || echo "$DEPLOY_INDEX_PROD") + $m * $DEPLOY_INDEX_DEMO + 2" ;;
    deployer) calc "$( [ "$MKT_DONE" = 1 ] && echo 0 || echo "$DEPLOY_MARKET_PROD") + $m * $DEPLOY_MARKET_DEMO" ;;
    primary) plus "$(calc "($d + 1) * $P_PRIMARY_DAY + $m * $h * $D_PRIMARY_H") + $FLOOR" ;;
    standby) plus "$(calc "($d + 1) * $P_STANDBY_DAY + $m * $h * $D_STANDBY_H") + $FLOOR" ;;
    attester) plus "$(calc "$d * $P_ATTESTER_DAY + $m * $h * $D_ATTESTER_H") + $FLOOR" ;;
    keeper) plus "$(calc "$d * $P_KEEPER_DAY + $m * $h * $D_KEEPER_H") + $FLOOR" ;;
    bot) plus "$(calc "$BOT_FACTOR * ($P_MAKER_ONCE + $d * $P_MAKER_DAY + $m * $h * $D_MAKER_H)") + $MAKER_KEEP" ;;
    payer) plus "$(calc "$BOT_FACTOR * ($P_PAYER_ONCE + $d * $P_PAYER_DAY + $m * ($D_PAYER_SESSION + $h * $D_PAYER_H))") + $PAYER_LOW" ;;
    guardian | kick) echo "0.00" ;;
  esac
}

say "fund: $(kit_mode_line)"
note "plan: the real-calendar index for $DAYS days, $SESSIONS demo session(s) of $HOURS h, at $GAS_GWEI gwei, the bots' fork figures x $BOT_FACTOR; deployer reserve $RESERVE MON"
printf '\n%-9s %-42s %12s %10s %10s\n' role address "balance MON" need "top-up"
TRANSFERS=""
TOTAL=0
for r in owner primary standby attester keeper guardian kick bot payer deployer; do
  a="$(role_addr "$r")"
  b="$(balance_mon "$a")"
  n="$(need_of "$r")"
  t="0.00"
  if [ "$b" != "?" ] && [ "$r" != deployer ]; then
    t="$(awk -v n="$n" -v b="$b" 'BEGIN { x = n - b; if (x < 0) x = 0; printf "%.2f", (x > 0 ? int(x + 0.999) : 0) }')"
  fi
  printf '%-9s %-42s %12.2f %10s %10s\n' "$r" "$a" "$( [ "$b" = "?" ] && echo 0 || echo "$b")" "$n" "$t"
  if [ "$t" != "0.00" ]; then
    TRANSFERS="$TRANSFERS,$a=$(printf '%.0f' "$t")"
    TOTAL="$(plus "$TOTAL + $t")"
  fi
  [ "$r" = deployer ] && DEPLOYER_BAL="$b" && DEPLOYER_NEED="$n"
done
TRANSFERS="${TRANSFERS#,}"
note ""
note "top-ups from the deployer: $TOTAL MON in $(echo "$TRANSFERS" | tr ',' '\n' | grep -c . || true) transfer(s)"
if [ "$DEPLOYER_BAL" != "?" ]; then
  LEFT="$(plus "$DEPLOYER_BAL - $TOTAL - $DEPLOYER_NEED")"
  note "deployer after the top-ups and its own deploys: $LEFT MON (reserve $RESERVE)"
  if awk -v l="$LEFT" -v r="$RESERVE" 'BEGIN { exit !(l < r) }'; then
    die "the plan takes the deployer under its reserve: fund less (fewer --days, --sessions or --hours) or lower --reserve; nothing sent"
  fi
fi

if [ "$SEND" = 0 ]; then
  note "nothing sent (add --send to send these top-ups)"
  exit 0
fi
[ -n "$TRANSFERS" ] || { note "every key already holds its plan: nothing to send"; exit 0; }
say "top-ups, signed by the deployer"
send_as deployer AGATE_DEPLOYER_KEY transfers "$TRANSFERS"
