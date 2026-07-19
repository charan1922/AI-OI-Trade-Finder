# 07 — Saving money: auto on/off

[← Jobs that run by themselves](06-jobs-that-run-by-themselves.md) · Next: [Everyday commands →](08-everyday-commands.md)

---

**Status: built and live (2026-07-17), switched OFF by default.** Flip
**`AUTO_SHUTDOWN`** on `/config` to enable it; until then the box stays up 24×7 and
nothing powers off. Manual `box:start`/`box:stop` work either way.

The box only needs to be up for the trading day. Powering it off outside those hours
(and all weekend) cuts idle cost with no data loss — a stopped instance keeps its
Elastic IP and EBS volume.

## The core constraint

**A stopped EC2 instance can't start itself.** Nothing on the box — no cron, no app
code — can wake it, because nothing is running. So the design is two independent
halves:

### Start (must be external): EventBridge Scheduler

An **AWS EventBridge Scheduler** schedule — `projectr-start-box-weekday-0815-ist`,
`cron(15 8 ? * MON-FRI *)` in `Asia/Kolkata` — issues `StartInstances` at **08:15 IST,
Mon–Fri**, and never fires on weekends. It runs in AWS, not on the box, so it's the only
thing that can wake a stopped instance. It assumes a least-privilege IAM role
(`ProjectR-BoxScheduler`: `ec2:StartInstances` on this one instance, nothing else).
Effectively free (free tier is 14M invocations/month; we use ~1/day), and EC2
start/stop API calls cost nothing.

> The **start half ignores `AUTO_SHUTDOWN`** — it starts the box every weekday morning
> regardless (starting an already-running box is a harmless no-op). Only the *stop* half
> is toggle-gated. To stop the morning starts entirely, disable the schedule in AWS.

### Stop (on the box): a guarded, toggleable cron

`/opt/projectr/autostop.sh` (source of truth: `deploy/box/autostop.sh`) runs from root
cron at `5,15,25,35,45,55` — offset from the deploy job at `*/10`. It powers the box off
only when **all four** hold:

1. **In window** — a weekday at/after **16:30 IST**, or any time at the weekend.
2. **Not just started, and not held** — see [operator override](#operator-override) below.
3. **Toggle on** — the `AUTO_SHUTDOWN` switch on `/config` is ON. Read from the app DB by
   `checkshutdown.js`, which **fail-safes to OFF** on any error/missing row, so it never
   stops unexpectedly.
4. **Flat** — no open/placing/pending trade (reuses `checkopen.js`, the same check the
   deploy guard uses). It will not power off mid-trade regardless of the clock.

`AUTO_SHUTDOWN` defaults **OFF**, so during live testing the box stays up 24×7 with no
surprise shutdowns. Flip it ON from `/config` once you want the cost saving.

### Operator override

Added 2026-07-19, after the cron powered a hand-started box back off within minutes on a
weekend. A deliberate `pnpm box:start` used to be **invisible** to this script — on a
weekend every tick is "in window", so it stopped the box at the next `:05/:15/:25/…`
regardless. The only escape was racing the cron to the `/config` toggle, which needs the
app up. Two overrides now make the operator win:

**a. Post-start grace.** The box is never stopped within **45 minutes** of boot
(`AUTOSTOP_GRACE_MIN` to change). Any start — manual or the 08:15 EventBridge one —
always buys a usable window. It never interferes with the normal 16:30 weekday stop,
by which time the box has been up ~8h.

**b. Hold file.** While `/opt/projectr/autostop.hold` exists and hasn't expired, the box
stays up:

```bash
sudo touch /opt/projectr/autostop.hold                          # hold indefinitely
date -d '+4 hours' +%s | sudo tee /opt/projectr/autostop.hold   # hold 4h, then auto-resume
sudo rm -f /opt/projectr/autostop.hold                          # release early
```

An **expired** hold file is deleted automatically and normal auto-stop resumes — a
forgotten hold can't keep the box (and the bill) running forever.

> **This script is NOT in the Docker image.** It's a host-level cron script, so
> `git push …:prod` does **not** ship it. After changing `deploy/box/autostop.sh` you
> must copy it to the box yourself — see [08](08-everyday-commands.md#updating-the-box-cron-scripts).

**Safe by construction:** the instance's *instance-initiated shutdown behavior* is
`stop` (verified), so `shutdown -h now` **stops** the box — it can never terminate it.
The Elastic IP and the EBS volume (your database) are retained.

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

## Status — all built (2026-07-17)

- ✅ EventBridge start schedule + its IAM role. Verified: schedule `ENABLED`, and
  `aws iam simulate-principal-policy` on the role returns **`allowed`** for
  `ec2:StartInstances` on the box.
- ✅ `autostop.sh` + `checkshutdown.js` installed to `/opt/projectr/`, in root cron.
  Verified live at **16:32 IST on a Friday** (in-window, flat): toggle OFF → correctly
  did **not** stop.
- ✅ `AUTO_SHUTDOWN` toggle on `/config`, and manual `box:*` scripts ([08](08-everyday-commands.md)).
- ⬜ **Not yet exercised end-to-end**: no real 08:15 start or 16:30 stop has run yet
  (the toggle is OFF). Watch the first enabled weekday — check `/opt/projectr/autostop.log`
  and that the box is up before 09:15.

## Troubleshooting

| Symptom | Check |
|---|---|
| Box didn't stop in the evening | `tail /opt/projectr/autostop.log`; is the toggle ON? was a trade open? is it ≥16:30 IST? Is a hold file present (`ls -l /opt/projectr/autostop.hold`) or was it started <45 min ago? A silent no-op = toggle OFF (by design, no log spam). |
| Box powers off right after I start it | Expected before 2026-07-19; fixed by the 45-min post-start grace. If it still happens, the box is running the OLD script — re-copy it ([08](08-everyday-commands.md#updating-the-box-cron-scripts)). For a long session use the hold file. |
| Box didn't start in the morning | `aws scheduler get-schedule --region ap-south-1 --name projectr-start-box-weekday-0815-ist` → `State: ENABLED`? Was it a weekday? |
| Stopped mid-trade (must never happen) | `checkopen.js` output + `autostop.log`. Report it — the guard is the hard line. |

---

**Takeaway:** EventBridge wakes the box on weekday mornings (the only way to start a
stopped box); a guarded, `AUTO_SHUTDOWN`-toggled cron stops it after 16:30 and on
weekends. Overnight jobs survive because bhavcopy backfills on boot. It's all built and
switched OFF — flip `AUTO_SHUTDOWN` on `/config` when you want it.

Next: [the commands you'll actually run →](08-everyday-commands.md)
