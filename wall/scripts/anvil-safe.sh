#!/bin/sh
# Runs anvil so a test chain can never fill the disk or pile up:
# - pruned history and a private HOME (anvil keeps its state dir there), deleted on exit or on a stop signal;
# - a watchdog that stops anvil once the process that started it is gone, or once free disk drops under the floor;
# - at most AGATE_ANVIL_MAX chains at once for this user (default 12); a new one waits up to
#   AGATE_ANVIL_SLOT_WAIT seconds (default 60) for a slot, then refuses;
# - refuses to start under AGATE_ANVIL_MIN_FREE_GB GB free (default 30) and logs the free space when it stops;
# - sweeps what a kill -9 left behind: the run dirs of dead wrappers (stopping the anvil each one recorded)
#   and their slots.
# Admission and sweeping happen under one short lock, so two starts never race over a slot or a run dir.
# Everything lives under AGATE_ANVIL_ROOT (default ~/.cache/agate-anvil). Usage: anvil-safe.sh [states] [anvil args...]
# (a leading number is how many recent block states anvil keeps in memory: --prune-history <states>).
PARENT="${AGATE_ANVIL_PARENT:-$PPID}"
MAX="${AGATE_ANVIL_MAX:-12}"
MIN_GB="${AGATE_ANVIL_MIN_FREE_GB:-30}"
WAIT_S="${AGATE_ANVIL_SLOT_WAIT:-60}"
ROOT="${AGATE_ANVIL_ROOT:-$HOME/.cache/agate-anvil}"
SLOTS="$ROOT/slots" # one empty file per running wrapper, named by its pid
LOCK="$ROOT/lock"   # a symlink whose target is the holder's pid, so it never exists without one
ME=$$
A=""
H=""

say() { echo "anvil-safe: $*" >&2; }
free_gb() { df -Pk "$ROOT" | awk 'NR==2 { print int($4 / 1048576) }'; }
alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null; }

lock() {
  until ln -s "$ME" "$LOCK" 2>/dev/null; do
    h=$(readlink "$LOCK" 2>/dev/null)
    # a holder killed inside the lock (a few milliseconds) leaves it behind: break it once that pid is gone
    if [ -n "$h" ] && ! alive "$h"; then rm -f "$LOCK"; else sleep 0.1; fi
  done
}
unlock() { [ "$(readlink "$LOCK" 2>/dev/null)" = "$ME" ] && rm -f "$LOCK"; }

# Is pid $1, recorded in run dir $2, still the anvil that dir started? It must look like one of ours, and no
# live run may have recorded the same pid (after reuse it would be another chain's).
ours() {
  ps -o command= -p "$1" 2>/dev/null | grep -q -- "anvil --prune-history" || return 1
  for o in "$ROOT"/run.*; do
    [ "$o" = "$2" ] && continue
    [ "$(cat "$o/anvil.pid" 2>/dev/null)" = "$1" ] && alive "$(cat "$o/wrapper.pid" 2>/dev/null)" && return 1
  done
  return 0
}

# Under the lock. A run dir gets its wrapper's pid under the lock too, so a dir seen here without a live
# wrapper is dead for good. Its anvil is stopped first; the dir is only removed once that anvil is gone.
sweep() {
  for f in "$SLOTS"/*; do
    [ -f "$f" ] && ! alive "${f##*/}" && rm -f "$f"
  done
  for d in "$ROOT"/run.*; do
    [ -d "$d" ] || continue
    alive "$(cat "$d/wrapper.pid" 2>/dev/null)" && continue
    a=$(cat "$d/anvil.pid" 2>/dev/null)
    if alive "$a" && ours "$a" "$d"; then
      kill "$a" 2>/dev/null
      i=0
      while alive "$a" && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
      alive "$a" && kill -9 "$a" 2>/dev/null && sleep 0.2
      if alive "$a" && ours "$a" "$d"; then
        say "could not stop orphan anvil $a; keeping $d for the next sweep"
        continue
      fi
    fi
    rm -rf "$d"
  done
}

# 0 once this wrapper holds a slot and a run dir; 1 if none freed up within WAIT_S seconds.
admit() {
  t=0
  while :; do
    lock
    sweep
    n=0
    for f in "$SLOTS"/*; do [ -f "$f" ] && n=$((n + 1)); done
    if [ "$n" -lt "$MAX" ]; then
      : >"$SLOTS/$ME"
      H=$(mktemp -d "$ROOT/run.XXXXXX") && echo "$ME" >"$H/wrapper.pid"
      unlock
      [ -n "$H" ]
      return
    fi
    unlock
    [ "$t" -ge "$WAIT_S" ] && return 1
    [ "$t" = 0 ] && say "all $MAX anvil slots busy, waiting up to ${WAIT_S}s"
    sleep 1
    t=$((t + 1))
  done
}

cleanup() {
  unlock
  a=${A:-$!} # a stop signal can land between the launch and A=$!
  if [ -n "$a" ]; then
    kill "$a" 2>/dev/null
    wait "$a" 2>/dev/null
  fi
  [ -n "$H" ] && rm -rf "$H"
  rm -f "$SLOTS/$ME"
  [ -n "$a" ] && say "stopped, $(free_gb) GB free"
}
trap cleanup EXIT
trap 'exit 143' INT TERM HUP

mkdir -p "$SLOTS" || exit 1
g=$(free_gb)
if [ "$g" -lt "$MIN_GB" ]; then
  say "only $g GB free (floor $MIN_GB GB): not starting anvil"
  exit 1
fi
if ! admit; then
  say "no anvil slot free after ${WAIT_S}s (max $MAX): not starting anvil"
  exit 1
fi
# The child writes its own pid before it becomes anvil, so even a kill -9 of this wrapper right here leaves a record.
HOME="$H" sh -c 'echo $$ >"$0/anvil.pid"; exec anvil --prune-history "$@"' "$H" "$@" &
A=$!
n=0
while alive "$A" && alive "$PARENT"; do
  sleep 1
  n=$((n + 1))
  if [ $((n % 30)) = 0 ] && [ "$(free_gb)" -lt "$MIN_GB" ]; then
    say "free disk under $MIN_GB GB: stopping anvil"
    break
  fi
done
