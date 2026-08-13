---
type: Gate
title: Trade-Suggest hard gates
description: >
  Historical App-factor gates retained for replay research. Production entries
  now come only from the measured TradeFinder selector.
resource: lib/trade-suggest/config.ts
tags: [gate, trade-suggest, fingerprint, thresholds]
timestamp: 2026-07-05T00:00:00Z
---

# Historical App-factor replay gates

> These are not production entry gates. Production fails closed on the TF board
> and requires TF accumulation, direction, opening-range breakout, Supertrend,
> options premium, and the measured since-09:45 chase ceiling.

Every threshold is in `lib/trade-suggest/config.ts`. A candidate must clear **ALL**
gates to be scored. Each gate's rejections are counted in the response `gated{}`
map for transparency.

| Gate | Constant | Threshold | Meaning |
|------|----------|-----------|---------|
| R-Factor | `MIN_RFACTOR` | **≥ 3.6** (1–8 scale) | non-neutral strength (was 2.5 on the 1–5 scale — same raw cutoff 0.375) |
| Confidence | `MIN_CONFIDENCE` | **≥ 0.2** | directional-factor agreement |
| Futures OI level | `MIN_OI_LEVEL` | **≥ 1.1×** | OI ÷ 20-day avg — the TF minimum fingerprint |
| — OR NSE combined OI | `MIN_NSE_OI_PCT` | **≥ 5%** | alternate path for options-led builds |
| Turnover | `MIN_TURNOVER_SCORE` | factor score **≥ 0.1** | = 1.2× the 20-day avg (the 3rd TF pillar) |
| Spread | `SUGGESTION_MAX_SPREAD_PCT` | **≤ 0.3%** of mid | execution-cost ceiling on the UNDERLYING equity (not the option) |
| Bias | — | non-neutral | must be a clear buy or sell |
| Price agreement | — | price must agree with the bias | bullish → up / breakout; bearish → mirrored |

## The OI-evidence OR (important)

The OI gate passes on **EITHER** futures OI level ≥ 1.1× **OR** NSE's combined
(futures + options) OI change ≥ 5%. Options-led builds don't register in
futures-only OI level. Live example (2026-07-03): **SUNPHARMA** futures OI was
0.90× average but NSE combined was +8.1%, and TF's winning trade that day was the
SUNPHARMA 1920 CE. Futures-only gating would have missed it. See
[ground-truth/tf-fingerprint.md](../ground-truth/tf-fingerprint.md).

## Related

- [scoring.md](scoring.md) · [oi-level](../factors/oi-level.md) · [ground-truth/tf-fingerprint.md](../ground-truth/tf-fingerprint.md)
