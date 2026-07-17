#!/usr/bin/env bash
# Box auto-stop — powers the EC2 instance OFF to save cost, but ONLY when safe.
# Runs from root cron every 10 min (offset from auto-deploy.sh). The morning
# START is handled externally by AWS EventBridge (a stopped box can't start
# itself); this is only the STOP half.
#
# The instance's instance-initiated-shutdown-behavior is 'stop' (verified), so
# `shutdown -h now` STOPS the instance (billing pauses, Elastic IP + disk kept) —
# it never terminates it.
#
# Powers off only when ALL hold:
#   1. AUTO_SHUTDOWN feature toggle is ON  (operator opt-in, flippable from /config;
#      fail-safe OFF when the row/table is absent — so it never stops unexpectedly)
#   2. no auto-trade position is open/placing/pending  (never stop mid-trade)
#   3. inside the stop window: a weekday at/after 16:30 IST, OR any time on a weekend
#      (16:30 is after the 15:12 square-off AND the 16:00 EOD scorecard)
set -euo pipefail
LOG=/opt/projectr/autostop.log
say() { echo "$(TZ=Asia/Kolkata date '+%Y-%m-%d %H:%M:%S IST') | $*" >> "$LOG"; }

# 1. Time window (IST). DOW: 1=Mon .. 7=Sun.
DOW=$(TZ=Asia/Kolkata date '+%u')
HHMM=$(TZ=Asia/Kolkata date '+%H%M')
in_window=0
if [ "$DOW" -ge 6 ]; then
  in_window=1                      # weekend — any time
elif [ "$HHMM" -ge 1630 ]; then
  in_window=1                      # weekday — 16:30 IST or later
fi
[ "$in_window" = "1" ] || exit 0

# 2. AUTO_SHUTDOWN toggle (read the app DB read-only; fail-safe "0").
ON=$(sudo docker cp /opt/projectr/checkshutdown.js projectr:/tmp/checkshutdown.js >/dev/null 2>&1 \
  && sudo docker exec projectr node /tmp/checkshutdown.js 2>/dev/null || echo "0")
[ "$ON" = "1" ] || exit 0          # toggle off (or unreadable) — stay up, no log spam

# 3. Open-position guard (reuse the deploy guard's checker).
OPEN=$(sudo docker cp /opt/projectr/checkopen.js projectr:/tmp/checkopen.js >/dev/null 2>&1 \
  && sudo docker exec projectr node /tmp/checkopen.js 2>/dev/null || echo "ERR")
if [ "$OPEN" = "ERR" ]; then
  say "skip: could not read open-position count — not stopping"
  exit 0
fi
if [ "$OPEN" != "0" ]; then
  say "skip: $OPEN position(s) open/placing/pending — not stopping"
  exit 0
fi

say "AUTO_SHUTDOWN on, flat, in window (DOW=$DOW $HHMM IST) — powering off"
shutdown -h now
