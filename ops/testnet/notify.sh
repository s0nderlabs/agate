#!/bin/sh
# AGATE_NOTIFY_CMD for the wall and the bots: an action alert arrives as JSON on stdin; this shows a macOS
# notification naming its code and index. Only the code (A-Z, 0-9, _) and the index's first 8 hex digits reach the
# notification text: no message, page or URL text is ever passed to osascript. The processes run it with PATH and
# HOME only; a broken notifier never stops them.
a="$(head -c 65536)"
code="$(printf '%s' "$a" | sed -n 's/.*"code":"\([A-Z0-9_]\{1,40\}\)".*/\1/p' | head -1)"
ix="$(printf '%s' "$a" | sed -n 's/.*"index":"0x\([0-9a-fA-F]\{8\}\)[0-9a-fA-F]*".*/\1/p' | head -1)"
[ -n "$code" ] || code="ALERT"
/usr/bin/osascript -e "display notification \"$code ${ix:+index $ix}\" with title \"agate\" sound name \"Submarine\"" >/dev/null 2>&1 || true
