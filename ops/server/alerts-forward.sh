#!/bin/bash
# Runs on the local machine: shows the server's action alerts as macOS notifications. On Linux, notify.sh spools each action
# alert's code and index (never its message) to ~/.agate-wall/notify-spool.jsonl; this loop reads the new lines over
# the tailnet every minute and hands each to ops/testnet/notify.sh, the same notifier the local machine's own robots use.
#
#   ops/server/alerts-forward.sh      (AGATE_SERVER_SSH, default "agate-1" through ~/.ssh/agate.conf)
#
# The read offset moves only after a read that worked, and only past whole lines (a line still being written waits a
# minute). On the first start, with no offset file, the alerts already in the spool are history and are not shown.
KIT="$(cd "$(dirname "$0")/../testnet" && pwd)"
HOST="${AGATE_SERVER_SSH:-agate-1}"
CONF="${AGATE_SERVER_SSH_CONFIG:-$HOME/.ssh/agate.conf}"
OFF_FILE="${AGATE_KIT_STATE:-$HOME/.agate-kit}/notify-spool.offset"
SPOOL=".agate-wall/notify-spool.jsonl"
NL=$'\n'
mkdir -p "$(dirname "$OFF_FILE")"
while :; do
  off="$(cat "$OFF_FILE" 2>/dev/null || echo 0)"
  case "$off" in '' | *[!0-9]*) off=0 ;; esac
  # one call: the spool's size on the first line, then the bytes past the offset; the trailing x survives $( )'s
  # newline trimming and is printed only when ssh succeeded
  size=""
  if out="$(ssh -F "$CONF" -o ConnectTimeout=20 "$HOST" "s=\$(stat -c %s $SPOOL 2>/dev/null || echo 0); echo \"\$s\"; if [ \"\$s\" -gt $off ]; then tail -c +$((off + 1)) $SPOOL | head -c \$((s - $off)); fi" 2>/dev/null && printf x)"; then
    out="${out%x}"
    size="${out%%"$NL"*}"
    body="${out#*"$NL"}"
    case "$size" in '' | *[!0-9]*) size="" ;; esac
  fi
  if [ -n "$size" ]; then
    if [ ! -f "$OFF_FILE" ]; then
      echo "$size" >"$OFF_FILE"
    elif [ "$size" -lt "$off" ]; then
      echo 0 >"$OFF_FILE" # the spool was rotated: read it from the start next minute
    elif [ "$size" -gt "$off" ]; then
      whole="${body%"${body##*"$NL"}"}"
      printf '%s' "$whole" | while IFS= read -r line; do printf '%s' "$line" | /bin/sh "$KIT/notify.sh"; done
      # the spool holds ASCII only (an alert code, a hex index, digits), so characters are bytes
      echo "$((off + ${#whole}))" >"$OFF_FILE"
    fi
  fi
  sleep 60
done
