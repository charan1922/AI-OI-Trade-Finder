---
type: Factor
title: Turnover vs 20-day average
description: >
  Futures turnover ÷ its 20-session average — real-money participation quality.
  Non-directional; maxes at 3× the average. The third TF pillar (gated at 1.2×
  in the trade-suggest engine).
resource: lib/r-factor/flow.ts
tags: [factor, turnover, participation, quality]
timestamp: 2026-07-05T00:00:00Z
---

# Turnover vs 20-day average (`turnover`)

**Key:** `turnover` · **Default weight:** 0.08 · **Vote:** always `neutral`
(quality only) · **Function:** `turnoverSignal(turnover, turnover20dAvg)`

Real-money participation vs the 20-session baseline — the "quality" pillar
(genuine money is changing hands, not a thin drift).

## Definition

```
ratio = turnover / turnover20dAvg
score = scoreFromRatio(turnover, turnover20dAvg, 2)   # TURNOVER_CAP_EXCESS = 2
      = clamp((ratio − 1) / 2, 0, 1)
```

- At/below the average → 0; at **3×** the average → 1.0.
- Returns `available: false` if either input is non-positive.

## As a gate

The [trade-suggest engine](../engine/gates.md) gates on the turnover factor
**score ≥ 0.1** (`MIN_TURNOVER_SCORE`), which is exactly the 1.2× ratio the TF
fingerprint requires — `(1.2 − 1) / 2 = 0.1`. Gating on the score applies the
pillar without re-deriving the ratio.

> Caveat for the *live equity* turnover ratio shown as display evidence
> (`eqTurnoverRatio`): it assumes uniform intraday pacing, but real volume is
> U-shaped, so mornings over-read ~2×. Treat ≥3–4× as genuinely elevated. That is
> a separate display field ([engine/scoring.md](../engine/scoring.md)), not this
> factor.

## Related

- [volume](volume.md) · [smart-money](smart-money.md) · [engine/gates.md](../engine/gates.md)
