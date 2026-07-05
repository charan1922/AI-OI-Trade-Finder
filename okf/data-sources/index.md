---
type: Index
title: Data sources
description: >
  Where the live numbers come from — Dhan (quotes, option chain, TOTP auth),
  Fyers (5-min candles + OI, the sole candle source), NSE market-pulse feeds,
  NSE bhavcopy (EOD), and the SQLite tables. This is the real-data layer.
resource: lib/dhan
tags: [data-sources, dhan, fyers, nse, bhavcopy, sqlite, index]
timestamp: 2026-07-05T00:00:00Z
---

# Data sources

The knowledge bundle describes *meaning*; the **numbers** live here. Never put
live prices/OI/candles in markdown — read them from these sources at runtime.

- [dhan.md](dhan.md) — live quotes, option chain, charts; TOTP auth; rate limits
- [fyers.md](fyers.md) — 5-min EQ+FUT candles + OI; the **sole candle source**
- [nse-feeds.md](nse-feeds.md) — the market-pulse movers feeds (candidate pool)
- [bhavcopy.md](bhavcopy.md) — NSE EOD equity + F&O; 20-day baselines
- [tables.md](tables.md) — the SQLite/Prisma tables and what each holds

## Golden rule on Dhan

**No parallel Dhan calls** — always sequential with the right delay. Quote APIs
are 1 req/sec; `Promise.all` on Dhan requests triggers 429 immediately. See
[dhan.md](dhan.md).
