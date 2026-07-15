# Lesson 09 — Record-Keeping and Review

A system you can't audit is a system you can't trust. This lesson covers what
gets written down (everything) and how the app grades itself.

## Every layer leaves a paper trail

| Table | What it records |
| --- | --- |
| `fyers_candles` | Every 5-minute candle for ~50 stocks, last 20 sessions — the raw material for replays |
| `oi_intraday` / `rank_snapshots` | OI readings and activity-leaderboard ranks, every 5 minutes |
| `trade_suggestions` | Every scanner pick ever made: the full plan, ALL its reasons, and how many cycles it stayed valid |
| `auto_decisions` | Every AI pass: what it said, which model, how many tokens — including the passes where it did nothing |
| `auto_trades` / `auto_orders` | Every trade and every order: plans, fills, exit reasons, P&L, timestamps |
| `trade_commentary` | Every commentary note, with the exact prompt version that wrote it |
| `prompt_versions` | Every historical version of the AI instructions |

The practical payoff: any question like *"why did we take that trade?"* is
answerable **months later**, from data — not from memory. (That's exactly how
the HYUNDAI post-mortem and the 15-Jul replays in this course were done.)

## The nightly report card

After 16:00 the poller runs the **end-of-day scorecard** automatically. For
every pick the scanner made that day, it walks the recorded candles and
grades: did the stock reach the plan's target? Hit its stop? How far did it
move in our favor at best, and against us at worst? Where did it close?

Grades accumulate in the same `trade_suggestions` rows. Over weeks this builds
the evidence base for every "should we turn on this filter?" decision — rules
get promoted on multi-day proof, never on one day's story.

## The review pages

| Page | What it shows |
| --- | --- |
| **/auto-trade** | Today's live console: mode, open position, pending approvals, kill switch |
| **/auto-trade/history** | EOD auto-trade results, day by day: each trade, fills, exit reasons, day P&L |
| **/trade-suggest** | The scanner's current picks with reasons |
| **/trade-suggest/history** | EOD scorecard per day: how every pick graded |
| **/trade-commentary** | The AI's notes through the day |
| **/prompts** | Full history of the AI instructions |
| **/reminders** | Parked decisions: switches waiting for more evidence, one-time checks |

## Telegram

Commentary and auto-trade alerts are pushed to Telegram, so the day can be
followed from a phone. The operator's chat gets them by default; additional
viewers are added by an explicit allowlist of chat IDs (each viewer must
start the bot once). Viewers receive broadcasts only — no controls.

## Two lessons the records already taught us

These are worth internalizing, because they shape how the system is tuned:

1. **R-Factor measures participation, not direction or timing.** TATAELXSI
   (15 Jul) held R-Factor 4.2 with heavy OI all day — and went nowhere,
   sideways to slightly up against a bearish pick. High R alone is a crowd
   gauge, not an entry signal; that's why entry rules are separate gates.
2. **Fixing yesterday's loss can delete tomorrow's win.** A filter that would
   have skipped the HYUNDAI loss (extended-from-open) was tested by replay —
   it also deleted PATANJALI's +₹6,504. Every proposed rule gets replayed
   across ALL recorded days before it's trusted. One-day evidence is an
   anecdote, not a rule.

## Under the hood — the code and the maths

| Concept | Method (file) | What it does |
| --- | --- | --- |
| The nightly grader | `reviewToday()` in `lib/trade-suggest/review.ts` | Grades every pick from its own suggestion moment onward (maths below) |
| Its trigger | `runEodScorecard()` in `lib/fyers/poller.ts` | First off-hours tick after 16:00 IST, once per day |
| Trade history reads | `getAutoTradeDates()` / `getTradesByDate()` in `lib/auto-trade/store.ts` | Feed the /auto-trade/history page: the list of trading days, then one day's trades |
| Commentary storage | `lib/ai-commentary/store.ts` | Writes each note with its prompt key + version |
| Decision storage | `lib/auto-trade/store.ts` | Every AI pass with provider, model, and token counts |

### The maths — how a pick is graded

For each pick, take every 5-min candle **from the moment it was suggested**
(never earlier — no credit for moves it didn't call) to the close:

```text
maxUpPct   = (highest high − spot at suggestion) ÷ spot × 100
maxDownPct = (lowest  low  − spot at suggestion) ÷ spot × 100
closePct   = (day's close  − spot at suggestion) ÷ spot × 100
```

Read them direction-aware: for a bullish pick `maxUpPct` is "best case" and
`maxDownPct` is "worst pain"; for a bearish pick it's the mirror. A bearish
pick with `maxDownPct −11.5%` (PATANJALI, 15 Jul) was a monster; a bearish
pick whose `closePct` is *positive* (TATAELXSI, same day) went the wrong way.
These three numbers per pick are the raw material of every filter decision
this project makes.

## The end

You now know the whole machine:

> Data flows in every 5 minutes → fixed rules shortlist unusual stocks → an AI
> decides within a narrow, gated mandate → code-enforced limits bound every
> rupee of risk → everything is recorded → and every evening the system grades
> its own homework.

The design law from the very first page held through all nine lessons:
**the AI proposes, the code disposes.**
