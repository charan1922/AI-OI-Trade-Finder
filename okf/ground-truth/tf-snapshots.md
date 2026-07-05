---
type: GroundTruth
title: tf_snapshots — captured TF R-Factor
description: >
  The tf_snapshots table (639 rows) — captured TradeFinder R-Factor per date/
  symbol (rFactor, ltp, prevClose, pctChange). Dormant training data reserved for
  ML roadmap Phase 2; not read by live code today. Do NOT delete.
resource: prisma/schema.prisma
tags: [ground-truth, tf-snapshots, training-data, ml]
timestamp: 2026-07-05T00:00:00Z
---

# tf_snapshots — captured TF R-Factor

The `TfSnapshot` Prisma model / `tf_snapshots` table — one row per captured
(date, symbol): `rFactor`, `ltp`, `prevClose`, `pctChange`. ~639 rows.

## Status: dormant, NOT dead

No live code path reads `prisma.tfSnapshot` today — but it holds **scarce
ground-truth** that is expensive to recapture, and [ML roadmap Phase 2](../method/ml-roadmap.md)
explicitly reserves it: *"Each captured TF day (tf_snapshots schema exists;
Sensibull verified P&L) is a training row for what TF actually ranks."*

> **Do NOT delete this table.** Unlike the empty legacy tables that were dropped,
> this is reserved training data. If archiving is ever needed, export to JSON/CSV
> — don't drop.

## Why it matters

The current EOD spread-linear model (`R = 1.56 × spread ratio`) was fit from only
**2 days**. ~20 captured days would justify a regularized gradient-boosted fit
that learns what spread alone misses (e.g. the SUNPHARMA options-led build). See
[calibration.md](calibration.md).

## Related

- [tf-fingerprint.md](tf-fingerprint.md) · [calibration.md](calibration.md) · [method/ml-roadmap.md](../method/ml-roadmap.md)
