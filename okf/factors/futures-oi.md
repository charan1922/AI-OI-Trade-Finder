---
type: Factor
title: Futures OI (fresh positioning)
description: >
  Day-over-day futures OI change as an intensity signal — how much fresh
  positioning piled on vs the previous session. Magnitude only; the side comes
  from oi-direction. Maxes at ±10% change.
resource: lib/r-factor/oi.ts
tags: [factor, futures-oi, open-interest, intensity]
timestamp: 2026-07-05T00:00:00Z
---

# Futures OI — fresh positioning (`futuresOi`)

**Key:** `futuresOi` · **Default weight:** 0.10 · **Vote:** always `neutral`
(intensity only) · **Function:** `futuresOiSignal(currentOi, prevOi)`

How much fresh positioning piled on vs the previous session. Intensity ONLY —
OI alone is one long per short and says nothing about direction; the side is
[oi-direction](oi-direction.md)'s job.

## Definition

```
changePct = pctChange(currentOi, prevOi)                 # signed %
score     = scoreFromMagnitude(changePct, 10)            # OI_CHANGE_CAP_PCT = 10
          = clamp(|changePct| / 10, 0, 1)
```

- A daily OI change of **±10%** scores 1.0 (maximal fresh positioning).
- Returns `available: false` if `currentOi` or `prevOi` is non-positive.

## vs. oi-level

- **futures-oi** (this) = *daily change* — how much was added today.
- **[oi-level](oi-level.md)** = *level vs 20-day average* — sustained accumulation.

Both matter: a big daily add on top of an already-elevated level is the strongest
buildup signal.

## Related

- [oi-level](oi-level.md) · [oi-direction](oi-direction.md)
