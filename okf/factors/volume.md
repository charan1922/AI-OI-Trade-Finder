---
type: Factor
title: Volume vs 20-day average
description: >
  Volume ÷ its 20-session average — a supporting confirmation quality factor.
  Non-directional; maxes at 3× the average. Lowest-weighted (0.02).
resource: lib/r-factor/flow.ts
tags: [factor, volume, confirmation, quality]
timestamp: 2026-07-05T00:00:00Z
---

# Volume vs 20-day average (`volume`)

**Key:** `volume` · **Default weight:** 0.02 (lowest tier) · **Vote:** always
`neutral` (quality only) · **Function:** `volumeSignal(volume, volume20dAvg)`

Supporting confirmation vs the 20-session baseline. Weighted lightly because it
largely echoes [turnover](turnover.md) (turnover = volume × price) — it's a
confirmation, not an independent read.

## Definition

```
ratio = volume / volume20dAvg
score = scoreFromRatio(volume, volume20dAvg, 2)   # VOLUME_CAP_EXCESS = 2
      = clamp((ratio − 1) / 2, 0, 1)
```

- At/below the average → 0; at **3×** the average → 1.0.
- Returns `available: false` if either input is non-positive.

## Related

- [turnover](turnover.md) · [smart-money](smart-money.md)
