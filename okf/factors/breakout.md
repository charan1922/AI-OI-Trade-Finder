---
type: Factor
title: Breakout
description: >
  LTP relative to caller-supplied reference levels (prior-day H/L or the opening
  range). A clean break above resistance is bullish, below support bearish;
  inside the range is neutral. A 2% break scores 1.0. Directional.
resource: lib/r-factor/breakout.ts
tags: [factor, breakout, price-action, directional]
timestamp: 2026-07-05T00:00:00Z
---

# Breakout (`breakout`)

**Key:** `breakout` · **Default weight:** 0.06 · **Vote:** `buy` / `sell` /
`neutral` · **Function:** `breakoutSignal(ltp, breakoutHigh, breakoutLow)`

The reference levels are supplied by the caller — e.g. prior-day high/low, or the
9:15–9:45 opening range. In the trade-suggest engine the opening-range breakout
(`orBreakout`) is a co-leading score component — see [engine/scoring.md](../engine/scoring.md).

## Definition

```
if ltp > breakoutHigh:  excess = ltp/breakoutHigh − 1;  vote = 'buy'
if ltp < breakoutLow:   excess = 1 − ltp/breakoutLow;   vote = 'sell'
score = clamp(excess / 0.02, 0, 1)               # BREAKOUT_CAP_EXCESS = 0.02
otherwise (inside range): score 0, vote 'neutral'
```

- Price **2%** beyond the level → score 1.0 (decisive break).
- Inside the reference range → score 0, `neutral` (no breakout yet).
- Returns `available: false` if LTP is non-positive or neither reference level
  is supplied.

## Related

- [range-spread](range-spread.md) · [engine/scoring.md](../engine/scoring.md) · [playbooks/morning-scan.md](../playbooks/morning-scan.md)
