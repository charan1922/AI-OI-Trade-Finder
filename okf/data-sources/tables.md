---
type: Table
title: SQLite / Prisma tables
description: >
  The 20 tables in data/project-r.db and what each holds — the app's real-data
  store (SQLite via Prisma + raw SQL). Live/EOD market data, universe, and the
  persisted suggestions + ground truth.
resource: prisma/schema.prisma
tags: [table, sqlite, prisma, schema, data]
timestamp: 2026-07-05T00:00:00Z
---

# SQLite / Prisma tables

`data/project-r.db` (SQLite via `@prisma/adapter-better-sqlite3`). 10 tables are
Prisma models in `prisma/schema.prisma`; the rest are raw-SQL tables created at
runtime (some declared as models so `db push` preserves them). Row counts are
snapshots (2026-07-05).

| Table | Rows | Holds |
|-------|-----:|-------|
| `master_contracts` | ~95.7k | Dhan instrument mappings (symbol → securityId, lot, expiry) |
| `bhavcopy_days` | ~33.8k | NSE EOD equity + F&O per stock/day ([bhavcopy](bhavcopy.md)) |
| `bhavcopy_fut_expiry` | ~100.7k | per-expiry futures OI |
| `bhavcopy_option_expiry` | ~100.7k | per-expiry option OI |
| `bhavcopy_option_strike` | ~88.3k | per-strike option OI |
| `fyers_candles` | ~27.5k | Fyers 5-min EQ+FUT candles + OI, TODAY only ([fyers](fyers.md)) |
| `oi_intraday` | ~32.7k | intraday futures-OI snapshots (Live Urgency time series) |
| `backtest_equity/futures/options` | 721k/151k/55k | historical 5-min candle store (Trade Viewer / Data Downloader / AI assistant) |
| `trade_contracts` | ~11 | Dhan contract IDs preserved per backtest trade |
| `fno_stocks` | 216 | F&O universe + lot sizes + sector + trade band ([fno-stocks](../universe/fno-stocks.md)) |
| `trade_band_ranges` | 4 | lot-size → band lookup ([trade-bands](../universe/trade-bands.md)) |
| `band_overrides` | 28 | manual band overrides |
| `market_holidays` | 30 | NSE trading calendar |
| `fno_expiry_calendar` | 24 | F&O expiry calendar |
| `tf_snapshots` | 639 | captured TradeFinder R-Factor ground truth ([tf-snapshots](../ground-truth/tf-snapshots.md)) |
| `trade_suggestions` | — | persisted /trade-suggest calls + same-day outcomes |
| `_prisma_migrations`, `sqlite_sequence` | — | system |

## Notes

- Backtest data is **SQLite via Prisma**, not DuckDB (despite the parent CLAUDE.md).
- `master_contracts` `ensureSynced()` throws unless synced TODAY; code paths that
  can't sync resolve `master_contracts` directly.
- Empty/unused legacy tables (`watchlist`, `settings`, `option_trades`,
  `scheduler_jobs`, `activity`, `dhan_*`) were dropped during DB cleanup.

## Related

- [bhavcopy.md](bhavcopy.md) · [fyers.md](fyers.md) · [universe/index.md](../universe/index.md)
