---
type: Model
title: R-Factor engine
description: >
  The orchestrator that runs all 12 factors, blends their [0,1] strengths
  (renormalized over available factors), scales to a TradeFinder-like 1.0–8.0,
  and derives buy/sell/neutral bias from a weighted majority vote.
resource: lib/r-factor/engine.ts
tags: [model, r-factor, engine, blend, majority, scale]
timestamp: 2026-07-05T00:00:00Z
---

# R-Factor engine (`computeRFactor`)

A read on institutional-interest **strength** (1.0–8.0, à la TradeFinder) plus a
directional **bias** (buy / sell / neutral), computed from market data the caller
supplies. The library imports **nothing** from the app (no Dhan/Prisma/NSE/Next) —
plain numbers in, plain data out — which is what makes it unit-testable and
[replayable point-in-time](../method/point-in-time-replay.md).

`computeRFactor(input: RFactorInput, config?: { weights? }): RFactorResult`

## Pipeline

1. **Run every factor.** All 12 [factors](../factors/index.md) run; each reports
   `available: false` when its inputs are missing.
2. **Blend strength** (`rFactor`): weighted mean of factor strengths,
   **renormalized over only the AVAILABLE factors** — so missing data (e.g. no
   option chain) neither inflates nor deflates the score.
   ```
   rawScore = Σ(weight·score) / Σ(weight)   # available factors only
   rFactor  = round(1 + (8 − 1)·rawScore, 2) # RF_MIN=1, RF_MAX=8
   ```
3. **Direction** (`bias` + `confidence`): the [majority vote](#direction-the-majority-vote).
4. **Gate** (`marketOpen`, `afterEntryWindow`): [timing](#the-timing-gate) —
   informational, not a hard block.

## The 1–8 scale

Raw `[0,1]` blend is mapped `1 + 7·rawScore`. TradeFinder's displayed R-Factor
runs past 5 (1–8); the span was widened from 1–5 to 1–8 on 2026-07-03 at the
user's request — **only the presentation changed, the raw scoring is unchanged.**

## Direction — the majority vote

`majoritySignal(factors, weights)` tallies buy vs sell across the directional
voters ([smart-money](../factors/smart-money.md), [oi-direction](../factors/oi-direction.md),
[breakout](../factors/breakout.md), [pcr](../factors/pcr.md),
[call-oi](../factors/call-oi.md), [put-oi](../factors/put-oi.md)):

```
each vote counts by (weight · strength)
bias       = side with more weight (else neutral)
confidence = |buyWeight − sellWeight| / (buyWeight + sellWeight)   # margin of victory, [0,1]
```

Neutral / unavailable factors are ignored. `confidence` is the margin, not a
probability.

## Blend weights

`DEFAULT_WEIGHTS` (`engine.ts`) — a **reasoned starting point, NOT fitted** to TF
ground truth; override any subset via `config.weights`. Weights need not sum to
1 (the engine renormalizes). See the per-factor table in
[factors/index.md](../factors/index.md) and the
[calibration status](../ground-truth/calibration.md).

```ts
computeRFactor(input, { weights: { oiLevel: 0.25, bidAskSpread: 0.2 } });
```

## Output (`RFactorResult`)

`{ symbol, rFactor (1–8), rawScore (0–1), bias, confidence (0–1),
afterEntryWindow, marketOpen, factors[], notes[] }`. `notes` carries caveats
(missing inputs excluded from the blend, before-9:45 auction-noise warning,
market-closed staleness).

## The timing gate

`isAfterEntryTime(now, entryTimeIST='09:45')` ([timing](../engine/window.md)) —
IST via `Intl` (Asia/Kolkata). `marketOpen` = weekday & 09:15–15:30;
`afterEntryWindow` = open & past the entry time. **Not** a hard block — the
caller decides whether to act before 9:45.

## Related

- [factors/index.md](../factors/index.md) · [models/normalization.md](normalization.md) · [engine/index.md](../engine/index.md) · [ground-truth/calibration.md](../ground-truth/calibration.md)
