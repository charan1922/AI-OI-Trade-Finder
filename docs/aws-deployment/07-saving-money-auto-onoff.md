# 07 — Saving money: auto on/off

[← Jobs that run by themselves](06-jobs-that-run-by-themselves.md) · Next: [Everyday commands →](08-everyday-commands.md)

---

The box only needs to be up for the trading day. Powering it off outside those hours
(and all weekend) cuts idle cost with no data loss — a stopped instance keeps its
Elastic IP and EBS volume.

## The core constraint

**A stopped EC2 instance can't start itself.** Nothing on the box — no cron, no app
code — can wake it, because nothing is running. So the design is two independent
halves:

### Start (must be external): EventBridge Scheduler

An **AWS EventBridge Scheduler** rule (runs in AWS, not on the box) issues
`StartInstances` at **08:15 IST, Mon–Fri**, and never fires on weekends. This is the
only thing that can wake a stopped box. It's effectively free (free tier is 14M
invocations/month; we use ~1/day), and EC2 start/stop API calls cost nothing.

### Stop (on the box): a guarded, toggleable cron

A cron on the box powers it off at **~16:30 IST** on weekdays and keeps it off on
weekends — but only when **both** conditions hold:

1. **Flat** — no open/placing/pending trade (reuses the same open-position check the
   deploy guard uses). It will not power off mid-trade regardless of the clock.
2. **Toggle on** — the in-app `AUTO_SHUTDOWN` switch on `/config` is ON.

`AUTO_SHUTDOWN` defaults **OFF**, so during live testing the box stays up 24×7 with no
surprise shutdowns. Flip it ON from `/config` once you want the cost saving.

## Why 16:30 and why the overnight jobs still work

- **16:30** is after the 15:12 square-off *and* after the 16:00 EOD scorecard, so the
  scorecard always completes before shutdown (see [06](06-jobs-that-run-by-themselves.md)).
- The **01:00 bhavcopy sync** is skipped while the box sleeps, but it self-heals on the
  08:15 startup (backfills the missed weekday before the 09:15 open). Token warm-up
  (08:40–09:15) is inside the on-window.

## Timeline (a normal week)

```
Mon–Fri:  08:15 EventBridge starts  →  trading day  →  16:30 box self-stops (if flat + toggle on)
Sat–Sun:  no start fires            →  box stays off all weekend
Mon:      08:15 start  →  ~08:16 bhavcopy backfills Fri's file  →  ready before 09:15
```

## Status

- ✅ `AUTO_SHUTDOWN` toggle on `/config`, and manual `box:*` scripts ([08](08-everyday-commands.md)).
- ⏳ Remaining wiring: the EventBridge start rule + the box-side stop cron.

---

**Takeaway:** EventBridge wakes the box on weekday mornings (the only way to start a
stopped box); a guarded, `AUTO_SHUTDOWN`-toggled cron stops it after 16:30 and on
weekends. Overnight jobs survive because bhavcopy backfills on boot.

Next: [the commands you'll actually run →](08-everyday-commands.md)
