---
type: Factor
title: Bid-ask spread (liquidity)
description: >
  Tightness of the live bid-ask spread as a % of mid — a liquidity/execution-cost
  quality factor. 0% scores 1 (perfectly tight); ≥0.3% of mid scores 0
  (illiquid). Non-directional. Live-only (needs a two-sided quote).
resource: lib/r-factor/microstructure.ts
tags: [factor, bid-ask-spread, liquidity, microstructure, quality, live-only]
timestamp: 2026-07-05T00:00:00Z
---

# Bid-ask spread — liquidity (`bidAskSpread`)

**Key:** `bidAskSpread` · **Default weight:** 0.10 · **Vote:** always `neutral`
(quality only) · **Function:** `bidAskSpreadSignal(bid, ask)`

A tight spread means the name is liquid and cheap to execute (real traders
active); a wide spread is illiquid / low-conviction. This is the **actual bid-ask
spread** — distinct from the [range-expansion "spread"](range-spread.md) that
dominates TF's R-Factor.

## Definition

```
mid       = (bid + ask) / 2
spreadPct = ((ask − bid) / mid) × 100
score     = clamp(1 − spreadPct / 0.3, 0, 1)   # SPREAD_CAP_PCT = 0.3
```

- 0% of mid → score 1.0 (perfectly tight).
- ≥ 0.3% of mid → score 0 (illiquid).
- Liquidity label: `>0.66` tight/liquid · `>0.33` moderate · else wide/illiquid.
- Returns `available: false` without a valid two-sided quote (`ask < bid` or
  either non-positive).

## Availability note

This factor needs a live order book, so it is **unavailable on the bhavcopy /
EOD path** and on the point-in-time replay (5-min candles carry no book). The
engine renormalizes it out when absent. The trade-suggest engine separately
hard-gates on `MAX_SPREAD_PCT = 0.3` — see [engine/gates.md](../engine/gates.md).

## Related

- [range-spread](range-spread.md) (the OTHER "spread") · [engine/gates.md](../engine/gates.md)
