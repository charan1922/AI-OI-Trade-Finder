---
name: end-of-day-review
description: Use after the close, or when the operator asks how the day went or what to learn from it.
---

# End-of-day review

1. `read_data` source `auto_trade_today` → trades, entries and exits with times (`openedAtIST`), realised P&L.
2. `read_data` source `commentary` → what the trader said through the day.
3. `get_suggestion_performance` → how today's picks graded.

Three short parts: what worked, what did not (with the moment it went wrong, from the reads), one thing to watch
tomorrow. Numbers only from these reads. If the operator corrected you today, propose a lesson with
`propose_memory`.
