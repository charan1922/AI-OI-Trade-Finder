# Lesson 02 — The Words You Need

Every term the rest of the course uses, in plain words. Skim it now, come back
whenever a word trips you.

## Options basics

**Option** — a contract that lets you profit from a stock's move without buying
the stock itself. You pay a small price (the *premium*) for the contract. If
the stock moves your way, the premium grows and you sell the contract for more
than you paid. If it moves against you, the premium shrinks.

**CE (Call option)** — the contract you buy when you expect the stock to go **UP**.

**PE (Put option)** — the contract you buy when you expect the stock to go **DOWN**.
Yes — with a PE you *make money when the stock falls*.

**Strike** — the reference price written into the contract. "HYUNDAI 2040 CE"
means a call option on HYUNDAI with strike 2040. The app picks strikes close to
the current stock price, because those respond fastest to the stock's moves.

**Premium** — the price of the option contract itself, per share. This is the
number that goes up and down all day, and it's what we actually buy and sell.

**Lot / lot size** — options are not sold one share at a time; they come in a
fixed bundle called a lot. HYUNDAI's lot size is 275, so one lot of a ₹59.50
premium costs 59.50 × 275 = **₹16,362**. This app always trades exactly **1 lot**.

**Expiry** — the date the contract stops existing. The app only trades
contracts with at least a few days of life left, so they don't decay too fast.

**Spot** — the actual current price of the stock itself (as opposed to the
option's premium). "Spot 2040.9" = the stock trades at ₹2040.90 right now.

## Trade management words

**Entry** — buying the option to open the trade.

**Exit** — selling it to close the trade. Profit = (exit premium − entry
premium) × lot size.

**Stop-loss (SL)** — a "get out" line. If the trade goes against us and the
price crosses this line, we exit immediately and accept a small loss rather
than risk a big one. Every trade here has TWO stop lines: one on the stock's
price (spot SL) and one on the option's premium (premium SL). Whichever is hit
first wins.

**Target** — the "take the win" line, same idea in the profit direction.

**Square-off** — force-closing a position. At 15:12 every open trade is
squared off, so nothing is ever held overnight.

**Slippage** — the small difference between the price you saw when deciding
and the price you actually got. The app rejects an entry if the premium moved
more than 4% since the scanner quoted it.

**Bid-ask spread** — the gap between the best buying and selling price. A wide
gap means few people are trading that contract, and getting in/out is
expensive. The app rejects contracts with a wide spread.

## Market-activity words (what the scanner reads)

**Volume** — how many shares/contracts changed hands. High volume = lots of
interest today.

**OI (Open Interest)** — how many option/futures contracts are currently held
open. This is the scanner's favorite clue: when OI *grows*, new money is
entering positions. When large OI builds up quietly in one stock, someone big
may know (or expect) something.

**Futures** — a cousin of options: a contract to buy/sell the stock at a set
date. Big institutions build positions in futures, so futures OI growth is a
strong participation clue.

**20-day average** — the app compares today's numbers to the stock's own
last-20-days norm. "Futures OI 1.35× the 20-day average" means 35% more open
contracts than normal for that stock — that's unusual, and unusual is
interesting.

**R-Factor** — this app's home-grown 1-to-8 score of *how unusual* a stock's
activity is today (built from OI, volumes, and price-range data). Higher =
more unusual. Important: R-Factor measures **participation, not direction or
timing** — a high score says "big money is here", not "buy now". The scanner's
other checks decide direction and timing.

**Breakout** — when a stock's price pushes past the range it traded in during
the opening minutes. A *confirmed* breakout suggests the move has real force.

**VWAP** — the day's average trade price weighted by volume. Price above VWAP
all day = buyers in control (roughly).

**Supertrend** — a simple trend indicator drawn from recent candles; used as a
second opinion on direction.

**Candle (5-minute)** — a summary of 5 minutes of trading: the open, highest,
lowest, and closing price of that little window. The data engine stores the
whole day as 5-minute candles.

## App words

**Paper trade** — a fully simulated trade: real market prices, real rules, no
real money. The app is running in paper mode while the strategy is proven.

**Scanner / picks** — the rule-based screen (Lesson 04) and the shortlist it
produces each cycle.

**Position guard** — the deterministic (non-AI) watchdog that checks every open
trade each cycle against its stop/target/square-off lines. Works even if the
AI is down.

**Kill switch** — one setting that instantly stops all new orders.

---

**Next:** [Lesson 03 — The Data Engine](03-the-data-engine.md) — where all these
numbers actually come from.
