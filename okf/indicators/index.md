---
type: Index
title: Indicators
description: >
  Classic intraday indicators computed from recorded 5-min bars — Wilder
  ATR(14), Supertrend(10,3), session VWAP. Standard formulations so values match
  the user's charting tools. Display / entry-confirmation only, NOT R-Factor inputs.
resource: lib/signals/indicators.ts
tags: [indicators, atr, supertrend, vwap, index]
timestamp: 2026-07-05T00:00:00Z
---

# Indicators

Pure functions over the recorded 5-min bars (`lib/signals/indicators.ts`), using
**standard formulations only**, so values match what the user's charting tools
show and nothing is invented.

- [atr.md](atr.md) — Wilder ATR(14), the noise/volatility unit
- [supertrend.md](supertrend.md) — Supertrend(10,3), trend direction + trailing line
- [vwap.md](vwap.md) — session VWAP

## Role: entry-confirmation, not R-Factor

These are the **entry-confirmation layer**, deliberately separate from the
[R-Factor](../models/r-factor.md) institutional-flow score (a different axis).
In the trade-suggest engine they are **display evidence, not gates or weights**
(see [engine/scoring.md](../engine/scoring.md)) — e.g. Supertrend misalignment is
flagged with ⚠ but does not block a pick.

This is also why [ADX is excluded](../factors/index.md#why-no-adx) from R-Factor.
