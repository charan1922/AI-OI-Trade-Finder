---
type: Playbook
title: Near-ATM CE (bullish) setup
description: >
  What a buy-CE pick means and how its plan is built — bullish R-Factor bias +
  OI evidence + price agreeing/breaking up, near-ATM call, SL at last-candle low
  (OR-low fallback), 1:2 target, −40% premium backstop.
resource: lib/trade-suggest/engine.ts
tags: [playbook, ce, bullish, setup]
timestamp: 2026-07-05T00:00:00Z
---

# Near-ATM CE (bullish)

Bought when the engine's bias is **buy** and the [gates](../engine/gates.md) pass
on the bullish side.

## What must be true

- [R-Factor](../models/r-factor.md) ≥ 3.6 with **buy** bias, confidence ≥ 0.2.
- OI evidence: futures [OI level](../factors/oi-level.md) ≥ 1.1× **OR** NSE
  combined OI ≥ 5%.
- [Turnover](../factors/turnover.md) ≥ 1.2×, [spread](../factors/bid-ask-spread.md) ≤ 0.3%.
- **Price agrees:** up from open OR breaking the opening-range high
  ([breakout](../factors/breakout.md)).
- Not [extended](../engine/gates.md#extended-movers-0-for-5-evidence) (≥3% from open).

## The contract + plan

- Near-ATM **CE**, nearest monthly expiry ≥ 3 DTE, single lot within ₹60k
  ([option-plan.md](../engine/option-plan.md)).
- **SL** = last completed 5-min candle **low** (fallback opening-range low),
  widened to the [risk floor](../engine/spot-plan.md) if inside noise.
- **Target** = entry + 2×risk (1:2).
- **Premium backstop** = −40% of premium paid (max-loss exit).

## Confirmation (display only)

Favorable: [Supertrend](../indicators/supertrend.md) up, entry above
[VWAP](../indicators/vwap.md). Misalignment is a ⚠ flag, not a block.

## Related

- [near-atm-pe.md](near-atm-pe.md) · [engine/scoring.md](../engine/scoring.md)
