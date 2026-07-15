# Lesson 06 — How a Trade Happens

The best way to understand the machine is to watch it work. Everything below
is a **real recorded day — 15 July 2026** (paper mode: simulated fills at real
market prices). Settings that day: max 3 trades, ₹25,000 capital cap, ₹2,500
daily-loss halt, entries 09:45–11:00.

## The lifecycle, in general

```text
scanner pick → AI proposes entry → GATES verify → order placed → fill recorded
     → every 5 min: position guard checks stop/target/square-off
     → exit (stop, target, AI decision, or 15:12) → P&L booked → scorecard
```

## 09:48 — Trade 1: HYUNDAI 2040 CE (a controlled loss)

The scanner had surfaced HYUNDAI (bullish): R-Factor 4.13, options OI up 41%,
breakout confirmed. The AI proposed entry; the gates verified: window open ✓,
0 trades so far ✓, cost ₹16,362 under the ₹25,000 cap ✓, premium moved only
2.67% since the scan quote (under the 4% slippage cap) ✓. **Filled at ₹59.50.**

The plan: spot stop 2020, spot target 2082.7, premium stop ₹54.05.

It went wrong quickly — the stock drifted down. At **10:03** the position
guard saw the premium at ₹52.55, below the ₹54.05 premium stop, and exited
immediately. **Loss: −₹1,911.**

*Why this was good behavior:* the stock kept falling all day (closed at 2004).
The slower spot stop wouldn't have triggered until 12:40, at a bigger loss.
The premium stop is the tighter rupee-based guard — it did its job.

## 10:09 — Trade 2: MANKIND 2600 CE (a win, with stop management)

Scanner pick (bullish), cost ₹18,050 — fits the cap now that HYUNDAI is
closed. **Filled at ₹72.20.** Plan: spot stop 2585.6, spot target 2614.1.

At 10:40, with the stock up near 2611, the AI called "MOVE SL to 2608" —
locking most of the gain. The gate for stop moves checked: 2608 is HIGHER than
the old stop (tighter for a bullish trade) ✓ — allowed. (A move DOWN would
have been refused.)

At **10:50** the guard confirmed spot 2625.5, past the 2614.1 target → exited
at ₹88.15. **Profit: +₹3,988.**

## 10:21 — the trade that DIDN'T happen (gates earning their keep)

While MANKIND was open, the scanner surfaced PATANJALI (bearish, ₹19,081 per
lot). The AI wanted it. The capital gate said: ₹18,050 already deployed +
₹19,081 = ₹37,131 > ₹25,000 → **blocked**. The AI noted "capital locked" in
its commentary and waited.

## 11:00 — Trade 3: PATANJALI 355 PE (patience pays)

MANKIND closed at 10:50, freeing the capital. At 11:00 — the last minute of
the window — PATANJALI still passed every gate, now as a *fresher* plan (the
stock had fallen further, so a new strike and deeper target). **Filled at
₹21.35**, cost ₹22,951.

The stock kept sliding. At 11:23 the AI locked the stop at breakeven (again:
tightening — allowed). At **11:28** the premium hit its ₹26 target → exited at
₹27.40. **Profit: +₹6,504.**

*A replay later proved the block at 10:21 was lucky-good: the early plan's
target would have paid about +₹5,000, and the no-re-entry rule would then have
forbidden the 11:00 trade that made +₹6,504.*

## The day's ledger

| Time | Trade | Result | Running total |
| --- | --- | --- | --- |
| 10:03 | HYUNDAI CE — premium stop | −₹1,911 | −₹1,911 |
| 10:50 | MANKIND CE — spot target | +₹3,988 | +₹2,077 |
| 11:28 | PATANJALI PE — premium target | +₹6,504 | **+₹8,581** |

Three trades (the daily max), never more than ₹22,951 deployed at once, the
running loss never near the −₹2,500 halt, everything closed hours before
square-off. After 11:00 the AI's commentary switched to "entries maxed at 3/3 —
managing only", and after 11:28 there was nothing left to manage.

## What to notice

- **Every entry passed through the gates**, and one attempted entry was
  blocked — the block turned out to be the most profitable "decision" of the day.
- **Exits were mechanical.** All three exits were fired by the position guard
  hitting a pre-planned line, not by anyone's mood.
- **Losses are small by design.** The one loss (−₹1,911) was capped by a stop
  decided *before* entry, when nobody was emotional.

## Under the hood — the code and the maths

### The methods

| Step in the story | Method (file) | What it does |
| --- | --- | --- |
| Placing the entry | `placeEntryOrder()` in `lib/auto-trade/execution.ts` | Re-runs the gates, writes the trade + order rows to the database FIRST, then sends via the broker adapter |
| Re-anchoring the rupee lines | `backstopsFromFill()` (same file) | Once the real fill price is known, recomputes the premium stop/target from it (maths below) |
| Getting out | `exitTrade()` (same file) | Sends the sell order to the venue the trade opened on, records the fill and the reason |
| The watchdog | `runPositionGuard()` in `lib/auto-trade/risk/position-guard.ts` | Every cycle: checks each open trade against premium stop/target, spot stop/target, and the 15:12 square-off — exits the moment one is crossed |
| Crash recovery | `reconcileUnresolvedOrders()` in `execution.ts` | On restart, any order the app sent but never heard back about is checked against the broker |

### The maths — re-anchored stops (watch it match the real day)

The scanner's premium lines were computed from the *scan* quote. The actual
fill can differ slightly, so the lines are recomputed from the fill:

```text
premium stop   = the TIGHTER of:  fill × 0.60   and   fill − 1500 ÷ lotSize
premium target = fill + 5000 ÷ lotSize
```

HYUNDAI on 15 Jul: fill ₹59.50, lot size 275.

```text
stop = 59.50 − 1500 ÷ 275 = 59.50 − 5.45 = ₹54.05
```

₹54.05 is *exactly* the stop that fired at 10:03 ("premium stop hit
₹52.55 ≤ ₹54.05"). The formula on this page is the formula that took the loss.

### The maths — profit and loss

```text
P&L = (exit premium − entry premium) × lot size × lots
```

All three real trades, checked:

| Trade | Calculation | Result |
| --- | --- | --- |
| HYUNDAI CE | (52.55 − 59.50) × 275 × 1 | −₹1,911 ✓ |
| MANKIND CE | (88.15 − 72.20) × 250 × 1 | +₹3,988 ✓ |
| PATANJALI PE | (27.40 − 21.35) × 1075 × 1 | +₹6,504 ✓ |

(₹6,503.75 rounds to ₹6,504 — the app rounds booked P&L to the rupee.)

### Why "database first, broker second" matters

`placeEntryOrder()` writes its record *before* sending the order. If the app
crashed mid-send, restart finds a row saying "I may have sent this" and
`reconcileUnresolvedOrders()` asks the broker for the truth. The reverse order
(send first, record after) could leave a real position the app doesn't know
it owns — the one kind of surprise this design refuses to allow.

---

**Next:** [Lesson 07 — The Safety Rules](07-the-safety-rules.md) — the complete
list of gates that made this day behave.
