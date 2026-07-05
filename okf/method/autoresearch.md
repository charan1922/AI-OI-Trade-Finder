---
type: Method
title: Autoresearch tuning loop
description: >
  A faithful port of karpathy/autoresearch — mutate ONE knob (a weight shift,
  gate threshold, ATR floor, extended handling), replay every recorded session,
  keep only if mean ΣR strictly improves. Journaled, seeded, never auto-ships.
resource: scripts/autoresearch.ts
tags: [method, autoresearch, karpathy, tuning, hill-climb]
timestamp: 2026-07-05T00:00:00Z
---

# Autoresearch tuning loop

Maps [github.com/karpathy/autoresearch](https://github.com/karpathy/autoresearch)
to this domain:

| autoresearch | here |
|--------------|------|
| `train.py` (mutable artifact) | engine config — weights + gates |
| fixed training run | [point-in-time replay](point-in-time-replay.md) of recorded sessions |
| `val_bpb` (lower ✓) | mean ΣR across recorded days (higher ✓) |
| keep-or-discard experiment | strict hill-climb accept (`>`) |
| experiment journal | `tracking/autoresearch-log.jsonl` |

## One knob per experiment

Each experiment mutates exactly ONE knob, replays every recorded session with
zero lookahead, and keeps the mutation only if the metric **strictly** improves.
Mutation operators: `weight-shift` (composite weights), **`rf-weight-shift`** (the
12 [R-Factor weights](../models/r-factor.md) — the user's calibration target),
`gate-rfactor`, `gate-oilevel`, `gate-nseoi`, `gate-confidence`, `atr-floor`,
`extended`. Seeded RNG (mulberry32) → reproducible streams.

## Guard rails

- A 0-pick day scores −0.25.
- The loop **never** writes the accepted config into `config.ts` — it prints the
  winner + baseline; a human ships, and only with **≥3 recorded days** of
  evidence (n=1 overfits; at <3 days every result is flagged EXPLORATORY).
- Every experiment — accepted or not — is journaled with its full config.

## Companion

`scripts/optimize_rfactor.py` runs Optuna (TPE Bayesian) over the same replay via
`scripts/replay-eval.ts`, journaling to `tracking/optuna-rfactor.jsonl` — a second
search method that converged with the TS loop.

## Related

- [point-in-time-replay.md](point-in-time-replay.md) · [ground-truth/calibration.md](../ground-truth/calibration.md) · [ml-roadmap.md](ml-roadmap.md)
