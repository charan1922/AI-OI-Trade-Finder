---
name: dhanhq
description: >
  Use when the user mentions DhanHQ, Dhan API, or wants to trade on
  Indian exchanges (NSE, BSE, MCX). Triggers for: place, modify, or
  cancel stock/F&O/commodity orders on Dhan; fetch portfolio holdings
  or positions; get live or historical market data; access option
  chains with Greeks; check fund limits or margin; build any trading
  automation for Indian markets; resolve NSE/BSE instrument IDs;
  stream live WebSocket market feeds or order updates. Also trigger
  for general questions about programmatic trading on Indian exchanges
  if Dhan is the user's broker.
compatibility: >
  Requires Python 3.8+ and the dhanhq package (pip install dhanhq).
  Order placement, modification, and cancellation require static IP
  whitelisting on Dhan. Data APIs (quotes, history, option chain,
  live feed) require an active Dhan Data Plan.
---

# DhanHQ — Indian Market Trading Skill

## Setup

Stable install:

```python
pip install dhanhq
```

Use the current SDK branch when you need newer v2 capabilities such as 200-level depth or the latest helper coverage:

```python
pip install --upgrade dhanhq
```

Minimal initialization:

```python
from dhanhq import DhanContext, dhanhq

dhan_context = DhanContext("YOUR_CLIENT_ID", "YOUR_ACCESS_TOKEN")
dhan = dhanhq(dhan_context)
```

Environment-variable setup:

```python
import os
from dhanhq import DhanContext, dhanhq

dhan_context = DhanContext(
    os.environ["DHAN_CLIENT_ID"],
    os.environ["DHAN_ACCESS_TOKEN"],
)
dhan = dhanhq(dhan_context)
```

If generating scripts for this repo, prefer:

```python
from scripts.dhan_helpers import get_client

dhan, dhan_context = get_client()
```

## Safety Rules — Always Enforce

1. Confirm before placing live orders.
2. Show a readable order preview before execution.
3. Default to `LIMIT` orders unless the user explicitly wants `MARKET`.
4. Warn when notional exceeds `Rs. 50,000`.
5. For F&O, validate lot size before placement.
6. Never use `CNC` or `MTF` for F&O, commodity, or currency segments.
7. Never hardcode credentials in generated code.
8. Ask for confirmation before `modify_order`, `cancel_order`, `kill_switch`, or any multi-leg live execution.

## Access Checks Before Live Use

Before using the account for live work, verify:

1. Access token is valid.
2. `dhan_login.user_profile(...)` or `GET /profile` shows the needed account setup.
3. `dataPlan` is active for quote/history/feed/option-chain use.
4. Static IP is configured for order placement, order modification, order cancellation, super orders, and forever orders.

Useful profile fields:
- `tokenValidity`
- `activeSegment`
- `ddpi`
- `mtf`
- `dataPlan`
- `dataValidity`

## Current SDK Constants

| Category | Constant | Value |
|----------|----------|-------|
| Exchange | `dhanhq.NSE` | `NSE_EQ` |
| | `dhanhq.BSE` | `BSE_EQ` |
| | `dhanhq.NSE_FNO` | `NSE_FNO` |
| | `dhanhq.BSE_FNO` | `BSE_FNO` |
| | `dhanhq.MCX` | `MCX_COMM` |
| | `dhanhq.CUR` | `NSE_CURRENCY` |
| | `dhanhq.INDEX` | `IDX_I` |
| Transaction | `dhanhq.BUY` | `BUY` |
| | `dhanhq.SELL` | `SELL` |
| Order Type | `dhanhq.LIMIT` | `LIMIT` |
| | `dhanhq.MARKET` | `MARKET` |
| | `dhanhq.SL` | `STOP_LOSS` |
| | `dhanhq.SLM` | `STOP_LOSS_MARKET` |
| Product | `dhanhq.CNC` | `CNC` |
| | `dhanhq.INTRA` | `INTRADAY` |
| | `dhanhq.MARGIN` | `MARGIN` |
| | `dhanhq.MTF` | `MTF` |
| Validity | `dhanhq.DAY` | `DAY` |
| | `dhanhq.IOC` | `IOC` |

## Current SDK Methods To Prefer

