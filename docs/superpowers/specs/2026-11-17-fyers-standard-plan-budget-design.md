# Fyers Standard-plan data budget — design

Date: 2026-11-17 · Status: proposed (operator chose "stay on Standard, do not upgrade to Prime")

## Problem

Fyers split its API limits into plans (announced 2026-10-15). On the Standard plan the
**Data APIs** (history, quotes, depth, option chain) now allow **5/sec, 50/min, 5,000/day**.
Transaction and user-info APIs (orders, positions, funds) are unchanged at 200/min and
100,000/day, so order placement is not affected.

Our account has been refused since **Monday 2026-11-16 09:15:36 IST** (no refusals 10–15 Nov):

| Day | Per-minute refusals | Daily cap hit at | Daily-cap refusals |
|---|---|---|---|
| 2026-11-16 | 4,602 | 11:45 | 7,658 |
| 2026-11-17 | 4,588 | 11:45 | 5,079 |

After 11:45 no candles are recorded for the rest of the day, and every 5-minute poller
cycle still fires ~495 calls that all fail.

Why the app overspends:

| Caller | Setting | Cost |
|---|---|---|
| Candle poller | `fyersDataLimits()` 8/s, 150/min, 90,000/day; 165 stocks × 3 calls (EQ history, FUT history, FUT depth) every 5 min (`lib/market-data/provider.ts`, set 2026-10-08 from the then-official 200/min, 100k/day) | ~37,000/day |
| Open-trade guard | `FAST_GUARD_TICK_MS = 5_000` (`lib/auto-trade/config.ts`, 2026-07-22) — one option quote per tick | ~3,700/day per open trade |
| NIFTY options context | `refreshNiftyGammaContext()` each poller cycle when no trade is open | ~150/day |
| Everything else (premiums for picks, NIFTY candles for the sideways tool) | | ~350/day |

## Goal

Fit every Fyers data call inside 5,000/day and 50/min with headroom, **without losing anything
the trade path needs**, and make a refusal impossible to miss.

Non-goals: Prime upgrade, websocket feed, changing any selector check, changing order APIs.

## Decisions (operator, 2026-11-17)

1. **Full candles only for tradeable names.** EQ 5-min candles only for the poller's existing
   priority set — TF top-10 candidates, risk-bearing trades, today's earlier suggestions
   (`getPrioritySymbols()` in `lib/fyers/poller.ts`). 1 call per name per cycle.
2. **No futures candles. Futures depth/OI only for the priority set** (recommended option 2 —
   awaiting operator confirmation). No check reads FUT candles. The FUT depth call feeds four
   /live columns — App Fut OI, App OI Lvl, App OI Build, App Bid/Ask — and `oiLevel` /
   `oiUrgency` are also passed to the AI trader (`lib/auto-trade/decision/context-policy.ts`)
   and the AI commentary (`lib/ai-commentary/generate.ts`) as "futures OI n× 20-day avg". The
   composite score that uses them is a tie-breaker after TF order only and never changes a pick
   (`lib/trade-suggest/engine.ts:689`). So depth stays for the tradeable names (1 more call each
   per cycle) and those four columns go blank ("—") for every other name.
   **App OIΔ30m is NOT affected:** it is derived from NSE's combined OI (`nseOiPct` series →
   `combinedOiSlope`, `lib/fyers/candle-store.ts:343`), costs no Fyers call, and keeps working as
   long as `nseOiPct` is still recorded per 5-min bucket for every name (see Poller).
3. **All other F&O names get a batched price snapshot** every cycle via the Fyers quotes endpoint
   (50 symbols per call, ~4 calls per cycle).
4. **Option chain removed completely** — the NIFTY options context (`lib/signals/nifty-gamma-context.ts`,
   `/api/live/nifty-context`, `app/live/_components/nifty-market-context.tsx`), the unscheduled
   R V2 Shadow collector (`lib/option-chain/shadow.ts` and friends), the commentary's
   option-chain sentence (`getCachedOptionEvidence` / `describeOptionChain`), and the Fyers
   `options-chain-v3` client (`lib/fyers/option-chain.ts`). Stored history tables are NOT dropped
   (never `db push --accept-data-loss`); `scripts/measure-option-evidence.ts` keeps reading them.
