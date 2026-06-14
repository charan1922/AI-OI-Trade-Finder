# Market Data — Complete Reference

Historical timestamps are epoch integers inside `response["data"]["timestamp"]` — always convert explicitly.

## Historical Daily Data

SDK signature:

```python
dhan.historical_daily_data(
    security_id,
    exchange_segment,
    instrument_type,
    from_date,
    to_date,
    expiry_code=0,
    oi=False,
)
```

Example:

```python
response = dhan.historical_daily_data(
    security_id="2885",
    exchange_segment=dhanhq.NSE,
    instrument_type="EQUITY",
    from_date="2024-01-01",
    to_date="2024-12-31",
    expiry_code=0,
    oi=False,
)

if response["status"] == "success":
    candles = response["data"]
    timestamps = [dhan.convert_to_date_time(ts) for ts in candles["timestamp"]]
```

Raw API payload fields:
- `securityId`
- `exchangeSegment`
- `instrument`
- `expiryCode`
- `oi`
- `fromDate`
- `toDate`

Documented instrument values from the v2 annexure:
- `INDEX`
- `FUTIDX`
- `OPTIDX`
- `EQUITY`
- `FUTSTK`
- `OPTSTK`
- `FUTCOM`
- `OPTFUT`
- `FUTCUR`
- `OPTCUR`

Response data fields:
- `open`
- `high`
- `low`
- `close`
- `volume`
- `timestamp`
- `open_interest` when `oi=True`

Important:
- The raw API docs currently document `expiryCode` values `0`, `1`, `2`.
- The installed SDK validation still accepts `3`.
- Prefer the documented values unless Dhan updates the API docs.

## Intraday Minute Data

SDK signature:

```python
dhan.intraday_minute_data(
    security_id,
    exchange_segment,
    instrument_type,
    from_date,
    to_date,
    interval=1,
    oi=False,
)
```

Example:

```python
response = dhan.intraday_minute_data(
    security_id="2885",
    exchange_segment=dhanhq.NSE,
    instrument_type="EQUITY",
    from_date="2024-09-11 09:30:00",
    to_date="2024-09-15 13:00:00",
    interval=1,
    oi=False,
)

if response["status"] == "success":
    minute_data = response["data"]
    minute_times = [dhan.convert_to_date_time(ts) for ts in minute_data["timestamp"]]
```

Current API truth:
- Intraday data is ranged minute data, not "today only".
- The v2 historical-data page documents last 5 years for active instruments.
- The installed SDK docstring still says "last 5 trading day". Prefer the current v2 API docs when planning data windows.

Supported intervals:
- `1`
- `5`
- `15`
- `25`
- `60`

## Market Quote Snapshots

SDK methods:

```python
dhan.ticker_data(securities)
dhan.ohlc_data(securities)
dhan.quote_data(securities)
```

Request format:

```python
securities = {
    "NSE_EQ": [2885, 1333],
    "NSE_FNO": [49081],
}
```

### Ticker Data

```python
response = dhan.ticker_data({"NSE_EQ": [2885]})

if response["status"] == "success":
    ltp = response["data"]["NSE_EQ"]["2885"]["last_price"]
```

### OHLC Data

```python
response = dhan.ohlc_data({"NSE_EQ": [2885]})

if response["status"] == "success":
    ohlc = response["data"]["NSE_EQ"]["2885"]["ohlc"]
```

### Quote Data

```python
response = dhan.quote_data({"NSE_FNO": [49081]})

if response["status"] == "success":
    quote = response["data"]["NSE_FNO"]["49081"]
    print(quote["last_price"], quote["oi"], quote["volume"])
```

Current raw fields exposed by the v2 quote endpoint include:
- `last_price`
- `average_price`
- `buy_quantity`
- `sell_quantity`
- `depth.buy[]`
- `depth.sell[]`
- `last_quantity`
- `last_trade_time`
- `lower_circuit_limit`
- `upper_circuit_limit`
- `net_change`
- `volume`
- `oi`
- `oi_day_high`
- `oi_day_low`
- `ohlc.open`
- `ohlc.close`
- `ohlc.high`
- `ohlc.low`

Quote API limits:
- up to 1000 instruments per request
- `1 request/sec`

## Expired Options Data

SDK signature:

```python
dhan.expired_options_data(
    security_id,
    exchange_segment,
    instrument_type,
    expiry_flag,
    expiry_code,
    strike,
    drv_option_type,
    required_data,
    from_date,
    to_date,
    interval=1,
)
```

Example:

```python
response = dhan.expired_options_data(
    security_id=13,
    exchange_segment=dhanhq.NSE_FNO,
    instrument_type="OPTIDX",
    expiry_flag="MONTH",
    expiry_code=1,
    strike="ATM",
    drv_option_type="CALL",
    required_data=["open", "high", "low", "close", "volume", "oi", "spot"],
    from_date="2021-08-01",
    to_date="2021-08-31",
    interval=1,
)

if response["status"] == "success":
    ce = response["data"]["ce"]
    timestamps = [dhan.convert_to_date_time(ts) for ts in ce["timestamp"]]
```

Current v2 API notes:
- rolling expired options data is available for up to last 5 years
- fetch up to 30 days per call
- `strike` supports `ATM`, `ATM+N`, `ATM-N`
- near-expiry index options go up to `ATM+10 / ATM-10`
- other contracts go up to `ATM+3 / ATM-3`

Allowed `required_data` values:
- `open`
- `high`
- `low`
- `close`
- `iv`
- `volume`
- `strike`
- `oi`
- `spot`

## Timestamp Conversion

Prefer explicit conversion instead of assuming ISO strings:

```python
timestamps = [dhan.convert_to_date_time(ts) for ts in response["data"]["timestamp"]]
```

Or with pandas:

```python
df["timestamp"] = pd.to_datetime(df["timestamp"], unit="s", utc=True).dt.tz_convert("Asia/Kolkata")
```

## Practical Guidance

- Use historical APIs for candles and backtests.
- Use quote APIs for point-in-time snapshots.
- Use `MarketFeed` for live monitoring instead of polling quote endpoints aggressively.
- Use the security master to validate derivative instrument type, expiry, and lot size before mixing historical data with live execution.
