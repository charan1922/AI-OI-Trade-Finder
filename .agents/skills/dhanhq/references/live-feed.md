# Live Feed — Complete Reference

SDK classes: `MarketFeed`, `OrderUpdate`, `FullDepth`.

## MarketFeed

Current SDK signature:

```python
MarketFeed(
    dhan_context,
    instruments,
    version="v2",
    on_connect=None,
    on_message=None,
    on_close=None,
    on_error=None,
    on_ticks=None,
)
```

Example:

```python
from dhanhq import DhanContext, MarketFeed

dhan_context = DhanContext("client_id", "access_token")
instruments = [
    (MarketFeed.NSE, "2885", MarketFeed.Ticker),
    (MarketFeed.NSE, "1333", MarketFeed.Quote),
    (MarketFeed.NSE_FNO, "49081", MarketFeed.Full),
]

def on_message(instance, message):
    print(message)

feed = MarketFeed(
    dhan_context,
    instruments,
    version="v2",
    on_message=on_message,
)
feed.run_forever()
```

### Current SDK Constants

Exchange constants:
- `MarketFeed.IDX = 0`
- `MarketFeed.NSE = 1`
- `MarketFeed.NSE_FNO = 2`
- `MarketFeed.NSE_CURR = 3`
- `MarketFeed.BSE = 4`
- `MarketFeed.MCX = 5`
- `MarketFeed.BSE_CURR = 7`
- `MarketFeed.BSE_FNO = 8`

Subscription constants:
- `MarketFeed.Ticker = 15`
- `MarketFeed.Quote = 17`
- `MarketFeed.Depth = 19`
- `MarketFeed.Full = 21`

Use `version="v2"` when you need full packet mode.

### Connection Limits

From the current v2 API docs:
- up to 5 concurrent websockets per user
- up to 5000 instruments per connection
- up to 100 instruments per subscription message

SDK helper methods:

```python
feed.subscribe_symbols(symbols)
feed.unsubscribe_symbols(symbols)
feed.close_connection()
feed.disconnect()
```

### Parsed Packet Shapes From The Installed SDK

Representative `Ticker` packet:

```python
{
    "type": "Ticker Data",
    "exchange_segment": 1,
    "security_id": 2885,
    "LTP": "2450.00",
    "LTT": "2025-01-15 10:30:00+00:00"
}
```

Representative `Quote` packet:

```python
{
    "type": "Quote Data",
    "exchange_segment": 1,
    "security_id": 2885,
    "LTP": "2450.00",
    "LTQ": 10,
    "LTT": "...",
    "avg_price": "2445.50",
    "volume": 1234567,
    "total_sell_quantity": 450000,
    "total_buy_quantity": 500000,
    "open": "2430.00",
    "close": "2440.00",
    "high": "2465.00",
    "low": "2425.00"
}
```

Representative `Full` packet:

```python
{
    "type": "Full Data",
    "exchange_segment": 2,
    "security_id": 49081,
    "LTP": "368.15",
    "LTQ": 50,
    "LTT": "...",
    "avg_price": "365.00",
    "volume": 10000,
    "total_sell_quantity": 2500,
    "total_buy_quantity": 3000,
    "OI": 1250000,
    "oi_day_high": 1265000,
    "oi_day_low": 1210000,
    "open": "360.00",
    "close": "355.00",
    "high": "372.00",
    "low": "352.00",
    "depth": [
        {
            "bid_quantity": 100,
            "ask_quantity": 75,
            "bid_orders": 2,
            "ask_orders": 1,
            "bid_price": "368.10",
            "ask_price": "368.20"
        }
    ]
}
```

## OrderUpdate

Current SDK signature:

```python
OrderUpdate(dhan_context)
```

Minimal usage:

```python
from dhanhq import OrderUpdate

order_client = OrderUpdate(dhan_context)

def on_order_update(order_data):
    print(order_data)

order_client.on_update = on_order_update
order_client.connect_to_dhan_websocket_sync()
```

Use this for:
- live order-status monitoring
- fill confirmations
- multi-leg execution monitoring

## FullDepth

Current SDK signature:

```python
FullDepth(dhan_context, instruments, depth_level=20)
```

Example:

```python
from dhanhq import FullDepth

depth = FullDepth(
    dhan_context,
    instruments=[(FullDepth.NSE, "2885")],
    depth_level=20,
)
depth.run_forever()
print(depth.get_data())
```

Current SDK constants:
- `FullDepth.NSE = 1`
- `FullDepth.NSE_FNO = 2`

Current API limits:
- 20-level depth: up to 50 instruments per connection
- 200-level depth: 1 instrument per connection
- only `NSE_EQ` and `NSE_FNO` are supported for full depth

SDK methods:

```python
depth.subscribe_symbols(symbols)
depth.unsubscribe_symbols(symbols)
depth.close_connection()
depth.disconnect()
```

### Parsed Depth Output

`FullDepth` receives bid and ask packets separately and the SDK formats them into a combined representation. Treat the output as SDK-parsed depth data, not raw binary packet layout.

## When To Use What

- Use `ticker_data()`, `ohlc_data()`, or `quote_data()` for snapshots.
- Use `MarketFeed` for live monitoring of LTP, quote, or full packets.
- Use `OrderUpdate` for execution tracking.
- Use `FullDepth` only when you genuinely need deeper order-book visibility because it is heavier and more restrictive than regular live market feed usage.