| Task | Method |
|------|--------|
| Place order | `dhan.place_order()` |
| Slice large order | `dhan.place_slice_order()` |
| Modify order | `dhan.modify_order()` |
| Cancel order | `dhan.cancel_order()` |
| Order book | `dhan.get_order_list()` |
| Order by ID | `dhan.get_order_by_id()` |
| Order by correlation ID | `dhan.get_order_by_correlationID()` |
| Trade book | `dhan.get_trade_book()` |
| Trade history | `dhan.get_trade_history()` |
| Ledger | `dhan.ledger_report()` |
| Super orders | `place_super_order()`, `modify_super_order()`, `cancel_super_order()`, `get_super_order_list()` |
| Forever orders | `place_forever()`, `modify_forever()`, `cancel_forever()`, `get_forever()` |
| Holdings | `dhan.get_holdings()` |
| Positions | `dhan.get_positions()` |
| Convert position | `dhan.convert_position()` |
| eDIS | `dhan.generate_tpin()`, `dhan.open_browser_for_tpin()`, `dhan.edis_inquiry()` |
| Fund limits | `dhan.get_fund_limits()` |
| Margin calculator | `dhan.margin_calculator()` |
| Daily history | `dhan.historical_daily_data()` |
| Minute history | `dhan.intraday_minute_data()` |
| Expired options data | `dhan.expired_options_data()` |
| Market quote snapshot | `dhan.ticker_data()`, `dhan.ohlc_data()`, `dhan.quote_data()` |
| Expiry list | `dhan.expiry_list()` |
| Option chain | `dhan.option_chain()` |
| Security master | `dhanhq.fetch_security_list()` |
| Live market feed | `MarketFeed` |
| Live order updates | `OrderUpdate` |
| Full market depth | `FullDepth` |
| Kill switch | `dhan.kill_switch()`, `dhan.status_kill_switch()` |

## High-Value Gotchas

- The SDK wraps HTTP responses as `{"status": "success"|"failure", "remarks": ..., "data": ...}`. Response shapes vary by endpoint — success payloads differ significantly (arrays, flat objects, nested dicts) depending on the API.
- Repo helpers add a normalization layer. Fields like `ce_ltp`, `ce_oi`, `ce_iv` are repo-defined names — not raw Dhan field names.
- `intraday_minute_data(...)` is the current SDK method. Do not reference `historical_minute_data()`.
- Historical timestamps are epoch values. Convert them explicitly.
- The SDK currently validates `expiry_code` with `[0, 1, 2, 3]`, but Dhan's v2 annexure documents `0`, `1`, `2`. Prefer the documented values unless Dhan updates the API docs.
- Quote APIs are rate-limited to `1 request/sec`.
- Option-chain REST data is keyed by strike string under `data["oc"]`. Use repo helpers for analysis-friendly rows.
- Market orders via API are currently converted by Dhan into limit orders with MPP.
- Order placement APIs require static IP whitelisting.
- Trading APIs are free for Dhan users; Data APIs require an active data plan.
- Lot sizes and freeze quantities change. Treat hardcoded values as fallback only.

## Product-Type Rules

| Segment | Allowed Product Types |
|---------|-----------------------|
| `NSE_EQ`, `BSE_EQ` | `CNC`, `INTRADAY`, `MARGIN`, `MTF` |
| `NSE_FNO`, `BSE_FNO`, `MCX_COMM`, `NSE_CURRENCY`, `BSE_CURRENCY` | `INTRADAY`, `MARGIN` |

## Instrument Resolution Rules

Use the security master as the primary source for:
- `security_id`
- `lot_size`
- `tick_size`
- expiry
- strike
- derivative contract lookup

Quick-reference index underlyings:

| Underlying | security_id | Underlying Segment |
|------------|-------------|-------------------|
| NIFTY 50 | `13` | `IDX_I` |
| BANK NIFTY | `25` | `IDX_I` |
| FINNIFTY | `27` | `IDX_I` |
| MIDCPNIFTY | `442` | `IDX_I` |
| SENSEX | `51` | `IDX_I` |

## Preferred Helper Layer

When generating scripts in this repo, prefer:

- `get_client()` for SDK bootstrapping
- `resolve_symbol()` for cash-market lookup
- `resolve_derivative()` for contract lookup
- `fetch_chain_df()` for option-chain normalization
- `find_atm_row()` for ATM selection
- `check_margin()` for pre-flight margin checks
- `preview_order()` for readable confirmation

