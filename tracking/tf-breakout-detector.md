# TF Breakout Detector — the 3-check strategy, live + backtested

Done 2026-07-11. Implements Pro Trader Aakash's "3 ways to find price direction
after breakout" (R-Obsidian vault: `raw/articles/2026-07-06-breakout-secrets-video.md`,
distilled in `wiki/setups/entry-setups.md` § "Breakout confirmation — 3 checks")
as a real-time detector on `/live` and `/trade-commentary`, then validates it by
walk-forward backtest over the **320-trade TradeFinder book** already in our DB.
Status: on `develop`, **not committed**. Everything is additive — no gates, no
schema changes, no new deps.

## 1. The strategy (what the video actually says)

Smart money can't build size at once without spiking the price, so it
accumulates quietly; the breakout only comes once positions are full. Three
checks tell you whose breakout it is:

1. **Morning test** — the first 5–15 min low is never broken all day (buyers
   absorbing every dip). Broken early + late breakout = the TCS fakeout profile
   (buyers burned their capital fighting in the morning). Bearish mirror: a
   fiercely-defended morning HIGH.
2. **Capital efficiency** — high R-Factor = institutions moving price smoothly
   with fuel left; avoid breakouts on inefficient names even if the chart looks
   fine.
3. **Multi-level aggression** — the strongest breakouts shatter SEVERAL named
   resistances at once (TECHM cleared morning high + prior swing high +
   prev-day high on one line → the day's pick; PERSISTENT cleared two → weaker).

## 2. The detector — `lib/breakout/` (pure, no app/DB imports)

| File | What it does |
| --- | --- |
| `morning-test.ts` | Check 1. Morning window = first **15 min** (the newer video rule; older video said 30). Break is **sticky for the day**. `breakTolerancePct` filters stop-hunt ticks (see §5). |
| `swings.ts` | Fractal swing highs/lows (k=2) on today's 5-min bars — net-new; nothing in the repo had pivots. |
| `levels.ts` | The named ladder: OR high (9:15–9:45), prev-day high, **5d/20d base tops** (the ADANIENSOL multi-day-base class), intraday swings — + bearish mirrors. Same-source duplicates dropped; distinct levels at the same price count separately (that coincidence IS the aggression). |
| `detector.ts` | `deriveBreakoutContext` (SLOW: bars + EOD anchors, cached 5 min) and `evaluateBreakout` (FAST: live LTP vs cached levels, every ~7 s poll). Grades: **strong** (held + ≥2 levels + R-Factor ≥ 4.5) / **confirmed** (held + ≥1) / **watch** (held, none yet) / **fakeout-risk** (clearing levels but morning broke) / **none**. |

Check 2 reuses the live R-Factor (1–8 scale) — no second efficiency metric.

## 3. Where it's wired

- **`/api/live/quote`** — new `_lib/breakout-context.ts` (per-symbol cache, 5-min
  refresh, warms every displayed symbol — local SQLite only). Row gains optional
  `breakout: BreakoutSignal | null`. Null until candles are recorded — never
  fabricated; the closing snapshot freezes the final verdict for same-day
  post-market viewing.
- **`/live` UI** — new sortable **Breakout** column (`Strong BO 2L ↑`,
  `Fakeout?`, `Base held`…), tooltip = morning test + cleared level names + next
  level overhead. Full legend in *How to read*. Setup/R-Factor columns untouched.
- **Trade-suggest** — `TradeSuggestion.tfBreakout` (evidence field + a reason
  line). **Not a gate, not scored** — same rule as `PickFactors`: nothing earns
  weight without replay proof.
- **AI commentary** — `tfBreakout` forwarded in `trimForPrompt`, SYSTEM-prompt
  rules (strong = prime evidence, fakeout-risk = plain ⚠), `TF BO` chip in
  `picks.ts`.
- **Baselines** — `rfactor-baselines.ts` gained `high5d/low5d/high20d/low20d`
  from the bhavcopy rows it already fetched (zero extra queries; replay-lib
  mirror updated).

## 4. The backtest — 320 real TF trades (`scripts/backtest-breakout.ts`)

Data: `data/tradefinder_platform_trades.json` (342 taken trades) + the curated
20 → **320 with full trade-day 5-min bars** (`backtest_equity`), levels from
`bhavcopy_days` (123) or prior downloaded days (197), option premiums
(`backtest_options`) + preserved lots (`trade_contracts`) for 40. Walk-forward,
point-in-time, **no lookahead**; R-Factor passed as null (not reproducible
historically) so `strong` is untestable offline — price-structure checks are
what's under test.

| Metric | Result |
| --- | --- |
| Signal fired on TF trade-days | 315/320 (98.4%) |
| **Direction matched TF's side** | **288/315 (91.4%)** |
| Fired at/before 10:30 (TF's entry zone) | 309/315 (98.1%) |
| Equity move after confirmation (signal→close, signed) | **median +2.55%, positive 87.6%** |
| P&L sim, ₹5k target or EOD | 39/40 wins, ₹1,73,552 net |
| P&L sim, **₹5k target / −₹1.5k SL** (our risk rules) | **34/40 wins, ₹1,45,123 net** |
| P&L sim, prev-candle trailing stop | 19/40, ₹29,837 — **too tight for options, avoid** |
| TF's own P&L on those 40 (discretionary exits) | ₹6,28,099 |

**Honest caveats:** TF's book is 92% winners (their edge includes exits), so
grade-vs-outcome separation is weak — only 6/25 of their losses were
un-confirmed at entry, and entry-time fakeout flags all landed on wins. The
proven value is **direction + timing + forward move**, i.e. annotation/ranking,
not loss prediction. The P&L sim enters TF's own contracts — it proves *entry
timing*, not stock discovery.

## 5. Evidence-driven fix — 0.1% morning-break tolerance

At zero tolerance, paisa-deep stop-hunt ticks counted as "morning broken":

| Tolerance | fakeout flags at entry (all were TF wins) | losses still warned | dir-match |
| --- | --- | --- | --- |
| 0.0% | 12 | 6/25 | 91.7% |
| **0.1%** | **8** | **6/25** | 91.4% |
| 0.2% | 5 | 6/25 | 91.5% |

0.1% halves the false alarms, loses zero genuine warnings → shipped as
`MORNING_BREAK_TOLERANCE_PCT` in `detector.ts`; the context carries it so bar
test and live-tick test apply the same slack.

## 6. `USE_TF_BREAKOUT_GATE` — the gating experiment switch (OFF)

Added on request: `lib/trade-suggest/config.ts` default `false`, registered in
`lib/config/feature-toggles.ts` (visible on `/config`), gate in `engine.ts`
survivor loop. When ON, a candidate must grade **confirmed/strong in the
trade's direction**; watch / fakeout-risk / none / no-candles are dropped and
counted as `gated.tfBreakoutGate`. **Keep OFF**: §4 shows gating is unproven —
enable only after a replay A/B over recorded live sessions (full scan universe,
not TF's curated book). That replay extension is the open follow-up.

## 7. Verification & how to re-run

- `npx tsx scripts/validate-breakout.ts` — 24 assertions: synthetic TECHM
  profile → `strong`, synthetic TCS profile → `fakeout-risk`, sub-tolerance
  poke ≠ break, guards, + invariants on real recorded bars. All pass.
- `npx tsx scripts/backtest-breakout.ts [--csv]` — the §4/§5 numbers,
  reproducible (sweep runs at 0/0.1/0.2 each time).
- `pnpm typecheck` / `pnpm lint` clean; `/live`, `/trade-commentary`,
  `/api/config/toggles`, `/api/trade-suggest` all respond with the changes live.
- Default-off toggle verified: gate code only runs when flipped ON.

## 8. Open items

1. **Replay A/B for the gate** — extend `scripts/replay-lib.ts` to model the
   TF verdict per tick, then compare picks with/without the gate across the
   recorded sessions. Precondition for ever enabling `USE_TF_BREAKOUT_GATE`.
2. `strong` grade is live-only (needs live R-Factor) — accumulate live days,
   then judge it on the Trade Log like the other experimental toggles.
3. Nothing committed yet — most of the work is staged on `develop`; the toggle
   files (config.ts, feature-toggles.ts, engine.ts gate) are working-tree only.
