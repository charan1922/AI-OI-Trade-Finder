# Lesson 03 — The Data Engine

Nothing smart can happen without fresh, trustworthy data. This lesson explains
the plumbing.

## The 5-minute heartbeat

At the center is the **Fyers poller** (`lib/fyers/poller.ts`) — a loop that
starts when the server boots and ticks **every 5 minutes, around the clock**,
with no browser page open and no human involved.

What a tick does depends on the time of day:

| When | What the tick does |
| --- | --- |
| 08:40–09:15 on a trading day | **Token warm-up**: logs into Fyers and Dhan so access tokens exist before the open. Retries are free — the loop just tries again 5 minutes later. |
| 09:15–15:30 (market hours) | **Records data** (below), then runs the **autonomous capture**: scanner → auto-trade pass → commentary. |
| After ~16:00 | Runs the **end-of-day scorecard** once (grades the day's picks). |
| Any other time | Does nothing and goes back to sleep. |

## What gets recorded every 5 minutes

For roughly 50 large F&O stocks (the ones with active futures and options):

- **5-minute candles** of the stock price (and its futures contract) —
  open/high/low/close/volume for each 5-minute window. Stored in the
  `fyers_candles` table, kept for the last **20 trading sessions** so we can
  replay and study past days.
- **Open Interest (OI) snapshots** — how many contracts are held open, so we
  can see OI *growing or shrinking during the day*, not just at day-end.
- **Leaderboard ranks** — every cycle the stocks are ranked by activity, and
  the rank is saved. That lets us spot "climbers" — stocks moving up the
  activity board hour by hour.

## Where the data comes from

- **Fyers** — the primary source for intraday candles and OI recording.
- **Dhan** — a second broker API used for live quotes and option-chain detail
  (and as an execution venue, Lesson 08).
- **NSE bhavcopy** — the exchange's official end-of-day file, downloaded once
  per day after it's published (post-midnight). This gives every stock's
  official daily OI, volume, and turnover — the baseline the "20-day average"
  comparisons are built on.

## Rate limits — why the app is deliberately slow and polite

Broker APIs allow only a few requests per second. The app **never fires
requests in parallel** at a broker; it spaces them out (about 3 per second to
Fyers, 1 per second to Dhan's quote APIs). Trying to be faster gets you
blocked, and being blocked during market hours means blind trading — so
politeness is a safety feature.

## Tokens — the daily keys

Broker APIs need an access token that expires every day. The app generates
these itself using a stored PIN + a TOTP secret (the same 6-digit-code trick
as an authenticator app), saves the token to disk, and renews it before it
expires. This is why the system can run for weeks with nobody logging in.

## Sharing one data stream between many viewers

If five people open the live page, the app does NOT make five sets of broker
calls. Quote responses are cached for ~6.5 seconds and shared — so N viewers
cost the same broker traffic as one. The scanner always bypasses this cache
(`fresh: true`) because real trade decisions must never read a stale price.

## One honest rule about data

**The app never invents a number.** If a quote is missing, a paper trade
simply fails rather than being filled at a made-up price; if a candle didn't
arrive, the cycle logs "no usable candles" and keeps the previous ones. Every
number you see on a page traces back to a real broker or exchange response.

## Under the hood — the code behind this lesson

Skippable if you don't read code — but here is exactly where each idea lives.

| Concept | Method (file) | What it does |
| --- | --- | --- |
| The heartbeat starts | `startFyersPoller()` in `lib/fyers/poller.ts` | Called once at server boot (`instrumentation.ts`); kicks off the loop |
| Ticks land on 5-min marks | `scheduleNextTick()` (same file) | Computes how long to sleep so the next tick aligns with the next 5-minute boundary |
| One full tick | `runFyersCycle()` | Downloads candles + OI for the universe, stores them, then runs scanner → auto-trade → commentary |
| "Is the data complete?" | `hasRequiredEqBar()` | Before acting, checks the expected latest 5-min bar actually arrived — no acting on holes |
| Morning token minting | `inWarmupClockWindow()` + `runTokenWarmup()` | The 08:40–09:15 warm-up; every tick in the window is a free retry |
| Daily keys | `getFyersAccessToken()` / `getDhanAccessToken()` (`lib/fyers/auth.ts`, `lib/dhan/auth.ts`) | Idempotent: return the cached token instantly while valid; only one caller mints at a time (promise lock); token saved to disk |
| Candle storage | `lib/fyers/candle-store.ts` | Upserts each 5-min bar; keeps the last 20 sessions |
| Shared viewer cache | `app/api/live/_lib/quote-response-cache.ts` | The 6.5-second cache + "coalescing" (simultaneous identical requests share one broker call) |
| Evening report card | `runEodScorecard()` in `poller.ts` | After 16:00, calls `reviewToday()` once per day (maths in Lesson 09) |

**The one piece of maths here — the candle bucket.** Every timestamp is rounded
DOWN to its 5-minute slot: `bucketTs = floor(time ÷ 300) × 300` (300 seconds =
5 minutes). All ticks inside a slot form one candle: its **open** is the first
price, **high** the highest, **low** the lowest, **close** the last. That's the
entire trick behind every candle chart you've ever seen.

---

**Next:** [Lesson 04 — The Scanner](04-the-scanner.md) — how 50 stocks become
2–3 picks.
