---
type: Index
title: Trade-Suggest engine
description: >
  The /trade-suggest option engine — scans the NSE movers feeds in the
  09:40–11:00 window, hard-gates on the TF fingerprint, scores survivors,
  resolves near-ATM contracts, and builds two-layer exit plans. Analysis only.
resource: lib/trade-suggest
tags: [engine, trade-suggest, options, index]
timestamp: 2026-07-05T00:00:00Z
---

# Trade-Suggest engine

Produces up to 3 ranked near-ATM option picks (CE for bullish, PE for bearish)
during the morning window. It **never places orders** — it is signal analysis.
Config lives in one file (`lib/trade-suggest/config.ts`); the scoring + plan math
is pure and shared with the [replay harness](../method/point-in-time-replay.md).

## Flow

1. **Window + market gate** — only 09:40–11:00 IST on a trading day ([window.md](window.md)).
2. **Candidates** — union of the NSE movers feeds (`CANDIDATE_SOURCES`): OI spurts,
   F&O gainers/losers, most-active by value and by volume. All F&O-gated. See
   [data-sources/nse-feeds.md](../data-sources/nse-feeds.md).
3. **Hard gates** — a candidate must clear ALL ([gates.md](gates.md)).
4. **Composite score** — rank survivors ([scoring.md](scoring.md)); top `MAX_PICKS = 3`.
5. **Option plan** — resolve the nearest ATM strike on the nearest monthly expiry
   (`MIN_DTE = 3`), live-quote it, skip if a lot exceeds the ₹60k budget ([option-plan.md](option-plan.md)).
6. **Spot plan** — two-layer exits: a signal SL (spot) + a premium max-loss
   backstop ([spot-plan.md](spot-plan.md)).
7. **Persist** — first sighting fixes the scored snapshot; re-sightings bump
   `timesSeen`. Scored same-day by the [scorecard](../playbooks/scorecard-review.md).

## Docs

- [gates.md](gates.md) — the hard gates and their thresholds
- [scoring.md](scoring.md) — the composite score formula + display evidence
- [spot-plan.md](spot-plan.md) — SL/target derivation and the risk floor
- [option-plan.md](option-plan.md) — strike/expiry resolution, budget, premium exits
- [window.md](window.md) — the 09:40–11:00 entry window and why

## Operating procedure

See [playbooks/morning-scan.md](../playbooks/morning-scan.md) for how an agent
runs and presents this.
