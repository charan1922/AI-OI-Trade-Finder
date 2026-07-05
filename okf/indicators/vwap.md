---
type: Indicator
title: Session VWAP
description: >
  Volume-weighted average price for the session from the recorded 5-min bars,
  typical price = (H+L+C)/3. The intraday fair-value line; entry on the
  favorable side is display evidence.
resource: lib/signals/indicators.ts
tags: [indicator, vwap, fair-value]
timestamp: 2026-07-05T00:00:00Z
---

# Session VWAP — `sessionVwap(bars)`

The session's volume-weighted average price — the intraday fair-value reference.

## Definition

```
typical = (H + L + C) / 3
VWAP    = Σ(typical · volume) / Σ(volume)      # over usable bars with volume > 0
```

- Returns **null** when no volume has printed.

## Use — display evidence

On each pick: `vwap` + `vwapAligned` (is the entry on the favorable side — above
VWAP for CE, below for PE?). Context only, **not a gate**: on the replay
benchmark a VWAP gate would have blocked the day's only winner. See
[engine/scoring.md](../engine/scoring.md).

## Related

- [supertrend.md](supertrend.md) · [atr.md](atr.md)
