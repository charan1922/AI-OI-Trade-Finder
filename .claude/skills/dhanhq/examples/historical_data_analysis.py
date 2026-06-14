"""Fetch historical OHLCV data from DhanHQ and perform basic analysis."""

from datetime import datetime, timedelta

import pandas as pd

from scripts.dhan_helpers import get_client

dhan, _ = get_client()

to_date = datetime.now().strftime("%Y-%m-%d")
from_date = (datetime.now() - timedelta(days=180)).strftime("%Y-%m-%d")

response = dhan.historical_daily_data(
    security_id="2885",
    exchange_segment="NSE_EQ",
    instrument_type="EQUITY",
    from_date=from_date,
    to_date=to_date,
)

if response["status"] != "success":
    raise SystemExit(response["remarks"])

df = pd.DataFrame(response["data"])
df["timestamp"] = pd.to_datetime(df["timestamp"], unit="s", utc=True).dt.tz_convert("Asia/Kolkata")
df.set_index("timestamp", inplace=True)

df["SMA_20"] = df["close"].rolling(20).mean()
df["SMA_50"] = df["close"].rolling(50).mean()
df["returns"] = df["close"].pct_change()

print("=== RELIANCE — Last 6 Months ===\n")
print(f"Period:         {df.index[0].date()} to {df.index[-1].date()}")
print(f"Trading Days:   {len(df)}")
print(f"Start Price:    Rs. {df['close'].iloc[0]:,.2f}")
print(f"End Price:      Rs. {df['close'].iloc[-1]:,.2f}")
print(f"High:           Rs. {df['high'].max():,.2f}")
print(f"Low:            Rs. {df['low'].min():,.2f}")
print(f"Total Return:   {(df['close'].iloc[-1] / df['close'].iloc[0] - 1):.2%}")
print(f"Avg Daily Vol:  {df['volume'].mean():,.0f}")
print(f"Volatility:     {df['returns'].std() * (252 ** 0.5):.2%} (annualized)")

latest = df.iloc[-1]
print(f"\nSMA 20:         Rs. {latest['SMA_20']:,.2f}")
print(f"SMA 50:         Rs. {latest['SMA_50']:,.2f}")
print("Signal:         Bullish (SMA 20 > SMA 50)" if latest["SMA_20"] > latest["SMA_50"] else "Signal:         Bearish (SMA 20 < SMA 50)")
