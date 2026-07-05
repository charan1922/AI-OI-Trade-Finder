---
type: Table
title: F&O universe (fno_stocks)
description: >
  The 216-name NSE F&O universe with lot sizes (three expiry months), sector
  classification (+ provenance), and the derived trade band. The gate for
  "is this an F&O name we trade".
resource: prisma/schema.prisma
tags: [universe, fno-stocks, lot-size, sector]
timestamp: 2026-07-05T00:00:00Z
---

# F&O universe (`fno_stocks`)

The `FnoStock` model / `fno_stocks` table — 216 rows, the NSE F&O universe with
lot sizes and sector, seeded from "Dhan - Nse Fno Lot Size.csv" by
`scripts/seed-fno-stocks.mjs`.

## Columns of interest

- `symbol`, `name`, `isIndex`.
- `lotSize`, `lotSizeNext`, `lotSizeFar` — contract lot sizes for the three
  published expiry months; `lotMonths` records which months.
- `sector` + `sectorSource` — provenance: `tf-map` (the 207-symbol
  TradeFinder-derived map), `inferred` (matched to the closest peer's convention,
  e.g. defence→AUTO, liquor→FMCG), `index` (not a stock).
- `tradeBand` — `core | extended | avoid` by lot size ([trade-bands.md](trade-bands.md)),
  persisted at seed time.

## Role

- The F&O gate for candidates from the [NSE feeds](../data-sources/nse-feeds.md).
- The sector source for [sector breadth](../engine/scoring.md) and sector-flow.
- The enrollment list for the [Fyers candle poller](../data-sources/fyers.md)
  (non-index, non-'avoid').

## Related

- [trade-bands.md](trade-bands.md) · [data-sources/nse-feeds.md](../data-sources/nse-feeds.md)
