---
type: Table
title: Trade bands (core / extended / avoid)
description: >
  Lot-size-based tradeability bands — core (250–1500), extended (the shoulders),
  avoid (<150 / >2500). Stored in trade_band_ranges + band_overrides. The
  'avoid' band is NEVER shown on live surfaces.
resource: lib/trade-band.ts
tags: [universe, trade-bands, lot-size, avoid]
timestamp: 2026-07-05T00:00:00Z
---

# Trade bands

Classifies each F&O name by lot size into a tradeability band. Logic in
`lib/trade-band.ts`; the numeric ranges are a queryable lookup in
`trade_band_ranges` (4 rows — 'extended' has two shoulder rows around Core), with
manual `band_overrides` (28 rows) applied at seed time.

## The bands

| Band | Lot size | Meaning |
|------|----------|---------|
| `core` | 250–1500 | the sweet spot |
| `extended` | 150–249 / 1501–2500 | the two shoulders around core |
| `avoid` | < 150 / > 2500 | too small or too large a lot |

`band_overrides` force specific symbols to a band (e.g. 'avoid') regardless of lot
size — edited deliberately, not auto-populated.

## ⚠ 'avoid' is never shown live

Live surfaces (`/live`, sector-leaders, nse-watchlist, quote routes) must show
**only F&O stocks and NEVER the 'avoid' band** — gated in
`app/api/live/_lib/fno-universe.ts`. The [trade-suggest](../engine/index.md)
candidate pool inherits this.

## Related

- [fno-stocks.md](fno-stocks.md) · [data-sources/nse-feeds.md](../data-sources/nse-feeds.md)
