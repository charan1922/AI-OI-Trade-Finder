# R-Factor library (`lib/r-factor`)

A **self-contained, dependency-free** library that scores a stock's **R-Factor** — a
read on institutional-interest **strength** (1.0–8.0, à la TradeFinder) plus a
directional **bias** (buy / sell / neutral) — from market data the caller supplies.

It imports **nothing** from the rest of the app (no Dhan, Prisma, NSE, or Next).
You feed it plain numbers; it returns plain data. That keeps it reusable and
trivially unit-testable. Wiring real data in (from Dhan/bhavcopy) is intentionally
left to the caller.

## Factor map (every "thing needed" → a function)

Based on `tracking/things-needed-as-part-of-skills.md` ("TradeFinder Considerations
for Calculating R Factor"):

| # | TF "thing"                  | Function                          | File                | Direction? |
|---|-----------------------------|-----------------------------------|---------------------|------------|
| 1 | Smart money accumulation    | `smartMoneyAccumulationSignal`    | `flow.ts`           | yes        |
| 2 | Call Option OI              | `callOptionOiSignal`              | `options.ts`        | yes (lean) |
| 3 | Put Option OI               | `putOptionOiSignal`               | `options.ts`        | yes (lean) |
| 4 | Futures OI                  | `futuresOiSignal`                 | `oi.ts`             | no (intensity) |
| 5 | Turnover                    | `turnoverSignal`                  | `flow.ts`           | no (quality) |
| 6 | Bid-Ask Spread              | `bidAskSpreadSignal`              | `microstructure.ts` | no (quality) |
| 6b| Range expansion (TF "spread")| `rangeSpreadSignal`               | `range-spread.ts`   | no (intensity) |
| 7 | Volume (sometimes)          | `volumeSignal`                    | `flow.ts`           | no (quality) |
| 8 | Majority indicators         | `majoritySignal`                  | `majority.ts`       | aggregates votes |
| 9 | OI direction                | `oiDirectionSignal`               | `oi.ts`             | yes        |
| 10| Time 9:45 AM after          | `isAfterEntryTime`                | `timing.ts`         | gate       |
| 11| Compare last 20 days OI     | `oiVsTwentyDaySignal`             | `oi.ts`             | no (level) |
| 12| Breakout                    | `breakoutSignal`                  | `breakout.ts`       | yes        |
| — | Put-Call ratio (derived)    | `pcrSignal`                       | `options.ts`        | yes (lean) |
| — | Orchestrator                | `computeRFactor`                  | `engine.ts`         | —          |

`math.ts` holds the shared normalization primitives; `types.ts` the shared types.

## Usage

```ts
import { computeRFactor } from '@/lib/r-factor';

const r = computeRFactor({
  symbol: 'RELIANCE',
  ltp: 2940, priceChangePct: 1.2,
  futOi: 12_000_000, futOiPrev: 10_500_000, futOi20dAvg: 9_500_000,
  turnover: 18_000_000_000, turnover20dAvg: 11_000_000_000,
  volume: 21_000_000, volume20dAvg: 14_000_000,
  callOi: 5_200_000, callOiPrev: 4_900_000, putOi: 7_100_000, putOiPrev: 6_200_000,
  bid: 2939.8, ask: 2940.2,
  breakoutHigh: 2925,
  now: new Date(),
});
// r.rFactor   → e.g. 3.8   (strength, 1–5)
// r.bias      → 'buy' | 'sell' | 'neutral'
// r.confidence→ 0..1       (agreement among voting factors)
// r.factors   → per-factor breakdown ({ key, label, score, vote, available, detail })
// r.notes     → caveats (missing inputs, before 9:45, market closed)
```

Each factor is also usable on its own, e.g. `oiDirectionSignal(priceChangePct, oiChangePct)`.

## How the score is built

1. Each factor returns a **strength** in `[0,1]` (how notable it is) and a **vote**.
2. **Strength blend** (`rFactor`): weighted mean of factor strengths, **renormalized
   over only the *available* factors** — so missing data (e.g. no option chain)
   neither inflates nor deflates the result. Scaled `rawScore∈[0,1] → 1 + 4·rawScore`.
3. **Direction** (`bias`): `majoritySignal` tallies buy vs sell weight (each vote
   counts by its `weight × strength`); `confidence` is the margin of victory.
4. **Gate** (`afterEntryWindow`, `marketOpen`): `isAfterEntryTime` (IST). Not a
   hard block — the caller decides whether to act before 9:45.

## ⚠️ Calibration caveat (read this)

The factor **math** is principled (z/ratio normalization, the OI four-quadrant,
PCR). The **blend weights** in `DEFAULT_WEIGHTS` are a **reasoned starting point,
NOT fitted to TradeFinder ground truth.** They lean on what this project found most
predictive (sustained OI level, smart-money accumulation, tight spread), but the
exact numbers are provisional.

### What calibration against TF ground truth showed (2026-06-23)

Fitting against `../derive-r/ground_truth` (where `param_3` = TF's R-Factor):

- **Only 2 of 3 capture dates were usable** (bhavcopy covers 2026-03-19/20, not 03-26).
  Two days is too few to fit robust weights.
- **The list-derived factors alone do NOT match TF** (top-10 overlap 1–2/10);
  turnover/volume even correlated *negatively* with TF's score.
- **TF's dominant signal is range-expansion spread** (`rangeSpreadSignal`,
  `(H−L)/Close` vs 20-day avg) — NOT the bid-ask spread the requirements named.
  On 2026-03-20 it scored **7/10 top-10** (Spearman 0.70); on 2026-03-19 it scored
  **1/10** (Spearman −0.20). Highly **date-dependent** — which is why the parent
  project blends an ensemble rather than trusting spread alone, and why
  `rangeSpread`'s weight here is provisional pending more capture days.

Calibrate against more captured TF rankings before trusting the weights. Override per call:

```ts
computeRFactor(input, { weights: { oiLevel: 0.25, bidAskSpread: 0.2 } });
```

Weights need not sum to 1 — the engine renormalizes.

## Why no ADX

ADX is a lagging, price-derived **trend-strength** indicator. R-Factor is a
cross-sectional **institutional-flow** signal — a different axis. Folding ADX in
would dilute the flow signal, and intraday ADX(14) is unreliable near 9:45 (too few
bars to settle). ADX belongs in a separate *entry-confirmation* layer, not in the
R-Factor score, so it is intentionally excluded here.