5. **Open-trade guard every 15 s** (was 5 s).

## Budget after the change

| Caller | Calls/day |
|---|---|
| Priority EQ candles (≤ 12 names × 75 cycles; ~11 typical) | ~825 (max 900) |
| Priority FUT depth / OI (≤ 12 names × 75 cycles; ~11 typical) | ~825 (max 900) |
| End-of-day grading fetch for earlier suggestions | ≤ ~10 |
| Batched snapshots (~4 per cycle × 75) | ~300 |
| Open-trade guard at 15 s (per trade held ~10:00–15:12) | ~1,250 |
| NIFTY candles for the sideways tool | ~75 |
| Option premiums for picks | ~200 |
| **Total (one trade day)** | **~3,485 typical, ~3,635 max** (gate cap 4,500) |

## Components

### 1. Budget gate — `lib/market-data/provider.ts` + `lib/fyers/client.ts`

- `FYERS_OFFICIAL_LIMITS` becomes the Standard Data-API limits `{ perSecond: 5, perMinute: 50, perDay: 5_000 }`,
  with the source and date in the comment.
- `fyersDataLimits()` returns `{ perSecond: 4, perMinute: 40, perDay: 4_500 }` — headroom for
  bursts and for calls the gate does not see.
- `CALLS_PER_SYMBOL` becomes 2 (EQ history + FUT depth). `symbolsPerCycle()` caps the priority
  set so it can never outgrow the budget.
- **Refusal latch:** a Fyers refusal for the per-minute limit (HTTP 429, or `s:'error'` with the
  -360 / "requests/minute" message) blocks every data call until the next minute; a refusal for
  the daily limit (-360 / "requests/day") blocks every data call until 00:00 IST. While latched
  the gate throws immediately — no request is sent. This is what stops today's
  495-failed-calls-per-cycle behaviour.
- **Priority lanes:** when the remaining minute/day budget is short, calls are served in order
  open-trade guard → priority candles → premiums → snapshots → NIFTY candles. Implemented as a
  `priority` argument on `throughFyersGate` / `requestFyersData`; low lanes are refused first when
  the remaining daily budget falls under a reserve: the last **500** calls of the day are
  reserved for the open-trade guard.
- Gate state (calls today, last refusal, latch-until) is exposed on `PollerStatus` and the `/fyers`
  page shows an amber banner while latched.
- **Every data call is counted — no bypass.** `fyers-adapter.ts:123` fetches a quote with the SDK's
  `getQuotes` through the adapter's own `serial()` gate, outside the data counter. It is a Data API
  call, so it moves onto the data gate (highest lane — it runs at order time). The adapter's
  order / position / funds calls stay on `serial()`: they are Transaction APIs with their own
  200/min, 100k/day limit.
- **The count survives restarts.** Today the counter lives in memory (`gate.dayCount` in
  `lib/fyers/client.ts`), so every deploy or crash resets it to 0 while Fyers keeps counting — two
  deploys on 2026-11-17 alone. The day's count, latch-until and latch reason are persisted in a
  small SQLite table `fyers_data_budget` (date PK, count, latchUntil, latchReason, updatedAt),
  loaded at boot and written on each dispatch (batched: at most once per second plus on latch).
  A boot during the day therefore resumes from the stored count.

### 2. Poller — `lib/fyers/poller.ts`

- Candles: iterate the priority set only — `fetchHistory5m(eqSymbol)` + `fetchFutDepth(futSymbol)`;
  drop `fetchHistory5m(futSymbol)` for everyone. The rotating tail is removed.
- **The priority set is capped at 12** (`MAX_PRIORITY_SYMBOLS`), filled in this order: risk-bearing
  trades → current TF top-10 candidates. Today `getPrioritySymbols()` also adds every earlier
  suggestion of the day, which can push it to 15–20 on a busy day. Earlier suggestions only need
  candles for grading (`lib/trade-suggest/review.ts`), and one history call returns the whole day,
  so they move out of the per-cycle set: each gets **one** EQ history fetch after 15:30
  (≤ ~10 calls a day), made in the lowest lane.
