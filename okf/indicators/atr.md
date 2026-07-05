---
type: Indicator
title: ATR(14, Wilder)
description: >
  Wilder's Average True Range over the 5-min bars — the volatility/noise unit.
  First ATR = SMA of the first 14 true ranges, then Wilder smoothing. Needs
  period+1 bars. Used to express risk and (optionally) floor the SL.
resource: lib/signals/indicators.ts
tags: [indicator, atr, wilder, volatility, noise]
timestamp: 2026-07-05T00:00:00Z
---

# ATR(14, Wilder) — `atr(bars, period=14)`

The noise / volatility unit for the 5-min series.

## Definition

```
TR_i     = i == 0 ? (H − L)
                  : max(H − L, |H − prevClose|, |L − prevClose|)
firstATR = SMA of the first 14 TRs (after dropping the H−L seed bar)
ATR_i    = (prevATR·13 + TR_i) / 14        # Wilder smoothing
```

- Bars are filtered to usable (`high/low/close > 0`) first.
- Returns **null** when there are fewer than `period + 1` bars (the first TR needs
  a previous close).
- Returns the **latest** ATR value.

## Uses

- **Display:** `atr` + `atrPct` (ATR as % of entry) on each pick — the noise unit
  a trader reads risk against ([engine/scoring.md](../engine/scoring.md)).
- **SL floor (optional):** the [spot plan](../engine/spot-plan.md) can floor risk
  at `SL_ATR_MULT × ATR`. Currently `SL_ATR_MULT = 0` (disabled — % floor only);
  change only with fresh [replay](../method/point-in-time-replay.md) evidence.

## Related

- [supertrend.md](supertrend.md) (uses ATR(10) internally) · [engine/spot-plan.md](../engine/spot-plan.md)
