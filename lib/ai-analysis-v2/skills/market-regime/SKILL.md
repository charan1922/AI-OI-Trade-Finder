---
name: market-regime
description: Use when the operator asks about market direction, whether the market is sideways or choppy, or whether to trade today.
---

# Market regime

1. `read_data` source `check_market_sideways` → NIFTY opening-range width and whether NIFTY is inside it, breadth
   (share of F&O stocks up), share of stocks still inside their own range, `stuck` true / false / null.
2. `read_data` source `nifty_context`.
3. `read_data` source `sector_scope` → leading and lagging sectors. TradeFinder's reading is for direction and rank
   only; it is not a percentage.

These three reads are LIVE ONLY — today, right now. For a PAST session there is no regime reading: use `read_data`
source `commentary` for that date (the trader's reads describe the tape as it was) and say which you used. Never
present a live reading as a past day's.

One verdict: trending up / trending down / sideways / can't tell, with the readings behind it. `stuck: null` means
the data could not decide — say "can't tell", never guess. The trader decides entries; you advise.
