# /trade-suggest — strategy reference & tuning guide

Everything here maps to a constant in `lib/trade-suggest/config.ts`. Change
thresholds there; nothing else needs edits.

## Where each rule comes from

| Rule | Value | Source |
|---|---|---|
| Entry window | 09:40–11:00 IST | TF's verified tickets cluster 10:00–10:40; the repo's opening range finalizes at 09:45; ORB literature puts the strongest moves before ~10:30. |
| OI evidence gate (two paths) | futures OI ≥ 1.1× 20-day avg, OR NSE combined (fut+opt) OI change ≥ 5% | TF's top picks sit at 1.25–1.35× futures OI (repo V4 analysis); 1.1 is the admission floor. The NSE combined path admits options-led builds futures-only OI misses — 2026-07-03 SUNPHARMA: futures 0.90× but combined +8.1%, TF's winner that day. |
| Turnover gate | ≥ 1.2× (time-adjusted) avg | The third TF "pillar" from the repo's trade analysis. Implemented as R-Factor turnover score ≥ 0.1 (score = (ratio−1)/2). |
| Equity spread gate | ≤ 0.3% | Same threshold the /live setup-score uses for "tradeable". |
| R-Factor gate | ≥ 3.6 on the 1–8 scale, non-neutral bias, confidence ≥ 0.2 | TF's actionable zone (same raw cutoff as 2.5 on the old 1–5 scale); below it the composite carries mostly noise. |
| Price/bias agreement | chg-from-open agrees, or OR breakout | A bullish read on a falling stock is a fade, not a momentum entry. |
| Near-ATM strike | nearest LISTED strike, nearest monthly expiry ≥ 3 DTE | ATM has the best liquidity/gamma for intraday momentum buying (delta ~0.5); < 3 DTE is theta-burn territory. |
| Capital budget | ₹60,000/lot max | The user trades with ₹50–60k. Unaffordable contracts are skipped for the next qualified name (`unaffordableLot` in `gated`). |
| Spot SL | last completed 5-min candle (OR fallback), floored at 0.35% of entry | Tradehull/ORB convention — the signal-invalidation level. A structural SL tighter than 0.35% (`MIN_RISK_PCT`) sits inside 5-min noise and is widened (`slBasis: 'floor'`) — seen live 2026-07-03 (MARICO 0.05-pt "risk" on an ₹842 stock). |
| Extended-mover gate | HARD-SKIPPED at pick time (`EXCLUDE_EXTENDED`) | Extended picks are 0-for-5: live 2026-07-03 (MUTHOOTFIN/POLICYBZR/MARICO stopped) + replay benchmark same day, where banning was the only variant that improved ΣR (+1.00 vs 0.00). Flip the flag to fall back to the ×0.6 penalty. |
| Display factors (not gates) | Supertrend(10,3), VWAP side, ATR(14), eqTurnoverRatio, combinedOiLevel, market tilt, sector flow | Replay-tested 2026-07-03: a tilt or VWAP gate would have blocked the day's ONE winner; Supertrend alignment went 1/1 vs 0/3 (promising, needs more days before earning weight). Shown as evidence chips so the trader weighs them. |
| Premium backstop | −40% of premium paid | Indian option-buying convention (40–50%); caps the worst case when spot chops around the SL. |
| Targets | spot 1:2 R:R; premium +₹5,000/lot | 1:2 is the ORB standard; ₹5k/lot is TF's own realized profit-taking pattern. |

## Composite score (WEIGHTS, sum 1.0)

rFactor 0.22 · orBreakout 0.20 · oiUrgency 0.18 · oiLevel 0.12 ·
sectorBreadth 0.08 · confidence 0.08 · imbalanceAlign 0.07 · setupStrong 0.05.
(orBreakout raised to co-lead 2026-07-03 — user directive "price action and
breakout are crucial"; the day's one TF winner was an OR breakout while both
non-breakout picks stopped out.) Extended movers (≥3% from open) get the
final score multiplied by 0.6.

These weights are **provisional** — the R-Factor's own calibration has only
two ground-truth days behind it. That is exactly why every suggestion is
persisted and scored: the weights get tuned from evidence, not vibes.

## The calibration loop (why stats exist)

1. Each scan persists picks to `trade_suggestions` (first sighting fixes the
   scored entry — spot + premium at call time).
2. The same-day review (`{action:'review'}`) records max favorable/adverse
   spot excursion + close after each call.
3. `{action:'stats', days:N}` aggregates across days: hit-rate (≥1% favorable
   before close), average excursions, breakdown by rank and score bucket.

### How to read stats and tune

- **Hit-rate flat across score buckets** → the score isn't discriminating:
  raise `MIN_RFACTOR` (3.6 → 4.0 on the 1–8 scale) or shift weight from
  `confidence` to `oiUrgency` (the most orthogonal live signal).
- **Rank 1 no better than rank 3** → oversupply of similar setups; consider
  `MAX_PICKS = 2` or a higher `MIN_OI_LEVEL` (1.1 → 1.2).
- **avgAdversePct > avgFavorablePct** → entries are chasing; tighten
  `WINDOW_END_MIN` (11:00 → 10:30) — late-window momentum fades fastest.
- **Many `unaffordableLot` skips** → high-priced underlyings dominate; that's
  fine (the fallback picks the next name), but persistent skipping of rank-1
  names is a sign to consider spread strategies (out of scope here).
- Tune ONE constant at a time and give it a week of data before judging.

## Data-source honesty rules

- Option premium, book, OI, volume come from one live Dhan quote of the
  picked contracts. When that quote fails the `premium` block is null —
  nothing is estimated or fabricated (no Greeks, no IV, no synthetic SLs).
- Spot outcomes come from the Fyers 5-min store; review must run same-day
  (the store clears at the next session's first poll).
- The `trade_suggestions` table persists across days — it is the durable
  audit trail; treat it as append-only.
