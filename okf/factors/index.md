---
type: Index
title: R-Factor Factors
description: >
  The 12 factors that compose the R-Factor. Each is a pure function returning a
  [0,1] strength (how notable it is) plus a directional vote (buy/sell/neutral)
  and an availability flag. The engine renormalizes over available factors.
resource: lib/r-factor
tags: [factors, r-factor, index]
timestamp: 2026-07-05T00:00:00Z
---

# R-Factor factors

Each factor is a self-contained pure function in `lib/r-factor/`. It takes plain
numbers and returns a `FactorScore`: a **strength** in `[0,1]` (magnitude only —
NOT direction), a **vote** (`buy` | `sell` | `neutral`), an **`available`** flag
(false when inputs are missing, so it drops out of the blend), and a plain-English
`detail`. See [models/r-factor.md](../models/r-factor.md) for how they combine and
[models/normalization.md](../models/normalization.md) for the shared math.

## The 12 factors, with default blend weight

Weights are the reasoned starting point in `DEFAULT_WEIGHTS` (`engine.ts`) — they
need not sum to 1; the engine renormalizes over available factors. **Provisional**
until calibrated (see [ground-truth/calibration.md](../ground-truth/calibration.md)).

| Factor | Weight | Role | Direction? |
|--------|:------:|------|------------|
| [range-spread](range-spread.md) | 0.18 | TF's dominant "spread" — (H−L)/close vs 20d | intensity (neutral) |
| [oi-level](oi-level.md) | 0.16 | Sustained accumulation — OI ÷ 20d avg | level (neutral) |
| [smart-money](smart-money.md) | 0.14 | Institutional-conviction composite | yes |
| [bid-ask-spread](bid-ask-spread.md) | 0.10 | Liquidity / execution quality | quality (neutral) |
| [futures-oi](futures-oi.md) | 0.10 | Fresh positioning intensity (daily OI change) | intensity (neutral) |
| [turnover](turnover.md) | 0.08 | Real-money participation vs 20d | quality (neutral) |
| [oi-direction](oi-direction.md) | 0.08 | Price+OI four-quadrant read | yes |
| [breakout](breakout.md) | 0.06 | Break of reference range | yes |
| [pcr](pcr.md) | 0.04 | Put-Call OI ratio lean | yes (lean) |
| [call-oi](call-oi.md) | 0.02 | Call OI build-up (resistance lean) | yes (lean) |
| [put-oi](put-oi.md) | 0.02 | Put OI build-up (support lean) | yes (lean) |
| [volume](volume.md) | 0.02 | Supporting confirmation vs 20d | quality (neutral) |

## Two kinds of factor

- **Directional voters** (smart-money, oi-direction, breakout, pcr, call-oi,
  put-oi): contribute to the [majority vote](../models/r-factor.md#direction-the-majority-vote)
  that sets `bias` and `confidence`.
- **Intensity / quality** (range-spread, oi-level, futures-oi, turnover,
  bid-ask-spread, volume): vote `neutral`; they raise the *strength* score but
  say nothing about which side.

## Why no ADX

ADX is a lagging price-derived trend-strength indicator on a different axis from
this cross-sectional institutional-flow signal; intraday ADX(14) is unreliable
near 9:45. It belongs in the entry-confirmation layer ([indicators](../indicators/index.md)),
not in the R-Factor score. (`lib/r-factor/README.md`.)
