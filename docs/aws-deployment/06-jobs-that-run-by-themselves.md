# 06 — Jobs that run by themselves

[← Settings and secrets](05-settings-and-secrets.md) · Next: [Saving money →](07-saving-money-auto-onoff.md)

---

Everything trading-critical runs on the box with **no browser open**. This is the point
of a dedicated server — the market loop can't depend on someone having a page up.

## What starts at boot

`instrumentation.ts` runs once per server start (Node runtime only) and starts three
things:

1. **File-log tee** (`lib/ops/file-log.ts`) — mirrors every console line to
   `data/logs/app-<IST-date>.log` (kept 7 days), so logs survive restarts and are
   viewable at `/logs`.
2. **Fyers poller** (`lib/fyers/poller.ts`) — the 5-minute loop, runs 24×7.
3. **Fast position-guard loop** (`lib/auto-trade/guard-loop.ts`) — ~60s while a
   position is open.

## The autonomous jobs (all gated by `AUTONOMOUS_SERVER=true`)

Gating on that flag is what keeps these on the box and off dev laptops.

| Job | Cadence | What it does |
|---|---|---|
| Market-data capture | every 5m, market hours | Records EQ + FUT 5-min candles + OI into `fyers_candles` (the sole candle source). |
| Autonomous capture | every 5m, market hours | Runs the `/trade-suggest` scan, then the auto-trade decision pass. One AI analysis per cycle. |
| Position guard | ~60s while open, + start of each pass | Deterministic stop / target / square-off. Runs with the LLM down and under the kill switch (exits always allowed). |
| Pre-open token warm-up | 08:40–09:15 IST, trading days | Mints both broker tokens before 09:00. Idempotent → every in-window tick is a free retry. No page needed. |
| EOD bhavcopy sync | after 01:00 IST, once/day | Downloads NSE bhavcopy; backfills the whole missing weekday window. |
| EOD scorecard | after 16:00 IST, once/day | Grades the day's trade-suggest picks vs recorded candles. Local only, no API/AI cost. |

## Two timing details worth knowing

**bhavcopy self-heals if the box slept.** The "already synced today" marker is
in-memory, so a fresh boot re-attempts, and the sync backfills any missed weekday. So
even if the box is off at 01:00, the morning startup (~08:16) pulls yesterday's file
before the 09:15 open. Nothing is lost by powering off overnight.

**The scorecard must run in the evening.** It grades *today's* picks, so it can't move
to the morning. Any auto power-off has to be **after 16:00** or that day's scorecard is
skipped. (This constrains the shutdown time in [07](07-saving-money-auto-onoff.md).)

## Broker tokens

Created **lazily on first use**, never at import. Idempotent, promise-locked, and
disk-cached under `/app/data`, so restarts don't cause repeated logins.

---

**Takeaway:** the box runs the full loop headlessly — capture, auto-trade, guard, token
warm-up, and the two EOD jobs — all behind `AUTONOMOUS_SERVER`. bhavcopy self-heals on
morning boot; the scorecard pins the earliest safe shutdown to after 16:00.

Next: [powering the box off to save money →](07-saving-money-auto-onoff.md)
