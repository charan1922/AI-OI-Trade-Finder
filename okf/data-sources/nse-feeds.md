---
type: DataSource
title: NSE market-pulse feeds
description: >
  NSE's live movers feeds — OI spurts, F&O gainers/losers, most-active by value
  and by volume — the trade-suggest candidate pool. F&O-gated, 30s shared cache,
  carry combined (fut+opt) OI %-change and sector.
resource: app/api/live/nse-watchlist/route.ts
tags: [data-source, nse, movers, oi-spurts, candidates]
timestamp: 2026-07-05T00:00:00Z
---

# NSE market-pulse feeds

The candidate pool for [trade-suggest](../engine/index.md) — exactly what the
`/nse/movers` page surfaces (the user's primary hunting ground).

## Legacy mover feeds

| Source | Content |
|--------|---------|
| `nse-oi` | OI spurts — the big-player build-up list |
| `nse-gainers` | F&O gainers |
| `nse-losers` | F&O losers |
| `nse-active-value` | most active by traded value |
| `nse-active-volume` | most active by traded volume |

Served via `GET /api/live/nse-watchlist?source=...`. Union + dedupe → ~40–80
names with `sector` attached.

## Key properties

- **F&O-gated** server-side (only F&O names; never the 'avoid' band —
  [trade-bands.md](../universe/trade-bands.md)).
- **30-second shared cache** → a 5-min scan loop is cheap on rate limits.
- Each row carries the **combined (futures + options) OI %-change** (`nseOiPct`),
  which powers the alternate OI-evidence gate ([gates.md](../engine/gates.md)) and
  the derived `combinedOiLevel` display field.
- `onOiSpurtList` marks names on the OI build-up feed (big-player activity).

## Caveat — live feed vs bhavcopy

NSE's live oi-spurts feed can disagree with the official EOD bhavcopy per-stock
(seen: TECHM Jul-2/3 live +38.47% vs correct +1.26%). When they diverge, verify
against the [bhavcopy](bhavcopy.md) file before assuming our data is wrong — our
stored data has been verified exact to the NSE source.

## Related

- [bhavcopy.md](bhavcopy.md) · [engine/gates.md](../engine/gates.md) · [universe/fno-stocks.md](../universe/fno-stocks.md)
