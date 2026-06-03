# Backtesting With Dhan Data

## Daily Equity Backtest Skeleton

```python
import pandas as pd

response = dhan.historical_daily_data(
    security_id="2885",
    exchange_segment=dhanhq.NSE,
    instrument_type="EQUITY",
    from_date="2023-01-01",
    to_date="2024-12-31",
)

if response["status"] == "success":
    data = response["data"]
    df = pd.DataFrame(data)
    df["timestamp"] = pd.to_datetime(df["timestamp"], unit="s", utc=True).dt.tz_convert("Asia/Kolkata")
    df.set_index("timestamp", inplace=True)
```

Typical next steps:
- create signals
- shift positions to avoid look-ahead bias
- apply transaction costs
- compute CAGR / drawdown / Sharpe / win rate

## Minute-Level Backtest Skeleton

```python
response = dhan.intraday_minute_data(
    security_id="2885",
    exchange_segment=dhanhq.NSE,
    instrument_type="EQUITY",
    from_date="2024-09-11 09:30:00",
    to_date="2024-09-15 13:00:00",
    interval=5,
    oi=False,
)

if response["status"] == "success":
    minute_data = response["data"]
```

Practical note:
- current v2 API docs describe minute data for active instruments over up to last 5 years

## Expired Options Backtest Skeleton

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
```

Current raw output shape:
- arrays live under `response["data"]["ce"]` or `response["data"]["pe"]`
- timestamps are epoch integers

## Cost Model Reminders

At minimum consider:
- brokerage
- STT
- transaction charges
- GST
- stamp duty
- SEBI charges
- slippage

Use a single cost function and keep it explicit in the notebook/script.

## Guidance

- Do not assume timestamps are ISO strings.
- Do not mix raw option-chain parsing with expired-options data shapes.
- For derivative strategies, separate:
  - live contract discovery
  - historical rolling data analysis
- Paper trade before live deployment.
