---
type: Index
title: Ground truth
description: >
  What TradeFinder actually does (the fingerprint), the captured TF R-Factor
  snapshots (tf_snapshots), and the honest calibration status — the R-Factor
  weights are NOT yet fitted to TF.
resource: tracking/ml-roadmap.md
tags: [ground-truth, tradefinder, calibration, index]
timestamp: 2026-07-05T00:00:00Z
---

# Ground truth

TradeFinder (TF) is the external reference the R-Factor is measured against.

- [tf-fingerprint.md](tf-fingerprint.md) — what TF's picks look like (near-ATM,
  10:00–10:40, the OI/turnover/spread fingerprint, the EOD spread-linear model)
- [tf-snapshots.md](tf-snapshots.md) — the `tf_snapshots` captured-day store (639
  rows) reserved for ML Phase 2
- [calibration.md](calibration.md) — the honest status: weights are provisional,
  only 2 usable capture dates so far

## The one-line truth

The R-Factor **blend weights are a reasoned starting point, NOT fitted** to TF.
Everything here exists to eventually calibrate them — see [method/ml-roadmap.md](../method/ml-roadmap.md).
