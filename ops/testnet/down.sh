#!/usr/bin/env bash
# Closes the tmux windows up.sh opened for one index's stack, one at a time, each found by its EXACT name and
# re-resolved to its window id right before it is closed. It never touches a window it did not create: the names it
# knows are listed below, and nothing else (not "bun", the app; not "wall-log", the watcher logger) is ever named.
#
#   ops/testnet/down.sh production [--shared] [--cancel-books] [--dry-run] [--fork]
#   ops/testnet/down.sh demo [--shared] [--cancel-books] [--dry-run] [--fork]
#
# The shared windows (maker, payer, indexer, repair agent, Akash reader, caffeinate) close with the last stack:
# only when the other stack has no window open, or with --shared. --cancel-books first asks the running market maker
# to cancel every resting Kuru order (its kill switch; Kuru orders never expire) and waits two of its ticks.
# Each process gets Ctrl-C (it stops between ticks, releasing its lock), up to 20 s, then its window is closed.
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

usage() {
  echo "usage: $0 <production|demo> [--shared] [--cancel-books] [--dry-run] [--fork]" >&2
  exit 2
}
SHARED_TOO=0
CANCEL=0
ONLY=0
args=()
for a in "$@"; do
  case "$a" in
    --shared) SHARED_TOO=1 ;;
    --cancel-books) CANCEL=1 ;;
    --only-named) ONLY=1 ;;
    *) args+=("$a") ;;
  esac
done
kit_parse ${args[@]+"${args[@]}"}
[ "${#KIT_POS[@]}" = 1 ] || usage
STACK="${KIT_POS[0]}"
case "$STACK" in production | demo) ;; *) usage ;; esac
need_tools tmux
check_tmux_target

# Every window name the kit creates. Nothing outside these lists is ever closed.
PROD_WINDOWS="prod-log prod-primary prod-standby prod-attest prod-keep prod-health prod-pagecheck"
DEMO_WINDOWS="demo-replay demo-log demo-primary demo-standby demo-attest demo-keep demo-health demo-pagecheck"
SHARED_WINDOWS="shared-maker shared-payer shared-indexer shared-repair shared-akash shared-awake"
kit_window() {
  local w
  for w in $PROD_WINDOWS $DEMO_WINDOWS $SHARED_WINDOWS; do [ "$w" = "$1" ] && return 0; done
  return 1
}

any_open() { # any window of the list open?
  local w
  for w in $1; do [ -n "$(win_id "$w")" ] && return 0; done
  return 1
}

close_one() {
  local n="$1" id i
  kit_window "$n" || die "refusing to close \"$n\": not a window this kit creates"
  if [ "$KIT_DRY" = 1 ]; then
    tmx_show list-windows -t "=$TMUX_SESSION" -F '#{window_id} #{window_name}'
    show "(the id of the window named exactly $n, re-read now)"
    tmx_show send-keys -t "<id of $n>" C-c
    tmx_show kill-window -t "<id of $n>"
    return 0
  fi
  id="$(win_id "$n")"
  if [ -z "$id" ]; then
    note "$n: not open"
    return 0
  fi
  tmx send-keys -t "$id" C-c 2>/dev/null || true
  i=0
  while [ "$i" -lt 20 ]; do
    sleep 1
    # re-read by name: the id must still carry this exact name
    [ "$(win_id "$n")" = "$id" ] || break
    [ "$(tmx display-message -p -t "$id" '#{pane_dead}' 2>/dev/null)" = 1 ] && break
    i=$((i + 1))
  done
  if [ "$(win_id "$n")" = "$id" ]; then
    tmx kill-window -t "$id"
    note "$n: closed ($id, after ${i} s)"
  else
    note "$n: gone"
  fi
}

say "down $STACK: $(kit_mode_line)"
note "tmux $([ -n "$TMUX_SOCK" ] && echo "server -L $TMUX_SOCK, ")session $TMUX_SESSION"

if [ "$ONLY" = 1 ]; then
  close_one "${AGATE_KIT_ONLY:?}"
  exit 0
fi

case "$STACK" in
  production) MINE="$PROD_WINDOWS"; OTHER="$DEMO_WINDOWS" ;;
  demo) MINE="$DEMO_WINDOWS"; OTHER="$PROD_WINDOWS" ;;
esac
CLOSE_SHARED="$SHARED_TOO"
if [ "$KIT_DRY" = 0 ] && ! any_open "$OTHER"; then CLOSE_SHARED=1; fi

if [ "$CANCEL" = 1 ] && [ "$KIT_DRY" = 0 ] && any_open "$OTHER"; then
  # the maker has one kill switch for every factory: cancelling the demo books would cancel and freeze production's too
  die "--cancel-books stops the maker on every factory, and the $([ "$STACK" = demo ] && echo production || echo demo) stack is running: nothing closed. Close without --cancel-books (the maker winds each demo month's books down at its end), or stop both stacks"
fi
if [ "$CANCEL" = 1 ]; then
  say "the market maker cancels every resting order (kill switch)"
  show "(cd wall && AGATE_WALL_HOME=$KIT_WALL_HOME bun run apps/marketmaker/src/main.ts kill 'down.sh $STACK')"
  if [ "$KIT_DRY" = 0 ]; then
    [ -n "$(win_id shared-maker)" ] || die "the market maker is not running: start it, or cancel with its kill command (wall/apps/marketmaker/README.md)"
    (cd "$WALL" && AGATE_WALL_HOME="$KIT_WALL_HOME" bun run apps/marketmaker/src/main.ts kill "down.sh $STACK")
    sleep 70
  fi
fi

for n in $MINE; do close_one "$n"; done
if [ "$CLOSE_SHARED" = 1 ]; then
  say "the shared windows"
  for n in $SHARED_WINDOWS; do close_one "$n"; done
else
  note "the shared windows stay open: the other index's stack still runs (--shared closes them too)"
fi
if [ "$KIT_DRY" = 1 ]; then
  note "(dry run: the shared windows close too when no window of the other stack is open, or with --shared)"
fi
say "down $STACK: done"
