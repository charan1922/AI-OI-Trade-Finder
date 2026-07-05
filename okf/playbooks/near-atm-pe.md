---
type: Playbook
title: Near-ATM PE (bearish) setup
description: >
  What a buy-PE pick means and how its plan is built — bearish R-Factor bias +
  OI evidence + price agreeing/breaking down, near-ATM put, SL at last-candle
  high (OR-high fallback), 1:2 target, −40% premium backstop. Favorable = DOWN.
resource: lib/trade-suggest/engine.ts
tags: [playbook, pe, bearish, setup]
timestamp: 2026-07-05T00:00:00Z
---

# Near-ATM PE (bearish)

Bought when the engine's bias is **sell** and the [gates](../engine/gates.md) pass
on the bearish side. For a PE, the **favorable direction is DOWN** (read
`maxDownPct` as the win in the [scorecard](scorecard-review.md)).

## What must be true

- [R-Factor](../models/r-factor.md) ≥ 3.6 with **sell** bias, confidence ≥ 0.2.
- OI evidence: futures [OI level](../factors/oi-level.md) ≥ 1.1× **OR** NSE
  combined OI ≥ 5% (a genuine short buildup, not long unwinding — see
  [oi-direction](../factors/oi-direction.md)).
- [Turnover](../factors/turnover.md) ≥ 1.2×, [spread](../factors/bid-ask-spread.md) ≤ 0.3%.
- **Price agrees:** down from open OR breaking the opening-range low.
- Not [extended](../engine/gates.md#extended-movers-0-for-5-evidence) (≤ −3% from open).

## The contract + plan

- Near-ATM **PE**, nearest monthly expiry ≥ 3 DTE, single lot within ₹60k.
- **SL** = last completed 5-min candle **high** (fallback opening-range high),
  widened to the [risk floor](../engine/spot-plan.md) if inside noise.
- **Target** = entry − 2×risk (1:2, downward).
- **Premium backstop** = −40% of premium paid.

## Confirmation (display only)

Favorable: [Supertrend](../indicators/supertrend.md) down, entry below
[VWAP](../indicators/vwap.md). Misalignment is a ⚠ flag, not a block.

## Related

- [near-atm-ce.md](near-atm-ce.md) · [engine/scoring.md](../engine/scoring.md)
