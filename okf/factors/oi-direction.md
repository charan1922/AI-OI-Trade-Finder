---
type: Factor
title: Price + OI direction (four-quadrant)
description: >
  Reads price alongside OI change to turn "fresh positions opened" into a side.
  Long/short buildups are conviction-strong (0.85); covering/unwinding are exits
  (0.4). The core directional vote.
resource: lib/r-factor/oi.ts
tags: [factor, oi-direction, four-quadrant, directional]
timestamp: 2026-07-05T00:00:00Z
---

# Price + OI direction (`oiDirection`)

**Key:** `oiDirection` · **Default weight:** 0.08 · **Vote:** `buy` / `sell` /
`neutral` · **Function:** `oiDirectionSignal(priceChangePct, oiChangePct)`

OI alone is one long per short and says nothing about direction. This factor
reads **price** alongside the **OI change** to assign a side, via the classic
four-quadrant framework. Moves smaller than the 0.1% dead-band count as flat.

## The four quadrants

| Price | OI | Reading | Vote | Strength |
|-------|----|---------|------|:--------:|
| ↑ | ↑ | long buildup — bullish conviction | `buy` | 0.85 |
| ↓ | ↑ | short buildup — bearish conviction | `sell` | 0.85 |
| ↑ | ↓ | short covering — bullish but weak | `buy` | 0.40 |
| ↓ | ↓ | long unwinding — bearish but weak | `sell` | 0.40 |
| flat | any | no clear buildup | `neutral` | 0 |

Buildups (fresh positions) carry conviction (0.85); covering / unwinding are
exits and score weaker (0.40). Always `available: true` (price change is always
supplied); the vote is `neutral` when either side is flat.

## Related

- [oi-level](oi-level.md) (the level) · [futures-oi](futures-oi.md) (the intensity) · [smart-money](smart-money.md)
