---
type: DataSource
title: NSE bhavcopy (EOD)
description: >
  NSE daily EOD equity + F&O data per stock — the source of the 20-day baselines
  (OI, turnover, range) the R-Factor normalizes against, and the EOD leaderboard.
  User-triggered sync. Delivery % is empty. Per-expiry OI in companion tables.
resource: lib/historify/bhavcopy-service.ts
tags: [data-source, bhavcopy, eod, baselines]
timestamp: 2026-07-05T00:00:00Z
---

# NSE bhavcopy (EOD)

The end-of-day truth and the source of the **20-day baselines** every ratio
factor compares against ([oi-level](../factors/oi-level.md),
[turnover](../factors/turnover.md), [range-spread](../factors/range-spread.md)).

## Tables

- `bhavcopy_days` — one row per stock per day: equity OHLC/volume/turnover/last,
  futures OI/OI-change/turnover/volume, options OI/volume/turnover, CE/PE
  volumes. ~33.8k rows. ([tables.md](tables.md))
- `bhavcopy_fut_expiry`, `bhavcopy_option_expiry`, `bhavcopy_option_strike` —
  per-expiry / per-strike breakdowns (combined-OI is summed per contract-month,
  calendar-clipped).

## Properties

- **User-triggered sync only** — no page auto-downloads. NSE requires a session
  cookie (visit nseindia.com first).
- **Delivery % is empty** — `eqDeliveryPct`/`eqDeliveryQty` are 0 for all rows
  (the MTO delivery feed is never populated), so delivery is NOT a usable signal
  yet — hence [smart-money](../factors/smart-money.md) proxies accumulation from
  OI + turnover, not delivery.

## EOD leaderboard

The [scorecard](../playbooks/scorecard-review.md) EOD board ranks by the
parent-validated spread-linear model `R = 1.56 × spread ratio` (TF's EOD
fingerprint) — see [ground-truth/tf-fingerprint.md](../ground-truth/tf-fingerprint.md).

## Related

- [nse-feeds.md](nse-feeds.md) · [tables.md](tables.md) · [ground-truth/calibration.md](../ground-truth/calibration.md)
