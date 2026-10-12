#!/bin/sh
# The labeled test trader's launcher (RUNBOOK "The labeled test trader"): runs client/scripts/test-trader.ts with a clean
# environment and starts it again 30 s after a crash. It holds no key: the bot reads it from the Keychain at each start.
# A stop (exit 0, Ctrl-C) or a refusal an operator must fix (exit 2: a bad option, the key command, a state file it
# cannot read) ends the loop. Options pass through to the bot (--month, --markets).
cd "$(dirname "$0")/../../client" || exit 1
BUN=$(command -v bun) || { echo "test-trader: bun not found on PATH"; exit 1; }
while :; do
  env -i HOME="$HOME" PATH="$PATH" USER="$USER" LANG="${LANG:-en_US.UTF-8}" TMPDIR="${TMPDIR:-/tmp}" TERM="${TERM:-xterm}" \
    AGATE_TEST_TRADER_KEY_CMD='security find-generic-password -s agate.test.user -a private-key -w' \
    "$BUN" run scripts/test-trader.ts "$@"
  rc=$?
  case "$rc" in 0 | 2 | 130 | 143) echo "test-trader stopped (exit $rc)"; break ;; esac
  echo "test-trader exited $rc: restarting in 30 s"; sleep 30
done
