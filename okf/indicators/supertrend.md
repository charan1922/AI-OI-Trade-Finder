---
type: Indicator
title: Supertrend(10, 3)
description: >
  Standard Supertrend on the 5-min bars — bands at (H+L)/2 ± 3×ATR(10) with the
  band-ratchet and close-cross flip rules. Reports direction (up/down), the
  trailing line, and bars-in-trend. Display evidence; misalignment is flagged.
resource: lib/signals/indicators.ts
tags: [indicator, supertrend, trend, direction]
timestamp: 2026-07-05T00:00:00Z
---

# Supertrend(10, 3) — `supertrend(bars, period=10, multiplier=3)`

Trend direction + trailing-stop line on the 5-min series.

## Definition

```
mid        = (H + L) / 2
basicUpper = mid + 3·ATR(10)
basicLower = mid − 3·ATR(10)
# Band ratchet — bands only tighten while price respects them:
upper = (basicUpper < upper || prevClose > upper) ? basicUpper : upper
lower = (basicLower > lower || prevClose < lower) ? basicLower : lower
# Close-cross flip:
if dir=='up'   && close < lower: dir = 'down'
if dir=='down' && close > upper: dir = 'up'
line = dir=='up' ? lower : upper
```

- ATR here is a Wilder ATR(10) series aligned to the bars.
- Returns **null** when there are fewer than `period + 2` bars.
- Result: `{ direction: 'up'|'down', line, barsInTrend }` (`barsInTrend` = 1 means
  it just flipped on the latest bar).

## Use — display evidence, flagged not gated

On each pick: `supertrend` + `supertrendAligned` (does it agree with the pick's
direction?). Misalignment is surfaced with a ⚠ — **misaligned picks went 0/3 on
the replay benchmark** — but it does NOT block the pick (Supertrend needs more
recorded days before it earns a gate/weight). See [engine/scoring.md](../engine/scoring.md).

## Related

- [atr.md](atr.md) · [vwap.md](vwap.md) · [engine/scoring.md](../engine/scoring.md)
