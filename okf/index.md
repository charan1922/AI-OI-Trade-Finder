---
type: OKF Bundle
title: Project-R Live-Trading Knowledge Base
description: >
  Open Knowledge Format bundle for the Project-R simulator's live-trading AI
  agents (Trade Assistant, /trade-suggest, R-Factor calibration loop). The
  semantic/context layer that grounds agent reasoning — factor definitions,
  the R-Factor model, the option-suggestion engine, indicators, playbooks,
  data sources, TradeFinder ground truth, universe, and validation method.
resource: okf/
tags: [okf, index, live-trading, r-factor, trade-suggest, agents]
timestamp: 2026-07-05T00:00:00Z
---

# Project-R Live-Trading Knowledge Base (OKF)

This is an [Open Knowledge Format](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing)
bundle: a directory of markdown files with YAML frontmatter that the project's
AI agents read (and may extend) to reason about live trading. Every fact here is
sourced from the actual codebase — the `resource:` field on each doc points at
the file it documents. If a number in a doc disagrees with its `resource`, the
**code wins** and the doc is stale.

## What this bundle is (and is NOT)

- ✅ **Knowledge / context layer.** Factor semantics, gate rationale, model
  formulas, strategy playbooks, ground-truth notes, validation method.
- ❌ **NOT a market-data layer.** Live prices, OI, candles, and quotes live in
  SQLite/Prisma + the Dhan/Fyers/NSE feeds — never in markdown. See
  [data-sources](data-sources/index.md) for where the real numbers come from.

> One sentence: this bundle is how an agent knows *what a good near-ATM PE setup
> looks like and why*; the database is how it knows *SUNPHARMA is at ₹1,918 right now*.

## How an agent should use it

1. **Start here**, then open the folder `index.md` for the domain you need.
2. **Retrieve narrowly.** To score a symbol, read [models/r-factor.md](models/r-factor.md)
   + the relevant [factors](factors/index.md); to place a plan, read
   [engine/scoring.md](engine/scoring.md) + [engine/spot-plan.md](engine/spot-plan.md).
3. **Trust `resource:` over memory.** Before quoting a threshold to a user,
   confirm it against the file named in the doc's frontmatter.
4. **Extend it.** Agents may add docs (e.g. a new captured TF day under
   [ground-truth](ground-truth/index.md)) following the frontmatter convention below.

## Map

| Domain | What's inside |
|--------|---------------|
| [factors/](factors/index.md) | The 12 R-Factor factors — each a `[0,1]` strength + directional vote, with exact normalization math |
| [models/](models/index.md) | The R-Factor engine (blend → 1–8 scale, majority vote) and the shared normalization primitives |
| [engine/](engine/index.md) | The `/trade-suggest` option engine — hard gates, composite score, spot plan, option plan, entry window |
| [indicators/](indicators/index.md) | Wilder ATR(14), Supertrend(10,3), session VWAP — display-only entry-confirmation context |
| [playbooks/](playbooks/index.md) | Operating procedures — the morning scan, near-ATM CE/PE setups, the same-day scorecard |
| [data-sources/](data-sources/index.md) | Where live numbers come from: Dhan, Fyers, NSE feeds, bhavcopy, and the SQLite tables |
| [ground-truth/](ground-truth/index.md) | TradeFinder fingerprint, `tf_snapshots` captures, and the calibration status |
| [universe/](universe/index.md) | The F&O tradeable universe and the lot-size trade bands |
| [method/](method/index.md) | Point-in-time replay, the autoresearch tuning loop, and the ML roadmap |

## Frontmatter convention (required on every doc)

```yaml
---
type: <Factor | Model | Gate | Indicator | Playbook | DataSource | Table | GroundTruth | Method | Index>
title: <human title>
description: <one-line summary used for retrieval>
resource: <repo-relative path to the code/file this documents>
tags: [<searchable>, <keywords>]
timestamp: <ISO-8601 UTC>
---
```

## Provenance & caveats

- The R-Factor **blend weights are a reasoned starting point, NOT fitted** to
  TradeFinder ground truth — see [ground-truth/calibration.md](ground-truth/calibration.md).
- Anything marked *provisional* or *date-dependent* has not survived enough
  recorded days to trust; [method/point-in-time-replay.md](method/point-in-time-replay.md)
  is the benchmark that promotes a change from provisional to shipped.
- This is analysis tooling. No doc here authorizes placing an order; the agents
  never place, modify, or cancel orders.
