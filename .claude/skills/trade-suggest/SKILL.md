---
name: trade-suggest
description: >
  Daily near-ATM options suggester for the Project-R simulator. Use when the
  user asks for option trade suggestions, ATM picks, "what to trade today",
  the 9:40–11:00 morning scan, or runs this in a loop (/loop 10m
  /trade-suggest). Fetches up to 3 ranked stock picks (buy CE for bullish,
  PE for bearish) from the simulator's live R-Factor + OI-urgency + opening-
  range engine, presents entry/SL/target plans, and after 15:30 runs the
  same-day scorecard of how the calls played out.
compatibility: >
  Requires the simulator dev server running on port 5001 (pnpm dev in
  Project-R-simulator) with Dhan credentials configured (live quotes) and the
  Fyers poller active (5-min candles). Suggestions are analysis only — this
  skill never places orders.
---

# Trade Suggest — daily near-ATM options picks

You are the user's morning options-scan assistant. One invocation = one scan.
Everything below is IST (the exchange timezone). The full methodology,
threshold rationale, and tuning guide live in
[references/strategy.md](references/strategy.md) — read it when the user asks
WHY a gate/threshold exists or wants to tune them.

## What backs this

The endpoint (code in `lib/trade-suggest/`) scans the live NSE watchlist feeds
(F&O-only, non-'avoid' names), gates them on the TradeFinder-derived
fingerprint (OI evidence: futures OI ≥ 1.1× its 20-day average OR NSE combined
futures+options OI change ≥ 5% — options-led builds count too; turnover ≥ 1.2×
average, spread ≤ 0.3%, R-Factor ≥ 3.6 on the 1–8 scale with a non-neutral
bias, price agreeing with the bias), scores the survivors (R-Factor strength/confidence, intraday OI
urgency, opening-range breakout, order-book alignment, sector breadth), picks
the top 3, resolves the nearest listed ATM strike on the nearest monthly
expiry (≥3 DTE), and LIVE-QUOTES each picked contract — real premium, per-lot
cost, option-book spread, contract OI/volume. Contracts whose single lot
costs more than the user's capital budget (₹60,000 in
`lib/trade-suggest/config.ts` — the user trades with ₹50–60k) are skipped for
the next qualified name. The plan has two exit layers: a spot-level SL (last
completed 5-min candle, opening-range fallback; 1:2 target) as the SIGNAL
exit, and a premium backstop (−40% of premium paid, the Indian option-buying
convention) as the MAX-LOSS exit, plus the TF-style premium target that books
~₹5,000/lot. Every pick is persisted to `trade_suggestions` — the first
sighting is what gets scored later.

## Procedure

1. Fetch the scan:

   ```bash
   curl -s http://localhost:5001/api/trade-suggest
   ```

   (Connection refused → tell the user to start the dev server: `pnpm dev` in
   `Project-R-simulator`. Do not retry more than once.)

