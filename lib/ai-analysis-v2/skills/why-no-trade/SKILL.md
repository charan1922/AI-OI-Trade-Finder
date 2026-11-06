---
name: why-no-trade
description: Use when the operator asks why nothing was traded, why there are no picks, or why the trader is idle.
---

# Why no trade

0. A past session ("yesterday", "last session"): read `read_data` source `auto_trade_history` with NO date ONCE — it
   lists the dates that have data. Take the latest one and read that date. Never probe dates one by one.
1. `read_data` source `auto_trade_today` → mode, kill switch, entries used vs the cap, daily-loss halt (realised P&L
   vs the halt), the effective entry window.
2. `read_data` source `scan_verdicts` → is the TF board fresh (`boardAtIST`, `stale`)? How many names PICKED vs
   REJECTED? Which check fails most?
3. Only if it can matter, and only for TODAY: `read_data` source `check_market_sideways` (live only — never present it
   as a past session's).

Answer with the ONE binding reason first, in plain words ("the entry window closed at 10:59", "no TradeFinder board
was captured today", "every name failed 'not chasing'"), then at most two supporting facts.

- A halt: compare exactly. ₹3,968 lost is OVER a ₹3,000 halt.
- No board is a data problem, not a market signal. Say you cannot see why the capture stopped.