- Snapshots: one batched quotes pass over the rest of the universe (≤ 50 symbols per call),
  stored in a separate table `fyers_quote_snapshots` (symbol, date, ts, ltp, open, high, low,
  prevClose, volume). **Snapshots are never written as candle rows** (house rule: no fabricated
  data). Same 20-session retention as candles.
- `nseOiPct` attachment keeps working: it currently piggybacks on FUT rows; it moves to its own
  zero-OHLCV FUT row exactly as `attachFutOi` already does, without the Fyers depth call.

### 3. Readers of non-priority data

- `/live` rows for names without candles read price / day change / volume from the latest
  snapshot. Columns that need real candles (breakout, trend, morning candles) show "—" with a
  tooltip "no candles: not in TF top 10 (Fyers Standard budget)". No approximations.
- `loadMarketSideways()` (AI tool only) works on whatever names have candles; with fewer than its
  existing 50-name minimum it already returns `stuck: null` (unknown never blocks). It is NOT
  rewired to snapshots — it is an AI tool, not a gate, and stays unchanged.
- Daily screen / EOD snapshot: same rule — candle-derived fields blank for non-candle names.

### 4. Guard — `lib/auto-trade/config.ts`

- `FAST_GUARD_TICK_MS = 15_000`, comment records why (Standard plan budget) and the cost of each
  cadence. The guard runs in the highest priority lane, so it is never starved by other callers.

### 5. Removal — option chain

Delete the modules listed in decision 4 plus their routes, UI, poller hook and verify-script
references; remove the commentary prompt line that mentions `optionChain.read` only if the
byte-frozen `COMMENTARY_SYSTEM` does not contain it (if it does, leave the prompt and pass no
option field — the prompt stays byte-identical per CLAUDE.md).

## Error handling

- Latched gate → callers get a clear error ("Fyers data limit reached until HH:MM") instead of a
  silent empty result; the trade path's existing fail-closed rules apply (stale candles reject
  entries; the guard reports "no usable quote").
- The `/fyers` "LAST CYCLE" card shows calls used today / 4,500 and the latch reason.

## Testing

- Pure bench (CI): extend `scripts/verify-freshness-gate.ts` or add `scripts/verify-fyers-budget.ts`:
  latch on per-minute and per-day refusal messages, lane ordering under a short budget, daily
  reset at 00:00 IST, and a budget simulation of one trading day (75 cycles, 11 priority names,
  165-name universe, one trade 10:00–15:12) that must stay ≤ 4,500.
- Pin the numbers: `FAST_GUARD_TICK_MS === 15_000`, limits `4/40/4500`, `MAX_PRIORITY_SYMBOLS === 12`.
- Restart test (isolated SQLite, like `verify-mpp-resting-orders.ts`): dispatch N calls, rebuild
  the gate from the table, assert it resumes at N and keeps an active latch.
- Bypass guard: a source check that no file outside `lib/fyers/client.ts` calls the SDK's
  `getQuotes` / `getHistory` / `getMarketDepth` / `getOptionChain` or fetches `api-t1.fyers.in/data`
  directly.
- Box check after deploy: next session, `/fyers` shows calls used < 4,500 at 15:30 and zero
  refusal lines in the logs.

## Docs

- CLAUDE.md: replace "Fyers data budget = the OFFICIAL limits … no plan tiers" with the Standard
  plan numbers and this design; remove the R V2 Shadow / option-chain evidence section's
  "collected by option-shadow.ts" wording (history kept, collector removed).
- Memory: update `fyers-live-downloader` (FUT candles/OI no longer recorded).

## Unknowns (cannot be settled from the code)

- Whether Fyers counts refused requests toward the limits. The design does not depend on it: the
  latch stops sending either way.
- When Fyers' daily count resets. The gate assumes 00:00 IST; if Fyers resets at another time the
  latch simply lasts until the first successful call after our reset (a refused call re-latches).
- Whether the priority-set estimate (~11) holds on real days — the `/fyers` daily count and the
  CI budget simulation are the checks.

## What is given up

- Full candles for non-priority F&O names (prices stay, candle-derived columns blank).
- Fyers futures candles (nothing reads them).
- App Fut OI / App OI Lvl / App OI Build / App Bid/Ask for non-priority names (App OIΔ30m stays).
- 20-session all-stock candle history for future replays (priority names only from now on).
- NIFTY options context box and the option-chain commentary sentence.
