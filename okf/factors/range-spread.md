---
type: Factor
title: Range-expansion spread
description: >
  Today's (High−Low)/Close vs its 20-day average — the "spread" TradeFinder's
  R-Factor is dominated by. A U-shaped quadratic: unusually tight (coiled) OR
  unusually wide (breaking out) both score high. Non-directional intensity.
resource: lib/r-factor/range-spread.ts
tags: [factor, range-spread, spread, tradefinder, intensity, provisional]
timestamp: 2026-07-05T00:00:00Z
---

# Range-expansion spread (`rangeSpread`)

**Key:** `rangeSpread` · **Default weight:** 0.18 (highest) · **Vote:** always `neutral`
(intensity only) · **Function:** `rangeSpreadSignal(high, low, close, ratio20dAvg)`

The single best predictor of TradeFinder's R-Factor found so far — but
**date-dependent** (see caveat). This is the daily-**RANGE** expansion, NOT the
bid-ask spread ([that is a separate factor](bid-ask-spread.md)).

## Definition

```
todayRatio = (high − low) / close
ratio      = todayRatio / ratio20dAvg        # vs the 20-day average of (H−L)/Close
s          = clamp(ratio, 0, 4)              # RATIO_CAP = 4, avoids blow-ups
quad       = 2.45 − 1.86·s + 0.95·s²         # ≈ [1.5 .. 5.5], reverse-engineered from TF
score      = clamp((quad − 1) / 4, 0, 1)     # map onto the 1–5 → [0,1] convention
```

`high`/`low` are the session high/low (intraday-so-far on the live path, EOD on
the bhavcopy path); `close` is the LTP. Returns `available: false` if any input
is non-positive or `high < low`.

## Shape (the quadratic is U-shaped)

| `ratio` | Reading |
|---------|---------|
| `< 0.7` | contracted (coiled) — scores high |
| `0.7 – 1.5` | normal range — scores low |
| `> 1.5` | expanded (breaking out) — scores high |

A coiled OR a breaking-out stock both score high; a normal-range stock scores
low. Which way it *resolves* comes from the [directional factors](index.md#two-kinds-of-factor).

## Provenance

The quadratic `R ≈ 2.45 − 1.86·s + 0.95·s²` is the parent project's
reverse-engineered fit of TF's R-Factor against the range ratio `s`.

## ⚠ Caveat — date-dependent

Calibration (2026-06-23) showed the relationship is strong on some sessions,
weak on others: 2026-03-20 scored 7/10 top-10 (Spearman 0.70), 2026-03-19 scored
1/10 (Spearman −0.20). The 0.18 weight is **provisional** pending more captured
TF days. See [ground-truth/calibration.md](../ground-truth/calibration.md).

## Related

- [oi-level](oi-level.md) · [breakout](breakout.md) · [ground-truth/tf-fingerprint.md](../ground-truth/tf-fingerprint.md)
