---
type: Method
title: Point-in-time replay benchmark
description: >
  The fixed, zero-lookahead replay of recorded 5-min sessions — the SAME scoring/
  plan code as live, evaluated as-of each tick. Metric = mean ΣR across recorded
  days. The benchmark that promotes a tuning change from provisional to shipped.
resource: scripts/replay-lib.ts
tags: [method, replay, backtest, zero-lookahead, benchmark]
timestamp: 2026-07-05T00:00:00Z
---

# Point-in-time replay benchmark

Replays recorded sessions tick-by-tick with **zero lookahead** — the honest
benchmark for any gate/weight change.

## How it stays honest

- Runs the **same** pure [scoring](../engine/scoring.md) + [spot-plan](../engine/spot-plan.md)
  code as the live engine (that's why they were extracted to `lib/trade-suggest/scoring.ts`).
- Everything is evaluated **as-of the scan tick**: `nowBucketTs` excludes
  still-forming bars, so no future information can leak in.
- Reads only recorded data ([fyers_candles](../data-sources/fyers.md) +
  [oi_intraday](../data-sources/tables.md)); a date is replayable only when both
  exist. Days with no candle coverage are skipped.
- Each pick carries as-of-tick evidence + self-generated reasons (never a stored
  row) — the enriched `ReplayPick`, added to structurally prevent mixing a stored
  suggestion's numbers into a replay narrative.

## Metric

**Mean ΣR** (sum of R-multiples) across recorded days; a 0-pick day scores −0.25
(a config that never trades must not beat one that trades and modestly wins).
`SHIPPED_VARIANT` is the current shipped config; named variants and the
autoresearch loop are compared against it.

## Tools

- `scripts/replay-window.ts` — human-readable named-variant grid for one date.
- `scripts/replay-eval.ts` — one-shot eval bridge (merges a partial Variant over
  `SHIPPED_VARIANT`, prints `{metric, perDay}`) for external optimizers.
- `scripts/autoresearch.ts` — the autonomous loop ([autoresearch.md](autoresearch.md)).

## Promotion rule

Accept a variant only if ΣR **and** target/SL both improve, and re-verify on the
next recorded day. Ship only when it holds across **≥3 recorded days**.

## Related

- [autoresearch.md](autoresearch.md) · [engine/scoring.md](../engine/scoring.md) · [data-sources/fyers.md](../data-sources/fyers.md)
