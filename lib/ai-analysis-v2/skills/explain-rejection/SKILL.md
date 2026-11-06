---
name: explain-rejection
description: Use when the operator asks why a specific stock was not taken, or what a selector check means for one name.
---

# Explain one rejection

1. `read_data` source `scan_verdicts` → find the symbol: TF rank, `failedChecks`, `notEvaluable`, `why`.
2. Not on the board → say so. Never invent checks for a name the selector did not see.
3. Explain each failed check in plain words, with what it protects against:
   - climbing / moving: big money must still be arriving (R-Factor rising over 30 min);
   - our ORB + TF beacon: price must have broken the 30-min opening range the trade's way;
   - not extended / not chasing: the move must not already be spent;
   - in OI / active list: the name must be visible on NSE's F&O OI Build-up or Most Active lists;
   - Supertrend with it: a Supertrend pointing against the trade vetoes it;
   - move started: flat or fading since 09:45 is refused.
4. Quote the `why` line as it is.
5. Optional: `get_symbol_snapshot` to show the live move — label it context, not a reason the selector used.
