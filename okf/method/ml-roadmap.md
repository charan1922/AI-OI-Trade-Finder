---
type: Method
title: ML roadmap
description: >
  The phased plan from hand-tuned gates to a fitted model — Phase 1 logistic
  score calibration on persisted features, Phase 2 TF replication on tf_snapshots
  ground truth, Phase 3 real-volume timing/regime models. Coefficients ship, no ML runtime.
resource: tracking/ml-roadmap.md
tags: [method, ml, roadmap, calibration]
timestamp: 2026-07-05T00:00:00Z
---

# ML roadmap

The plan to move the [gates/weights](../engine/gates.md) from hand-tuned to
fitted. Full doc: `tracking/ml-roadmap.md`.

## Phase 1 — score calibration (logistic regression)

- Target: P(≥1% favorable spot move before close) from features already persisted
  in `trade_suggestions` — rFactor, confidence, oiLevel, oiUrgency, nseOiPct,
  spreadPct, imbalance, orBreakout, extended, sector breadth, time-of-day.
- Train **offline in Python**, walk-forward only. Ship as plain coefficients into
  `lib/trade-suggest/config.ts` — **no ML runtime in prod** (auditable, instantly
  reversible).
- Drift monitor: the `{action:'stats'}` endpoint; retrain when live hit-rate
  decays. Start at ~100+ reviewed rows.

## Phase 2 — TF replication (supervised regression)

- Each captured TF day ([tf_snapshots](../ground-truth/tf-snapshots.md)) is a
  training row for "what TF actually ranks". The current spread-linear model came
  from 2 days; ~20 days justifies a regularized gradient-boosted fit that learns
  what spread alone misses (e.g. the SUNPHARMA options-led build).

## Phase 3 — with real volume (months of data)

- Entry-timing model: P(move extends ≥1% before the last-candle SL) from the
  5-min sequence state at scan time.
- Day-regime classifier: trend vs chop from the first 45 min; suppress
  suggestions on chop days.

## Principle

Everything ships as coefficients into config, validated on the
[replay benchmark](point-in-time-replay.md). No black-box model runs in prod.

## Related

- [ground-truth/tf-snapshots.md](../ground-truth/tf-snapshots.md) · [autoresearch.md](autoresearch.md) · [point-in-time-replay.md](point-in-time-replay.md)
