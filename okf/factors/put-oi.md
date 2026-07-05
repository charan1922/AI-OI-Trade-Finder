---
type: Factor
title: Put OI build-up
description: >
  Put open-interest change — build-up reads as fresh support (bullish lean)
  under the standard writer interpretation. A lean, not a verdict. Maxes at ±15%
  change. Needs the option chain.
resource: lib/r-factor/options.ts
tags: [factor, put-oi, options, open-interest, lean]
timestamp: 2026-07-05T00:00:00Z
---

# Put OI build-up (`putOi`)

**Key:** `putOi` · **Default weight:** 0.02 · **Vote:** `buy` (on build-up) /
`neutral` · **Function:** `putOptionOiSignal(currentPutOi, prevPutOi)`

## Definition

```
changePct = pctChange(currentPutOi, prevPutOi)
score     = clamp(|changePct| / 15, 0, 1)        # OPT_OI_CHANGE_CAP_PCT = 15
vote      = changePct > 0 ? 'buy' : 'neutral'     # only build-up carries a lean
```

- Rising put OI → `buy` lean (support building); unwinding → `neutral`.
- Maxes at ±15% change. Returns `available: false` without both put-OI inputs.

## ⚠ Interpretation caveat

Same ambiguity as [call-oi](call-oi.md): rising put OI can be put BUYING
(bearish) OR put WRITING (bullish). This factor uses the **writer interpretation**
(rising put OI = support = bullish lean). A *lean*, not a verdict — 0.02 weight.

## Availability

Needs the option chain — unavailable on the futures-only live path.

## Related

- [call-oi](call-oi.md) · [pcr](pcr.md)
