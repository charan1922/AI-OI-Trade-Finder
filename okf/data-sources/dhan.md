---
type: DataSource
title: Dhan V2 API
description: >
  Dhan V2 market feed — live equity/futures quotes (OHLC, volume, VWAP, OI,
  depth), option chain, and charts. TOTP auto-auth. Quote APIs 1 req/sec, Data
  APIs 10 req/sec. NEVER call Dhan in parallel.
resource: lib/dhan/market-feed.ts
tags: [data-source, dhan, quotes, option-chain, rate-limits, auth]
timestamp: 2026-07-05T00:00:00Z
---

# Dhan V2 API

The live-quote source. `lib/dhan/market-feed.ts` + `lib/dhan/auth.ts`.

## Endpoints used

| Endpoint | Returns | Rate limit |
|----------|---------|-----------|
| `POST /v2/marketfeed/quote` (NSE_EQ) | OHLC, volume, average_price (VWAP), last_price | **1 req/sec** |
| `POST /v2/marketfeed/quote` (NSE_FNO) | futures volume, OI, VWAP, last_price, depth | **1 req/sec** |
| `POST /v2/optionchain` | per-strike CE/PE volume, OI, greeks | **1 req/sec** |
| `POST /v2/charts/intraday` | 5-min OHLCV (+OI flag) | 10 req/sec |
| `POST /v2/charts/historical` | daily OHLCV (+OI flag) | 10 req/sec |

## ⚠ No parallel calls

Always **sequential** with per-category delay (100ms Data, 1000ms+ Quote).
`Promise.all` on Dhan requests triggers 429 immediately. The trade-suggest engine
batches the option-premium quote into a single call precisely to respect this.

## Auth (TOTP)

`lib/dhan/auth.ts` auto-generates access tokens via TOTP (`otpauth`): disk-cached
token → renew → generate via TOTP → static `DHAN_ACCESS_TOKEN` fallback. Token
persisted to `data/.dhan-token.json` (gitignored). Generation is limited to once
per 2 minutes; concurrent calls are deduped via a promise lock.

## Volume unit mismatch

Dhan reports **futures volume in shares**; NSE bhavcopy reports **contracts/lots**.
Divide Dhan volume by `lotSize` (from `master_contracts`) before Z-scores.
Futures turnover uses `average_price` (VWAP), not `last_price`.

## Used by

Option-premium quote + live equity/futures quote in the [option plan](../engine/option-plan.md);
R-Factor live inputs. Also the [Dhan MCP](https://mcp.dhan.co/mcp) for portfolio/order
tools (analysis only here).

## Related

- [fyers.md](fyers.md) (candles) · [nse-feeds.md](nse-feeds.md) · [engine/option-plan.md](../engine/option-plan.md)
