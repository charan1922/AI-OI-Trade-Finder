---
type: GroundTruth
title: Calibration status
description: >
  The honest state of R-Factor calibration — weights are a reasoned starting
  point, NOT fitted to TF; only 2 of 3 capture dates are usable; the spread
  relationship is strongly date-dependent. Treat weights as provisional.
resource: lib/r-factor/README.md
tags: [ground-truth, calibration, provisional, weights]
timestamp: 2026-07-05T00:00:00Z
---

# Calibration status

**Read this before quoting the R-Factor weights as authoritative.**

## The weights are provisional

`DEFAULT_WEIGHTS` ([models/r-factor.md](../models/r-factor.md)) are a **reasoned
starting point, NOT fitted** to TradeFinder ground truth. They lean on what the
project found most predictive (sustained OI level, smart-money, tight spread), but
the exact numbers are provisional. Override per call via `config.weights`.

## What the 2026-06-23 calibration showed

Fitting against `../derive-r/ground_truth` (where `param_3` = TF's R-Factor):

- **Only 2 of 3 capture dates were usable** (bhavcopy covers 2026-03-19/20, not
  03-26). Two days is too few for robust weights.
- The **list-derived factors alone do NOT match TF** (top-10 overlap 1–2/10);
  turnover/volume even correlated *negatively* with TF's score.
- TF's dominant signal is the **[range-expansion spread](../factors/range-spread.md)**
  (NOT bid-ask spread). But it is **strongly date-dependent**: 2026-03-20 scored
  7/10 top-10 (Spearman 0.70); 2026-03-19 scored 1/10 (Spearman −0.20).

## Implication

- The [range-spread](../factors/range-spread.md) weight (0.18) is provisional.
- Do not trust the weights as calibrated. The path to calibration is more
  captured TF days ([tf-snapshots.md](tf-snapshots.md)) fed through the
  [ML roadmap](../method/ml-roadmap.md), and every proposed change validated on
  the [replay benchmark](../method/point-in-time-replay.md).

## Related

- [tf-fingerprint.md](tf-fingerprint.md) · [tf-snapshots.md](tf-snapshots.md) · [method/autoresearch.md](../method/autoresearch.md)