2. Branch on the JSON:

   - **`window.active: true` with `suggestions`** → present the picks (format
     below).
   - **`window.active: true` but `suggestions` empty** → say nothing qualified
     this pass; report `scanned` and the biggest `gated` reasons (e.g. "42
     scanned; 18 failed OI level, 12 neutral bias"). If `note` mentions the
     quote path or `/api/dhan/token`, surface that.
   - **`window.active: false`, market open** → outside the 09:40–11:00 window.
     If it's after 15:30 OR `earlierToday` is non-empty and it's past 11:00,
     offer/run the scorecard (step 4). Do NOT call with `force=1` unless the
     user explicitly asks for an out-of-window scan.
   - **market closed** → say so; nothing to do until the next session.

3. Present at most 3 picks, each in this shape (compact, scannable):

   > **#1 RELIANCE — BUY 1400 CE** (exp 2026-07-28, lot 500) · score 0.71
   > Premium ₹42.50 → ₹21,250/lot (fits ₹60k budget) · opt spread 0.8%
   > Exits: spot SL 1391 (last 5-min low) / premium backstop ₹25.50 (−40%)
   > Targets: spot 1412 (1:2) / premium ₹52.50 (≈₹5k on the lot)
   > Why: R-Factor 4.3 bullish (conf 68%) · OI 1.28× 20-day avg, urgency 4.2/10
   > · turnover 1.4× avg · opening-range breakout · 2 more PVT BANK names up

   Rules for presenting:
   - Use ONLY numbers from the response — never invent Greeks or
     probabilities. `option.premium` carries the real quoted premium,
     `perLotCost`, `slPremium` (−40% backstop), `targetPremium` (₹5k/lot) and
     the option's own book spread — show them all.
   - Surface `option.premium.liquidityWarning` prominently when present (wide
     option spread / zero volume = slippage risk).
   - Each pick carries a `factors` block — DISPLAY evidence, not gates:
     Supertrend(10,3) + alignment (⚠ when it disagrees — misaligned picks
     went 0/3 on the replay benchmark), session VWAP side, ATR(14) as the
     noise unit, `eqTurnoverRatio` (vs time-adjusted 20-day pace; mornings
     over-read ~2×), `combinedOiLevel` (derived fut+opt OI vs 20-day avg),
     `onOiSpurtList`. Mention the misalignments, don't hide them.
   - The response's `tilt` (market breadth among candidates, since-open) and
     `sectorFlow` (per-sector avg move + OI-list counts) give the session
     context — one line each. Context only; a tilt gate would have blocked
     the benchmark day's one winner.
   - Extended movers (≥3% from open) are now HARD-GATED out
     (`gated.extendedMover`, 0-for-5 evidence). If you ever see
     `extended: true` on a pick, the exclude flag is off — lead with the
     late-to-chase warning.
   - If `option.premium` is null, the contract quote wasn't available — plan
     is spot-terms only; tell the user to check the premium on the broker.
   - The spot SL is the SIGNAL exit; the premium backstop is the MAX-LOSS
     exit. Whichever hits first wins. Position size: with the user's ₹50–60k,
     that's normally ONE lot — say the rupee risk at the premium backstop
     (perLotCost × 40%).
   - Compare with `earlierToday`: mark picks as NEW / repeat (timesSeen) /
     dropped since the last pass.
   - If `option` is null for a pick, present it as a stock signal without
     contract details and say the strike lookup failed.
   - Always end with: this is signal analysis, not financial advice; no order
     is being placed.

4. Scorecard (after 15:30, or when the user asks "how did today's calls do"):

   ```bash
   curl -s -X POST http://localhost:5001/api/trade-suggest -H "Content-Type: application/json" -d '{"action":"review"}'
   ```

   Report per suggestion: direction, spot at call, max favorable move, max
   adverse move, close vs call (all % in spot terms; for PE picks the
   favorable direction is DOWN — read maxDownPct as the win). Summarize:
   how many of today's calls moved ≥1% favorably before 15:30.
   This MUST happen the same day — the candle store clears overnight.

   Then, once the evening bhavcopy is synced (the app nags via a banner),
   fetch the EOD TF-style leaderboard and report where the picks ranked:

   ```bash
   curl -s "http://localhost:5001/api/trade-suggest?view=leaderboard"
   ```

   It returns the top names by the parent-validated spread-linear model
   (R = 1.56 × spread ratio — TF's own EOD fingerprint) plus
   `suggestionRanks` (each pick's rank on that board; null = didn't rank).
   Picks landing in the top ~10 mean the live scan agreed with TF's EOD
   view; consistently unranked picks mean the gates need tuning. The
   `turnoverRatio` column is context only — it is deliberately NOT part of
   the R score (validation showed turnover terms degrade the TF match).

5. Weekly tune-up (when the user asks "how are the calls doing overall", or
   roughly once a week after ~10 reviewed suggestions exist):

   ```bash
   curl -s -X POST http://localhost:5001/api/trade-suggest -H "Content-Type: application/json" -d '{"action":"stats","days":30}'
   ```

   Report hit-rate (≥1% favorable move), average favorable/adverse excursion,
   and the by-rank / by-score-bucket breakdown. If high-score buckets don't
   outperform low ones, the thresholds in `lib/trade-suggest/config.ts` need
   tightening — propose specific changes per the tuning guide in
   [references/strategy.md](references/strategy.md), but only apply them if
   the user agrees.

## Loop mode (/loop)

When running under /loop with self-pacing (dynamic mode), pick the next wake:

- Before 09:40 on a trading day → wake at 09:40.
- Inside 09:40–11:00 → wake every 5–10 minutes (5 min aligns with the Fyers
  candle bucket — each firing sees exactly one new completed bar; the scan is
  cheap: NSE feeds come from a 30s shared cache and the quote is one batched
  call, so 5-min cadence is safe on rate limits).
- 11:00–15:20 → wake at 15:20 (scorecard pass), unless `earlierToday` is empty
  — then stop for the day.
- After the scorecard (or on weekends/holidays) → wake 09:40 next trading day.

With a fixed interval (`/loop 5m /trade-suggest` or `/loop 10m …`), just
follow the procedure each firing; repeats bump `timesSeen` rather than
duplicating picks, and out-of-window firings should produce one short line,
not a full report.

## Never do

- Never place, modify, or cancel orders (no order API is wired, keep it so).
- Never fabricate premiums, Greeks, win-rates, or any number not in the JSON.
- Never call `force=1` in loop mode — the window exists because entries
  outside 09:40–11:00 are unproven for this strategy.
