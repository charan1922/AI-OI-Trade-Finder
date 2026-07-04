# ML roadmap — trade-suggest calibration (deferred, do later)

Written 2026-07-03. The data flywheel is already running: every 5 min the
Fyers recorder captures features (candles, futures OI/depth, NSE combined OI),
and every /trade-suggest pick gets a same-day outcome label (review action).
ML work should ride that flywheel — in this order.

UPDATE 2026-07-04: the fixed-benchmark loop exists —
`scripts/replay-window.ts` replays any recorded session point-in-time
(zero lookahead) through the REAL production code and A/B-tests variants
(SL floors, extended handling, weight sets) on ΣR. First accepted change:
extended movers hard-gated (0-for-5). Run it after every recorded day;
weight optimization (Phase 1's spiritual predecessor) now has its harness —
it just needs more recorded days before any weight change is trustworthy.

## Phase 0 — prerequisite: widen the label set (do first, ~20-line change)

Persist ALL gate-passing survivors per scan (not just the top 3) into
`trade_suggestions` with outcomes. ~3 labels/day → 10–20/day; a usable
dataset in weeks instead of months. Everything below depends on this.

## Phase 1 — score calibration (logistic regression)

- Target: P(≥1% favorable spot move before close) from features already
  persisted: rFactor, confidence, oiLevel, oiUrgency, nseOiPct, spreadPct,
  imbalance, orBreakout, extended, sector breadth, time-of-day.
- Train OFFLINE in Python (repo already has the vectorbt toolchain).
  Walk-forward validation only — never test on training days.
- Ship as plain coefficients into `lib/trade-suggest/config.ts` (no ML
  runtime in prod; auditable; instantly reversible).
- Drift monitor: the existing `{action:'stats'}` endpoint — retrain when
  live hit-rate decays vs fitted expectation.
- Start when ~100+ reviewed rows exist.

## Phase 2 — TF replication (supervised regression on ground truth)

Each captured TF day (tf_snapshots schema exists; Sensibull verified P&L
screenshots) is a training row for "what TF actually ranks". The current
spread-linear model came from 2 days; ~20 days justifies a regularized
gradient-boosted fit that can learn what spread alone misses (e.g. the
2026-07-03 SUNPHARMA options-led build: futures OI 0.90× but NSE combined
+8.1%, TF's winner of the day).

## Phase 3 — with real volume (months of data)

- Entry-timing: P(move extends ≥1% before the last-candle SL) from the
  5-min sequence state at scan time.
- Day-regime classifier: trend vs chop from the first 45 min of index +
  breadth; suppress suggestions on chop days (the 2026-07-03 stop-outs were
  a chop-day pattern).

## Explicitly out of scope

Deep learning / LLM price prediction at this data size (guaranteed
overfit); any model that places orders unattended.

## Also deferred (non-ML)

- ~~EOD leaderboard UI~~ DONE 2026-07-03: dedicated /trade-suggest page
  (today's persisted picks + EOD leaderboard, suggested names highlighted).
- Trade Assistant live tool: /trade-assistant's function-calling tools are
  historical-only (list_trades / rank_trades / get_trade_context over the TF
  log) — it can NOT find live window stocks today. Small upgrade: add a
  `get_live_suggestions` tool to lib/ai-assistant/tools.ts that calls
  runTradeSuggest(), so the chatbot answers "what should I trade now?" with
  the same evidence-backed picks as the /trade-suggest skill.
