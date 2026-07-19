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
#   1. inside the stop window: a weekday at/after 16:30 IST, OR any time on a weekend
#      (16:30 is after the 15:12 square-off AND the 16:00 EOD scorecard)
#   2. the box has been up longer than the post-start grace, and no operator hold
#      is in force (see "operator override" below)
#   3. AUTO_SHUTDOWN feature toggle is ON  (operator opt-in, flippable from /config;
#      fail-safe OFF when the row/table is absent — so it never stops unexpectedly)
#   4. no auto-trade position is open/placing/pending  (never stop mid-trade)
#
# OPERATOR OVERRIDE (added after the cron powered a hand-started box back off
# within minutes on a weekend — a deliberate `pnpm box:start` used to be
# invisible here, and the only escape was racing the cron to the /config toggle):
#
#   a. Post-start grace — the box is never stopped within GRACE_MIN minutes of
#      boot. Any start (manual or the 08:15 EventBridge one) always buys a
#      usable window. Never affects the normal 16:30 weekday stop, by which
#      time the box has been up ~8h.
#   b. Hold file /opt/projectr/autostop.hold — while it exists and has not
#      expired, the box stays up:
#         sudo touch /opt/projectr/autostop.hold                      # hold indefinitely
#         date -d '+4 hours' +%s | sudo tee /opt/projectr/autostop.hold   # hold 4h, then auto-resume
#         sudo rm -f /opt/projectr/autostop.hold                      # release the hold
#      An expired file is removed automatically, so a forgotten hold cannot
#      keep the box (and the bill) running forever.
set -euo pipefail
LOG=/opt/projectr/autostop.log
HOLD=/opt/projectr/autostop.hold
GRACE_MIN=${AUTOSTOP_GRACE_MIN:-45}
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

# 2a. Post-start grace — an operator who just started the box gets a guaranteed
#     working window. Checked before the docker calls (cheap, and the common
#     case for a hand-started box).
UP_MIN=$(awk '{print int($1/60)}' /proc/uptime)
if [ "$UP_MIN" -lt "$GRACE_MIN" ]; then
  say "skip: box up only ${UP_MIN}m (< ${GRACE_MIN}m post-start grace) — not stopping"
  exit 0
fi

# 2b. Explicit operator hold (indefinite when empty, else an epoch expiry).
if [ -f "$HOLD" ]; then
  UNTIL=$(head -c 32 "$HOLD" 2>/dev/null | tr -dc '0-9' || true)
  if [ -z "$UNTIL" ]; then
    say "skip: operator hold in force (indefinite) — not stopping"
    exit 0
  fi
  if [ "$(date +%s)" -lt "$UNTIL" ]; then
    say "skip: operator hold until $(TZ=Asia/Kolkata date -d "@$UNTIL" '+%Y-%m-%d %H:%M IST') — not stopping"
    exit 0
  fi
  rm -f "$HOLD"
  say "operator hold expired — removed, resuming normal auto-stop"
fi

# 3. AUTO_SHUTDOWN toggle (read the app DB read-only; fail-safe "0").
ON=$(sudo docker cp /opt/projectr/checkshutdown.js projectr:/tmp/checkshutdown.js >/dev/null 2>&1 \
  && sudo docker exec projectr node /tmp/checkshutdown.js 2>/dev/null || echo "0")
[ "$ON" = "1" ] || exit 0          # toggle off (or unreadable) — stay up, no log spam

# 4. Open-position guard (reuse the deploy guard's checker).
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

say "AUTO_SHUTDOWN on, flat, in window (DOW=$DOW $HHMM IST), up ${UP_MIN}m, no hold — powering off"
shutdown -h now
