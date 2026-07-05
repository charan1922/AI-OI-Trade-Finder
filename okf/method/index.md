---
type: Index
title: Method
description: >
  How the strategy is validated and tuned — point-in-time replay (the fixed,
  zero-lookahead benchmark), the autoresearch loop (karpathy-style mutate →
  replay → hill-climb), and the ML roadmap.
resource: scripts/replay-lib.ts
tags: [method, replay, autoresearch, ml, index]
timestamp: 2026-07-05T00:00:00Z
---

# Method

The discipline that keeps changes honest — nothing ships to the
[gates/weights](../engine/gates.md) without evidence.

- [point-in-time-replay.md](point-in-time-replay.md) — the fixed benchmark
  (zero lookahead, mean ΣR metric)
- [autoresearch.md](autoresearch.md) — the autonomous mutate → replay →
  accept/reject tuning loop
- [ml-roadmap.md](ml-roadmap.md) — the phased plan from hand-tuned gates to a
  fitted model

## The promotion rule

A tuning change is **provisional** until it improves the [replay benchmark](point-in-time-replay.md)
across **≥3 recorded days** — one day overfits. See [autoresearch.md](autoresearch.md)
guard rails and the [calibration status](../ground-truth/calibration.md).