## Core Patterns

### 1. Check account access before data calls

```python
from dhanhq import DhanLogin

dhan_login = DhanLogin("YOUR_CLIENT_ID")
profile = dhan_login.user_profile("YOUR_ACCESS_TOKEN")

print(profile["dataPlan"])
print(profile["dataValidity"])
```

### 2. Fetch historical data with epoch conversion

```python
data = dhan.historical_daily_data(
    security_id="2885",
    exchange_segment=dhanhq.NSE,
    instrument_type="EQUITY",
    from_date="2024-01-01",
    to_date="2024-12-31",
)

if data["status"] == "success":
    candles = data["data"]
    timestamps = [dhan.convert_to_date_time(ts) for ts in candles["timestamp"]]
```

### 3. Normalize option-chain data for analysis

```python
from scripts.dhan_helpers import fetch_chain_df, find_atm_row

chain_df, spot = fetch_chain_df(dhan, under_security_id=13, expiry="2025-03-27")
atm = find_atm_row(chain_df, spot)

print(spot)
print(atm["strike"])
print(atm["ce_security_id"], atm["ce_ltp"])
```

### 4. Margin check before live order placement

```python
from scripts.dhan_helpers import check_margin

margin = check_margin(
    dhan,
    security_id="2885",
    exchange_segment=dhanhq.NSE,
    transaction_type=dhanhq.BUY,
    quantity=10,
    product_type=dhanhq.CNC,
    price=2450.0,
)

print(margin["sufficient"], margin["total_margin"], margin["available_balance"])
```

### 5. Live market feed

```python
from dhanhq import MarketFeed

instruments = [
    (MarketFeed.NSE, "2885", MarketFeed.Ticker),
    (MarketFeed.NSE_FNO, "49081", MarketFeed.Full),
]

feed = MarketFeed(dhan_context, instruments, "v2")
feed.run_forever()
print(feed.get_data())
```

## Rate Limits

| API Category | Per Second | Per Minute | Per Hour | Per Day |
|-------------|-----------:|-----------:|---------:|--------:|
| Order APIs | 10 | 250 | 1000 | 7000 |
| Data APIs | 5 | - | - | 100000 |
| Quote APIs | 1 | Unlimited | Unlimited | Unlimited |
| Non-Trading APIs | 20 | Unlimited | Unlimited | Unlimited |

## Reference Files

Dhan APIs cover execution, quotes, OHLC, option chain, and portfolio. For fundamental data (PE, EPS, revenue), technical indicators (RSI, MACD), or shareholding patterns not available via Dhan, use ScanX — see `references/scanx-data.md`.

| Need | File |
|------|------|
| Orders, super orders, forever orders | [references/orders.md](references/orders.md) |
| Holdings, positions, eDIS | [references/portfolio.md](references/portfolio.md) |
| Daily/minute history, quotes, expired options | [references/market-data.md](references/market-data.md) |
| Option-chain usage and normalization | [references/option-chain.md](references/option-chain.md) |
| Fund limits and margin checks | [references/funds.md](references/funds.md) |
| Live feeds and depth | [references/live-feed.md](references/live-feed.md) |
| Error handling and subscription troubleshooting | [references/error-codes.md](references/error-codes.md) |
| Instrument resolution | [references/instruments.md](references/instruments.md) |
| Multi-step execution patterns | [references/common-workflows.md](references/common-workflows.md) |
| Options analytics | [references/options-analysis-patterns.md](references/options-analysis-patterns.md) |
| Backtesting patterns | [references/backtesting-with-dhan.md](references/backtesting-with-dhan.md) |
| PE ratio, RSI, financials, screeners — data Dhan does not provide | [references/scanx-data.md](references/scanx-data.md) |

## Data API Subscription Invalid

If the user gets `DH-902` or `806`:

1. Log in to `web.dhan.co`
2. Open `My Profile` -> `Access DhanHQ APIs`
3. Verify that `dataPlan` is active
4. Activate the Data API plan if needed
5. Generate a fresh access token
6. Re-test with `ticker_data()` or `ohlc_data()`
7. If order APIs still fail, check static IP separately
