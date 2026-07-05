---
type: Factor
title: Put-Call OI ratio
description: >
  Put OI ÷ Call OI. > 1.2 put-heavy (bullish lean), < 0.8 call-heavy (bearish
  lean), between = balanced. Strength is log-symmetric around parity. Needs the
  option chain.
resource: lib/r-factor/options.ts
tags: [factor, pcr, put-call-ratio, options, lean]
timestamp: 2026-07-05T00:00:00Z
---

# Put-Call OI ratio (`pcr`)

**Key:** `pcr` · **Default weight:** 0.04 · **Vote:** `buy` / `sell` / `neutral`
· **Function:** `pcrSignal(callOi, putOi)`

## Definition

```
pcr   = putOi / callOi
vote  = pcr > 1.2 ? 'buy'  : pcr < 0.8 ? 'sell' : 'neutral'   # PCR_BULL=1.2, PCR_BEAR=0.8
score = clamp(|ln(pcr)| / ln(2), 0, 1)                        # PCR_SCORE_CAP = 2
```

- **> 1.2** → put-heavy → **bullish** lean.
- **< 0.8** → call-heavy → **bearish** lean.
- Between → balanced / neutral.
- Strength is **log-symmetric** around parity: PCR = 2 or 0.5 → score 1.0.
- Returns `available: false` without both call & put OI.

## Availability

Needs the option chain — unavailable on the futures-only live path.

## Related

- [call-oi](call-oi.md) · [put-oi](put-oi.md)
