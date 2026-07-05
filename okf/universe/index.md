---
type: Index
title: Universe
description: >
  The tradeable F&O universe (fno_stocks: 216 names with lot sizes + sector) and
  the lot-size trade bands (core / extended / avoid). The 'avoid' band is never
  shown on live surfaces.
resource: lib/trade-band.ts
tags: [universe, fno, trade-bands, index]
timestamp: 2026-07-05T00:00:00Z
---

# Universe

- [fno-stocks.md](fno-stocks.md) — the 216-name F&O universe with lot sizes,
  sector, and trade band
- [trade-bands.md](trade-bands.md) — the lot-size band classification and the
  'avoid'-never-shown rule

The candidate pool for [trade-suggest](../engine/index.md) is drawn from the
[NSE feeds](../data-sources/nse-feeds.md), F&O-gated against this universe.
