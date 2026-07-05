---
type: Factor
title: OI vs 20-day average (sustained accumulation)
description: >
  Current futures OI ÷ its 20-session average — the sustained institutional
  buildup a single-day OI change misses. Non-directional level signal; maxes at
  1.5× the 20-day average.
resource: lib/r-factor/oi.ts
tags: [factor, oi-level, open-interest, accumulation, level]
timestamp: 2026-07-05T00:00:00Z
---

# OI vs 20-day average (`oiLevel`)

**Key:** `oiLevel` · **Default weight:** 0.16 (2nd highest) · **Vote:** `neutral`
(level only) · **Function:** `oiVsTwentyDaySignal(currentOi, oi20dAvg)`

The sustained-accumulation level — the signal that a name is carrying an
institutional buildup well above its own norm, which a day-over-day OI change
(see [futures-oi](futures-oi.md)) does not capture.

## Definition

```
level = currentOi / oi20dAvg
score = scoreFromRatio(currentOi, oi20dAvg, 0.5)
      = clamp((level − 1) / 0.5, 0, 1)        # OI_LEVEL_CAP_EXCESS = 0.5
```

- At/below the 20-day average → score 0.
- At **1.5×** the average → score 1.0 (maximal).
- Returns `available: false` if `currentOi` or `oi20dAvg` is non-positive.

## Why it matters

This is the "sustained accumulation" pillar. In the [trade-suggest engine](../engine/gates.md)
the futures OI level has a hard gate of **≥ 1.1×** (`MIN_OI_LEVEL`), matching the
TradeFinder fingerprint (TF picks cluster at ≈ 1.25–1.35× the 20-day average).
Options-led builds that don't show in futures OI are caught by the alternate
NSE-combined-OI path — see [ground-truth/tf-fingerprint.md](../ground-truth/tf-fingerprint.md).

## Related

- [futures-oi](futures-oi.md) (daily change, intensity) · [oi-direction](oi-direction.md) (the side) · [smart-money](smart-money.md) (uses the same level ratio)
