---
type: Model
title: Normalization primitives
description: >
  The pure math building blocks every factor uses to turn raw market numbers
  into a comparable [0,1] strength — clamp, scoreFromRatio, scoreFromMagnitude,
  direction, pctChange, safeDiv.
resource: lib/r-factor/math.ts
tags: [model, math, normalization, primitives]
timestamp: 2026-07-05T00:00:00Z
---

# Normalization primitives (`math.ts`)

No imports, no state. These turn raw numbers into the comparable `[0,1]` strength
scores the factors emit.

| Function | Definition | Used for |
|----------|------------|----------|
| `clamp(v, lo, hi)` | constrain to `[lo,hi]` | every factor's final bound |
| `round(v, dp=2)` | round to `dp` places | detail strings, `rFactor` |
| `isPos(v)` | finite & `> 0` | input validation → `available` |
| `safeDiv(a, b, fb=0)` | `a/b`, fallback if `b=0` | guarded ratios |
| `pctChange(curr, prev)` | `((curr−prev)/prev)·100`, 0 if `prev≤0` | OI / price % change |
| `scoreFromRatio(value, baseline, capExcess)` | `clamp((value/baseline − 1)/capExcess, 0, 1)` | ratio-vs-baseline factors |
| `scoreFromMagnitude(value, cap)` | `clamp(\|value\|/cap, 0, 1)` | magnitude factors (e.g. OI change %) |
| `direction(changePct, deadbandPct)` | `'up' \| 'down' \| 'flat'` (flat within dead-band) | directional votes |

## The two scoring shapes

- **`scoreFromRatio`** — "× of baseline". At/below baseline → 0; at
  `(1 + capExcess)×` → 1. E.g. `capExcess = 2` ⇒ 3× the average = max.
  Used by [oi-level](../factors/oi-level.md) (0.5), [turnover](../factors/turnover.md)
  (2), [volume](../factors/volume.md) (2).
- **`scoreFromMagnitude`** — soft cap on an absolute magnitude. `|value|` reaches
  `cap` ⇒ 1. Used by [futures-oi](../factors/futures-oi.md) (cap 10%).

## Related

- [models/r-factor.md](r-factor.md) · [factors/index.md](../factors/index.md)
