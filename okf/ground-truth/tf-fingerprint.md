---
type: GroundTruth
title: TradeFinder pick fingerprint
description: >
  The documented signature of TF's real trades — near-ATM stock options, entries
  10:00–10:40, current-month expiry, futures OI ≈1.25–1.35× 20d avg, turnover
  ≥1.2×, direction agreeing; range-expansion spread dominant; options-led builds count.
resource: lib/trade-suggest/config.ts
tags: [ground-truth, tradefinder, fingerprint]
timestamp: 2026-07-05T00:00:00Z
---

# TradeFinder pick fingerprint

From TF's real tickets (`data/tradefinder_platform_trades.json`) + repo docs.

## The trade shape

- **Near-ATM stock options** (CE and PE), delta ~0.5 — best liquidity/gamma for
  intraday momentum buying.
- Entries cluster **10:00–10:40**, after the opening range is set → the
  [09:40–11:00 window](../engine/window.md).
- **Current-month expiry.**

## The signal fingerprint (→ the [gates](../engine/gates.md))

- Futures **OI level ≈ 1.25–1.35×** the 20-day average (gate at 1.1×).
- **Turnover ≥ 1.2×** the average (the quality pillar).
- Futures **direction agreeing** with the option side.
- Entry only after the 9:45 opening range is set.

## Two model views of TF

1. **Intraday (live scan):** the [R-Factor](../models/r-factor.md) +
   [composite score](../engine/scoring.md).
2. **EOD (leaderboard):** the parent-validated **spread-linear model
   `R = 1.56 × spread ratio`** — TF's R-Factor is dominated by the
   [range-expansion spread](../factors/range-spread.md). TF's R-Factor is computed
   once per day (values don't change as LTP moves — likely from EOD/bhavcopy).

## Options-led builds (don't miss them)

TF winners sometimes have weak futures OI but strong combined OI. 2026-07-03:
**SUNPHARMA** futures OI 0.90× avg but NSE combined +8.1% — TF's winner of the day
(1920 CE). Hence the OI gate's [combined-OI OR path](../engine/gates.md#the-oi-evidence-or-important).

## Related

- [calibration.md](calibration.md) · [tf-snapshots.md](tf-snapshots.md) · [engine/gates.md](../engine/gates.md)
