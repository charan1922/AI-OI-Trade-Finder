# Lesson 01 — The Big Picture

## What is this system?

This app trades **stock options** on the Indian market (NSE) with a small,
fixed amount of money, in a tightly controlled morning window. It has three
main parts working together:

1. **The Data Engine** — a background loop that wakes up every 5 minutes and
   collects fresh prices and activity data for about 50 large stocks.
2. **The Scanner** — a set of fixed rules (no AI) that reads that data and
   shortlists stocks where "big money" seems to be quietly building a position.
3. **The AI layer** — an AI that looks at the shortlist, decides whether to
   actually trade, manages any open trade, and writes a short plain-English
   note ("commentary") about what it sees.

Around them sits a wall of **safety rules written in code** — entry times,
money caps, loss limits — that check every single action. The AI cannot talk
its way past them.

## One day in the system's life

All times are Indian Standard Time (IST).

| Time | What happens |
| --- | --- |
| 08:40–09:15 | The app quietly logs itself into both brokers (Fyers and Dhan) so tokens are ready before the market opens. No human needed. |
| 09:15 | Market opens. The 5-minute data loop starts recording prices and activity. |
| 09:40 | The scanner starts running every 5 minutes, looking for unusual activity. |
| 09:45–11:00 | **The entry window.** This is the ONLY time new trades may be opened. The AI reviews the scanner's picks each cycle and may open a trade (max 3 per day). |
| 11:00 onwards | No new trades. The system only *manages* whatever is open — moving stops, taking profits, cutting losses. |
| 15:12 | **Forced square-off.** Anything still open is closed, no exceptions. |
| 15:30 | Market closes. Data recording stops. |
| After 16:00 | The **end-of-day scorecard** runs automatically: it grades every pick the scanner made today (did it hit its target? its stop?) and stores the report card. |

## Why only 09:45–11:00 for new trades?

The first 30 minutes of the market are noisy — prices jump around while
overnight orders settle. By 09:45 the picture is clearer, but the day's real
moves usually start in the morning. Trading only in this window means:
entries are made when signals are freshest, and there's a whole day left for
the trade to work — with a hard 15:12 exit so nothing is ever held overnight.

## The chain of command

```text
Data Engine  →  Scanner  →  AI  →  Safety Gates  →  Broker
 (collects)    (shortlists)  (decides)  (verifies)     (executes)
```

Every arrow is a checkpoint. A stock must pass the scanner's rules to reach
the AI. The AI's decision must pass the safety gates to become an order. Only
then does anything reach a broker.

## What the AI can and cannot do

| The AI CAN | The AI CANNOT |
| --- | --- |
| Choose to trade one of the scanner's picks, or skip all of them | Invent its own stock, strike, or position size |
| Exit a trade early if the story changes | Hold past the 15:12 square-off |
| Move a stop-loss to lock in profit | Move a stop-loss to allow MORE loss (stops may only tighten) |
| Write the commentary explaining its thinking | Bypass any money or time limit |

---

**Next:** [Lesson 02 — The Words You Need](02-the-words-you-need.md), where every
trading term used above (options, stops, lots…) gets a simple definition.
