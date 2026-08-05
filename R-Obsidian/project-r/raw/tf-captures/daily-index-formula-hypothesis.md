---
type: research-note
tags: [sector-scope, r-factor, hypothesis, unproven]
created: 2026-08-05
updated: 2026-08-05
status: n=1, UNPROVEN — needs 5-10 more days before trusting
---

# TradeFinder daily-index (`param_3`) — formula hypothesis

## What this is

TradeFinder's Sector Scope bar graph is driven by
`GET /api_be/data/order/daily-index`, one signed float per index
(`param_3`). Captured ground truth for **2026-08-05**:
[[2026-08-05-sector-scope-daily-index.json]]. Matches the mobile-app
screenshot taken the same day (AUTO 5.3, METAL 4.3, ENERGY negative).

No public source documents this formula — searched TradeFinder's own site,
TradingView scripts referencing "R-Factor", and general web search. The only
public description found (from a TradingView script inspired by TradeFinder)
is generic: "range and volatility vs a 20-day baseline" — consistent with this
project's own `derive-r` research, nothing new.

## What it is NOT

- Not a simple average of constituent % moves (r=0.70, wrong sign on 8/14
  baskets when tested against our live `/api/sector-scope/indices` output).
- Not the constituent mean R-Factor (r=0.65).
- Not the single highest constituent R-Factor — NIFTY ENERGY is **negative**
  (-1.75) despite containing the day's single hottest stock anywhere in the
  196-stock universe (NHPC, R-Factor 6.32). So the bar is not "how hot is the
  hottest stock in this basket."
- **Codex's shipped formula (`1.5596 × range-expansion-vs-20d`,
  `app/api/sector-scope/indices/route.ts`) is structurally wrong**: it is
  always positive, so it can never produce ENERGY's negative value. Confirmed
  live: 8 of 14 baskets have the WRONG SIGN, and the two right-signed ones
  (AUTO, METAL) undershoot TF by roughly 3x.

## Best lead so far — R-weighted top-3

Take each basket's **3 stocks with the highest TF R-Factor** that day, and
compute their % move weighted by that R-Factor:

```
top3Pct = Σ(pct_i × R_i) / Σ(R_i)     for the top 3 stocks by R_i in the basket
```

Correlation with TF's `param_3`: **r = 0.912** (n=15, one session).
Linear fit: `TF ≈ 1.057 × top3Pct + 0.034`, R² = 0.83.

| Basket | TF | top3Pct | pred | err |
|---|---|---|---|---|
| NIFTY AUTO | 5.30 | 3.53 | 3.77 | -1.53 |
| NIFTY METAL | 4.32 | 4.13 | 4.40 | +0.08 |
| NIFTY 50 | 2.27 | 1.80 | 1.94 | -0.33 |
| SENSEX | 1.95 | 1.33 | 1.44 | -0.51 |
| NIFTY FIN SERVICE | 0.78 | 0.88 | 0.96 | +0.19 |
| NIFTY MID SELECT | 0.76 | 1.19 | 1.29 | +0.53 |
| NIFTY PHARMA | 0.70 | 0.93 | 1.02 | +0.31 |
| NIFTY CEMENT | 0.57 | 1.23 | 1.33 | +0.76 |
| NIFTY PVT BANK | 0.49 | 0.63 | 0.70 | +0.21 |
| NIFTY PSU BANK | 0.48 | 1.00 | 1.09 | +0.61 |
| NIFTY REALTY | 0.48 | 1.73 | 1.86 | +1.38 |
| NIFTY IT | 0.43 | 0.20 | 0.25 | -0.18 |
| NIFTY FMCG | 0.39 | -0.01 | 0.02 | -0.36 |
| NIFTY BANK | 0.06 | -0.83 | -0.84 | -0.91 |
| NIFTY ENERGY | -1.75 | -1.92 | -2.00 | -0.24 |

13/15 baskets have the correct sign. The two misses (FMCG, BANK) both have a
TF true value near zero, so "wrong sign" there means "flat vs barely-flat,"
not a real directional miss.

## The catch — this is not independently computable yet

The weight (`R_i`) used above is **TradeFinder's own captured R-Factor per
stock**, not this app's. So this result shows the *shape* of TF's index logic
(it's driven by a small number of the most-active names, not a broad average,
and not the single loudest name either) — it does not yet give the app a way
to compute the index value from Dhan/Fyers alone. That needs our own
per-stock R-Factor to be a good enough stand-in for TF's, which is a separate,
harder open question — see [[../../wiki/sectors/fno-sector-map|fno-sector-map]]
and the parent repo's `derive-r/R_FACTOR_JOURNEY.md`.

## Why this is not trusted yet

**n=1.** Fifteen data points from a single session is enough to notice a
pattern, not enough to trust one. R²=0.83 on one day could be coincidence.

## Next step

Capture `daily-index` + the per-stock table for 5-10 more sessions
(`R-Obsidian/project-r/raw/tf-captures/YYYY-MM-DD-sector-scope-*`), then
re-test whether R-weighted-top-3 still holds, or whether it collapses once
more days are added. Do NOT wire this into
`app/api/sector-scope/indices/route.ts` before that — the currently shipped
`1.5596` formula is known-wrong (see above) but this replacement is
unconfirmed, not merely uncalibrated.
