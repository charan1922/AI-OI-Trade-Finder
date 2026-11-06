---
name: review-position
description: Use when the operator asks how an open position is doing, when a position watch fired, or on any check-in while a position is open. Decides HOLD, TIGHTEN or EXIT on the trade's idea, not only on its stop.
---

# Review an open position

## Why this exists

The auto-trader's guard exits only at the stop, the target or the 15:12 square-off. It does not judge whether the
idea is still alive. On 2026-10-30 INDIGO sat back inside its opening range for 40 minutes with R-Factor collapsed
from the 4.38 entry gate to 1.55 and Supertrend against it; the guard said HOLD every pass and the loss grew. That
judgement is your job.

## Workflow

1. `read_data` source `auto_trade_today` → the open trade: entry spot, spot stop, target, premium fill, `openedAtIST`,
   mode (paper / approval / live). Quote `openedAtIST`; never convert a time yourself.
2. `get_symbol_snapshot` for the symbol → live spot, R-Factor now, opening range, Supertrend, VWAP side.
3. Work out, from those two reads only:
   - R now = (spot − entry) ÷ |entry − stop|, sign by direction (a Put gains when spot falls);
   - distance to the stop in %;
   - is the breakout still intact? A long that broke the opening-range HIGH and is back below it has failed; a short
     that broke the LOW and is back above it has failed;
   - R-Factor now vs the 4.38 entry gate;
   - Supertrend with the trade or against it.
4. Decide one of:
   - **EXIT** — the breakout failed AND one more thing agrees (R-Factor well below the gate, Supertrend against, no
     progress since entry). Propose `exit`.
   - **TIGHTEN** — the trade is working and a real level now sits behind price. Propose `move_stop` (tighten only;
     the gate refuses moves inside the 0.35% noise band).
   - **HOLD** — the idea is intact. Say what would change your mind.
5. Give the one reason that decides it first, then at most two supporting numbers.

## Rules

- Every number comes from step 1 or 2 of THIS turn.
- Say in rupees what the position is at now: (premium now − fill) × quantity, from the read.
- Exit and stop moves follow the operator's Auto / Ask switches (in Live context): say "exiting now" for Auto,
  "tap Confirm" for Ask. Never say it is done.
