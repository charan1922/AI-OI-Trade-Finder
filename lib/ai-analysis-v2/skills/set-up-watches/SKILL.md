---
name: set-up-watches
description: Use when the operator asks you to keep an eye on something, says "tell me when", or a new position has opened.
---

# Set up watches

1. `list_watches` → never duplicate one that exists.
2. `read_data` source `auto_trade_today` → open positions.
3. For each open position, unless it exists: `start_watch` near_stop (0.3%) and position_r 1.
4. For anything the operator named: the matching typed watch. If no kind fits (an indicator, a news event), say it
   needs a code change. Never fake a watch.
5. Report exactly what you started and how often it is checked: every 60 s, prices move with 5-min candles.
