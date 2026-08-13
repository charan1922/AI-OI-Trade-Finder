---
type: Model
title: Composite score + display evidence
description: >
  The [0,1] composite score that ranks gated survivors (8 weighted components,
  sum 1.0), plus the display-only evidence attached to each pick (Supertrend,
  VWAP, ATR, turnover ratio, combined OI level).
resource: lib/trade-suggest/scoring.ts
tags: [scoring, composite, weights, evidence, trade-suggest]
timestamp: 2026-07-05T00:00:00Z
---

# Composite score (`computeCompositeScore`)

Ranks the gated survivors. Pure function shared by the live engine and the
[replay harness](../method/point-in-time-replay.md). All components are
normalized to `[0,1]`; weights (`config.WEIGHTS`) sum to 1.0.

```
score =
  0.22 · rFactor       ((rFactor − 1) / 7)         # 1–8 → [0,1]
+ 0.08 · confidence
+ 0.18 · oiUrgency     (oiUrgency / 10)
+ 0.12 · oiLevel       ((oiLevel − 1) / 0.5)        # 1.0–1.5× → [0,1]
+ 0.20 · orBreakout    (1 if opening-range breakout else 0)
+ 0.07 · imbalanceAlign(bullish ? bidShare : 1 − bidShare)
+ 0.08 · sectorBreadth ((sectorPeers − 1) / 2)      # same-sector same-direction survivors
+ 0.05 · setupStrong   (1 if setup 'strong' else 0.5)

if extended:  score ×= 0.6   # evidence score only; never re-ranks TF candidates
```

## Why R-Factor and OR-breakout co-lead

`rFactor` (0.22) and `orBreakout` (0.20) are the top weights. Price action /
opening-range breakout was raised to co-lead on 2026-07-03 (user directive:
"price action and breakout are crucial") after the day's one TF winner
(SUNPHARMA) was an OR breakout while both non-breakout picks stopped out.

## Display evidence (NOT gates, NOT weights)

Each pick carries a `PickFactors` block — **shown to the user, deliberately not
scored** (replay 2026-07-03: tilt/VWAP gates would have blocked the day's only
winner; Supertrend needs more days before it earns weight):

| Field | Meaning |
|-------|---------|
| `supertrend` + `supertrendAligned` | [Supertrend(10,3)](../indicators/supertrend.md); ⚠ flag misalignment (misaligned picks went 0/3 on replay) |
| `vwap` + `vwapAligned` | [session VWAP](../indicators/vwap.md) side |
| `atr` + `atrPct` | [ATR(14)](../indicators/atr.md) — the noise unit |
| `eqTurnoverRatio` | live equity turnover ÷ time-adjusted 20-day pace (⚠ mornings over-read ~2×) |
| `combinedOiLevel` | DERIVED fut+opt OI vs 20-day avg (yesterday's bhavcopy combined × (1 + NSE combined %) ÷ 20-day avg) |
| `nseOiPct` | NSE's combined OI %-change, verbatim |
| `onOiSpurtList` | on NSE's OI build-up list this scan |

`tilt` (breadth, since-open) and `sectorFlow` (per-sector avg move + OI-list
counts) give session context — one line each, context only.

## Related

- [gates.md](gates.md) · [spot-plan.md](spot-plan.md) · [indicators/index.md](../indicators/index.md)
