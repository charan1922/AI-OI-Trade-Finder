---
type: Model
title: Spot plan — SL, target, risk floor
description: >
  The spot-terms trade plan: entry at LTP, SL at the last completed 5-min
  candle's low (CE) / high (PE) with opening-range fallback, widened to a risk
  floor when inside noise, and a 1:2 target. Point-in-time honest.
resource: lib/trade-suggest/scoring.ts
tags: [spot-plan, stop-loss, target, risk-floor, exits]
timestamp: 2026-07-05T00:00:00Z
---

# Spot plan (`buildSpotPlan`)

The signal-based exit layer, expressed in **spot terms** (premium numbers are
never fabricated — see [option-plan.md](option-plan.md) for the premium backstop).
Pure function; `nowBucketTs` excludes still-forming bars, keeping it strictly
point-in-time for [replay](../method/point-in-time-replay.md).

## SL derivation

Entry = current LTP. The structural SL:

- **CE (bullish):** last completed 5-min candle's **low** (if below entry),
  else the **opening-range low** (`slBasis: 'last-candle' | 'opening-range'`).
- **PE (bearish):** last completed candle's **high**, else opening-range high.

## The risk floor (why it exists)

A last-5-min-candle SL can be degenerately tight when that bar is small — seen
live: MARICO had risk of 0.05 pts on an ₹842 stock, a guaranteed stop-out inside
normal noise. So the risk is floored:

```
pctFloor = entry · MIN_RISK_PCT / 100        # MIN_RISK_PCT = 0.35%
atrFloor = atrMult · atr                      # SL_ATR_MULT = 0 (disabled) → 0
minRisk  = max(pctFloor, atrFloor)
if |entry − sl| < minRisk:  widen sl to the floor,  slBasis = 'floor'
```

`SL_ATR_MULT = 0` today (the % floor only). The ATR floor is an A/B variant
behind `atrMult`; change it **only with fresh [replay](../method/point-in-time-replay.md)
evidence**.

## Target

`TARGET_RR = 2` → 1:2 reward:risk:

```
CE:  target = entry + 2·(entry − sl)
PE:  target = entry − 2·(sl − entry)
```

`slBasis` is one of `last-candle | opening-range | floor | none` (none when no
SL could be derived — then target is null too).

## Two exit layers

1. **Spot SL** (this doc) — the SIGNAL exit.
2. **Premium backstop** (−40% of premium, [option-plan.md](option-plan.md)) —
   the MAX-LOSS exit.

Whichever hits first wins.

## Related

- [option-plan.md](option-plan.md) · [scoring.md](scoring.md) · [indicators/atr.md](../indicators/atr.md)
