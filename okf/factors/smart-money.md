---
type: Factor
title: Smart-money accumulation
description: >
  Composite institutional-conviction proxy — elevated turnover AND a high
  sustained OI level, but only counted as fresh accumulation when OI is actually
  building this session (otherwise it's churn). Directional.
resource: lib/r-factor/flow.ts
tags: [factor, smart-money, accumulation, composite, directional]
timestamp: 2026-07-05T00:00:00Z
---

# Smart-money accumulation (`smartMoney`)

**Key:** `smartMoney` · **Default weight:** 0.14 · **Vote:** `buy` / `sell` /
`neutral` · **Function:** `smartMoneyAccumulationSignal({...})`

The headline "institutional conviction" read. It deliberately overlaps
[turnover](turnover.md) + [oi-level](oi-level.md) — it is the *summary*, so the
engine weights it modestly to avoid double-counting its own components. There is
**no delivery-% input** (that NSE feed is empty in this project), so accumulation
is proxied from OI build + turnover, not delivery.

## Definition

```
turnRatio  = turnover / turnover20dAvg           # null if unavailable
levelRatio = currentOi / oi20dAvg                 # null if unavailable
turnScore  = clamp((turnRatio  − 1) / 2,   0, 1)  # TURNOVER_CAP_EXCESS = 2
levelScore = clamp((levelRatio − 1) / 0.5, 0, 1)  # OI_LEVEL_CAP_EXCESS = 0.5
strength   = mean(available of [turnScore, levelScore])

oiBuilding = direction(oiChangePct, 0.1) == 'up'  # DEADBAND_PCT = 0.1
score      = oiBuilding ? strength : strength × 0.3   # churn discount
vote       = oiBuilding && price↑ → 'buy'
             oiBuilding && price↓ → 'sell'
             else                 → 'neutral'
```

`oiChangePct` is derived by the engine from `futOi` vs `futOiPrev`. Requires at
least one of turnover / OI-level inputs, else `available: false`.

## The key idea — build vs churn

High turnover + high OI level is only *fresh accumulation* when OI is **building**
this session. If OI isn't building, the same activity is churn: the score is
discounted to 30% and the vote stays neutral. Direction is taken from the price
side of the build (price↑ = bullish, price↓ = bearish).

## Related

- [turnover](turnover.md) · [oi-level](oi-level.md) · [oi-direction](oi-direction.md)
