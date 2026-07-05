---
type: Gate
title: Entry window (09:40–11:00 IST)
description: >
  Why suggestions are confined to 09:40–11:00 IST: TF entries cluster
  10:00–10:40 after the opening-range is set; entries outside this window are
  unproven for this strategy. force=1 bypasses for testing only.
resource: lib/trade-suggest/config.ts
tags: [window, timing, entry, gate]
timestamp: 2026-07-05T00:00:00Z
---

# Entry window — 09:40–11:00 IST

```
WINDOW_START_MIN = 09:40 IST
WINDOW_END_MIN   = 11:00 IST
```

## Why this window

- TradeFinder's real entries cluster **10:00–10:40**, once the 9:15–9:45 opening
  range is set and opening-auction noise has cleared.
- Entering at the 9:45 open with a previous-candle-low stop gets stopped out
  instantly; the move needs to be established first.
- Entries **outside** 09:40–11:00 are **unproven** for this strategy — the window
  exists deliberately.

Related: the R-Factor's own [timing gate](../models/r-factor.md#the-timing-gate)
(`isAfterEntryTime`, default 09:45) is informational; this engine window is the
operational constraint.

## force=1

`GET /api/trade-suggest?force=1` bypasses the window for out-of-window testing.
**Never use `force=1` in loop mode** — see [playbooks/morning-scan.md](../playbooks/morning-scan.md).

## Loop cadence

Inside the window, a 5-minute loop aligns with the Fyers candle bucket (each
firing sees exactly one new completed bar). See
[playbooks/morning-scan.md](../playbooks/morning-scan.md) and
[data-sources/fyers.md](../data-sources/fyers.md).
