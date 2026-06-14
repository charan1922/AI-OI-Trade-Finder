# /signal-lab page — the point-in-time scanner, explained

Built 2026-06-12. This is the step AFTER the /data-downloader forensics: it turns "what was unusual around TF's trades" into a testable rule, and tests it honestly.

## 1. Why this page had to exist

The /data-downloader page has two built-in limitations (documented in tracking/downloader.md):

1. **Selection bias** — it only studies trades TradeFinder TOOK. You never see the days the same pattern appeared and nothing happened. Concluding "OI buildup works" from only the taken trades is like studying lottery winners to learn how to win the lottery.
2. **Look-ahead** — its "Why this trade" card uses the trade day's end-of-day numbers, which did not exist yet at the moment the trade was entered (TF enters intraday).

Signal Lab removes both:

- It scans **every F&O stock, every session** in the bhavcopy database (~223 stocks × ~123 sessions), not just TF's picks.
- Signals are computed from day D's official end-of-day data, and the trade happens on day **D+1** — so every number the rule sees genuinely existed the evening before the trade. No look-ahead, by construction.

## 2. The rule being tested

On each evening D, for each stock, using only data ≤ D:

| Condition | Default | Meaning in plain words |
| --- | --- | --- |
| Futures OI level ≥ 1.25× | futOi(D) ÷ avg of up-to-20 prior sessions | The stock's futures are unusually crowded vs their own normal. 1.25× is the zone TF's top picks sat in (the V4 finding). |
| Turnover ≥ 1.5× | futTurnover(D) ÷ 20-session avg | Heavy participation — a quality filter. |
| Strong quadrant | price & OI change D-1 → D | Long buildup (price up + OI up) → go LONG. Short buildup (price down + OI up) → go SHORT. Weak quadrants (covering/unwinding) excluded by default. |

Trade: enter at D+1's official NSE **open**, exit at the official **close** after the chosen hold (default 1 session). Every trade gets equal capital. A flat 0.1% round-trip cost is charged.

**The benchmark:** every result is compared against the *random baseline* — the average return of EVERY stock-day with the same entry/exit pattern and the same cost, weighted by the run's long/short mix. The rule must beat that, not just zero. A rule can show "+0.2% per trade" and still be worthless if any random pick averaged the same.

## 3. What the first runs found (2026-06-12, data Dec 2025 → Jun 2026)

- **Defaults (both sides):** 267 trades, 48.7% win rate, −0.20%/trade net, edge −0.10% vs random. **The naive rule loses.**
- **The split tells the real story:** SHORT side (short buildup): 148 trades, 58% win rate, **+0.30%/trade, edge +0.35%, profit factor 1.43**. LONG side (long buildup): 119 trades, 37% win rate, −0.81%/trade.
- Context: the whole market drifted down in this window (baseline −0.05%/stock-day), which flatters shorts and hurts longs — but the gap between the two sides is much larger than that drift alone explains.
- TF overlap: of 15 trades on days with TF snapshots, 2 were in TF's top-20 — the rule is NOT simply re-discovering TF's list (TF's model is spread-dominated; this rule is OI-dominated).

**Beginner takeaway:** a negative overall result is the tool working, not failing. It just saved you from trading a losing configuration with real money. The short-side result is promising but is one regime, ~150 trades — promising, not proven.

## 4. How the math stays honest (the safeguards in the code)

All in lib/backtest/signal-scanner.ts:

- 20-day averages use sessions **strictly before** D (`days.slice(i-20, i)`) — the signal day never feeds its own baseline.
- A signal needs ≥10 prior sessions of futures data — no averages from 2 days of history.
- "Next session" is the symbol's own next row; if it is more than 5 calendar days away (stock left F&O, suspension) the signal is counted as **untradeable**, not silently traded at a stale price.
- The baseline pays the same per-trade cost, and is direction-adjusted (a random SHORT averages the mirror of a random LONG).
- Equal capital per trade ⇒ percentage points add; the cumulative curve and max drawdown are computed on that basis.
- Verdict banner refuses to judge runs with <30 trades ("too few to judge — averages over tiny samples are mostly luck").
- The UI footnote warns about **curve-fitting**: if you tweak parameters until the result looks good, the best result means little. Decide the rule first, then test.

Verification done at build time: a sample trade (360ONE, signal 2025-12-23) was recomputed by hand from raw SQLite — OI level, turnover ratio, quadrant, entry/exit prices and return all matched the scanner's output to full precision. Session arithmetic correctly skips holidays (exit hopped over Christmas).

## 5. What this scan is NOT

- It trades the **stock**, not the option. No per-strike premium history exists for the whole universe, so an options backtest over all stocks is impossible with current data. Option premiums would amplify both the wins and the losses (and add theta decay + spreads).
- ~6 months of data = **one market regime**. The same rule can behave differently in a strong bull market.
- Costs are a flat approximation; real slippage on illiquid names is worse.
- It says nothing about TF's actual model (which is spread-dominated per the V4 research) — it tests OUR candidate rule, derived from the OI-level observation.

## 6. The files

| File | Purpose |
| --- | --- |
| lib/backtest/signal-scanner.ts | All scan logic: signal computation, trade simulation, baseline, stats. Pure + one DB read. |
| app/api/backtest/scan/route.ts | POST endpoint; clamps params to sane ranges (sanitizeScanParams). |
| app/signal-lab/page.tsx | Controls (each with plain-English tooltip), the rule restated in words, results. |
| _components/how-it-works.tsx | The 3-step evening→morning→exit explainer; why selection bias matters. |
| _components/scan-scoreboard.tsx | Verdict banner (plain-English answer, honest about sample size) + 8 stat cards with tooltips. |
| _components/scan-curve.tsx | Cumulative net-% staircase (SVG, same style as backtest page). |
| _components/scan-table.tsx | Direction/quadrant breakdowns + full trade table with TF-overlap badges. |

Sidebar: "Signal Lab" between Backtest and Live Urgency.

## 7. Next steps (in order of value)

1. **Stability check:** does the short-side edge survive across sub-periods (split the window in half) and parameter wiggles (1.2×/1.3× instead of 1.25×)? An edge that vanishes when a knob moves 5% was never real.
2. **More history:** sync more bhavcopy months (the table currently starts 2025-12-09) to test more regimes.
3. **Paper-trade the live side:** the /live page already computes setups in real time — track its picks vs this rule's picks forward, with no money, for a month.
4. Only after 1–3 hold up: think about position sizing, options conversion, and real execution.
