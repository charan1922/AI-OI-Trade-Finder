---
type: Factor
title: Call OI build-up
description: >
  Call open-interest change — build-up reads as fresh resistance (bearish lean)
  under the standard writer interpretation. A lean, not a verdict. Maxes at ±15%
  change. Needs the option chain.
resource: lib/r-factor/options.ts
tags: [factor, call-oi, options, open-interest, lean]
timestamp: 2026-07-05T00:00:00Z
---

# Call OI build-up (`callOi`)

**Key:** `callOi` · **Default weight:** 0.02 · **Vote:** `sell` (on build-up) /
`neutral` · **Function:** `callOptionOiSignal(currentCallOi, prevCallOi)`

## Definition

```
changePct = pctChange(currentCallOi, prevCallOi)
score     = clamp(|changePct| / 15, 0, 1)        # OPT_OI_CHANGE_CAP_PCT = 15
vote      = changePct > 0 ? 'sell' : 'neutral'    # only build-up carries a lean
```

- Rising call OI → `sell` lean (resistance building); unwinding → `neutral`.
- Maxes at ±15% change. Returns `available: false` without both call-OI inputs.

## ⚠ Interpretation caveat

Rising call OI is **ambiguous** without premium direction: it can be call BUYING
(bullish) OR call WRITING (bearish). This factor uses the standard PCR-style
**writer interpretation** (rising call OI = resistance = bearish lean). Treat it
as a *lean*, not a verdict — hence the low 0.02 weight.

## Availability

Needs the option chain, so it is **unavailable on the futures-only live path**
and drops out of the blend there. See [data-sources/dhan.md](../data-sources/dhan.md).

## Related

- [put-oi](put-oi.md) · [pcr](pcr.md)
