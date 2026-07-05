---
type: DataSource
title: Fyers 5-min candles
description: >
  Fyers live 5-min candles (equity + current-month future) + futures OI for the
  tradeable F&O universe — the SOLE candle source since 2026-07-03. Stored in
  fyers_candles, TODAY ONLY (pruned each cycle). Feeds indicators, spot plan, scorecard.
resource: lib/fyers/candle-store.ts
tags: [data-source, fyers, candles, oi, 5-min]
timestamp: 2026-07-05T00:00:00Z
---

# Fyers 5-min candles

The **sole candle source** since 2026-07-03 (the Dhan candle path was removed).
`lib/fyers/` polls Fyers and writes `fyers_candles`.

## What it stores

- 5-min candles for **EQ** and current-month **FUT** for the tradeable F&O
  universe (non-index, non-'avoid'-band [fno_stocks](../universe/fno-stocks.md)
  + explicit enrollments).
- `bucketTs` = bar-START epoch seconds on a 300s grid.
- FUT rows carry live futures **OI** (`oi`) attached to the bucket current at
  sample time, plus depth extras (`pdoi`, `oiPct`, `atp`/VWAP, `dayVolume`,
  `buyQty`/`sellQty`, `futLtp`). EQ rows have `oi = 0` (Fyers history has no OI).
- `nseOiPct` — NSE's combined OI %-change, stored verbatim (the one non-Fyers column).

## ⚠ Today only

Only **today's** rows are retained (pruned each poller cycle). Consequences:
- The [same-day scorecard](../playbooks/scorecard-review.md) MUST run same-day —
  the store clears overnight.
- The [replay benchmark](../method/point-in-time-replay.md) can only replay dates
  that have both `fyers_candles` AND `oi_intraday` coverage.

## Auth / build notes

Undocumented TOTP login. `protobufjs` build is denied in `pnpm-workspace.yaml`.

## Used by

[Indicators](../indicators/index.md) (ATR/Supertrend/VWAP), the [spot plan](../engine/spot-plan.md)
(last-candle SL, opening range), and the [scorecard](../playbooks/scorecard-review.md).

## Related

- [dhan.md](dhan.md) · [tables.md](tables.md) · [method/point-in-time-replay.md](../method/point-in-time-replay.md)
