# TF R-Factor Selector — replacing App R-Factor in the trade decision path

**Date:** 2026-08-13
**Status:** design approved, not yet implemented
**Operator decisions:** TF R-Factor only (App R-Factor is removed from every decision); auto-trade
takes candidates **only** from the TF Running Race; direction from TF % change confirmed by
Supertrend; opening-range breakout required; no fresh TF board → no entries; only tradeability gates
survive; first deploy in **paper** mode. Operator asked for ~90% win rate — §3a shows the
configuration that reaches it and what it costs versus the max-profit configuration.

---

## 1. Why

The live system loses money. Paper P&L: Aug 12 −₹2,281, Aug 11 −₹4,925, Aug 7 −₹4,106,
Aug 6 −₹1,394, Aug 3 −₹3,562. Graded picks on the three sessions where TF captures exist average
**−0.199R over 14 calls**.

The cause is measurable. Pairing every graded pick with the TF board captured *at or before* it
(strict no-lookahead):

| Pick | App R-Factor | TF rank | TF R | Outcome |
|---|---|---|---|---|
| LICI CE (8/11) | 6.45 | #9 | 1.14 | +2.00R |
| LUPIN PE (8/10) | 4.78 | #7 | 1.43 | +2.00R |
| POWERINDIA CE | 3.71 | #9 | 1.21 | +1.21R |
| BLUESTARCO CE | 5.61 | #27 | 0.71 | −1.00R |
| BOSCHLTD CE | 5.49 | #38 | 0.55 | −1.00R |
| LICI CE (8/12) | 4.99 | #96 | 0.68 | −1.00R |
| LUPIN PE (8/11) | 4.50 | #123 | 0.22 | −1.00R |

**App R-Factor scored every one of them 3.65–6.45** — it has no discriminating power. TF
simultaneously reported near-zero institutional participation on the losers.

The single strongest statistic in this entire investigation is the anti-rule:

> **TF R-Factor < 1.0 → −0.317R, t = −11.12, n = 1603.**

81% of everything that looks tradeable sits below TF R = 1.0, and that is exactly where the current
engine fishes.

## 2. What TF R-Factor actually is

Across 107,726 intraday readings, TF's R-Factor **decreased only 0.47% of the time**. It only
ratchets up within a session. So:

- the **level** = how much big money has entered *cumulatively today*
- the **slope (ΔR)** = the rate money is arriving *right now*

These are different signals and the current system reads neither. Observed profiles:

```
FORTIS  2026-08-12  (won +2R)   R and price move together, all day
  09:33  R 1.76  #3   −2.85%
  10:05  R 3.06  #3   −3.60%
  14:41  R 4.66  #2   −5.83%

NAUKRI  2026-08-11  (big move)  earned its rank as R climbed — only #17 at 09:45
  09:45  R 1.16  #17  +3.74%
  12:46  R 3.33  #3   +8.23%

APOLLOHOSP 2026-08-11 (lost −1R)  "high TF sitting quiet"
  09:51  R 3.50  #1   −1.67%
  10:06  R 3.50  #1   −0.84%   ← frozen
  12:21  R 3.50  #1   −2.42%   ← 2.5h, no new money, price chopping
```

APOLLOHOSP held **rank #1 and the highest R on the board all day** while going nowhere. A snapshot
endorses it; the slope rejects it. This is the case the design must exclude, and it is why R level
alone is insufficient.

## 3. The selection rule

```
        ┌─ TF capture (≈5-min, /tf) — all_sector, 210 symbols × R-Factor ─┐
        └──────────────────────────┬───────────────────────────────────────┘
                                   ▼
 ①  TF RUNNING RACE     rank ≤ 20 NOW  AND  climbed since the 09:35 baseline
                        └─ THE ONLY CANDIDATE SOURCE for auto-trade (operator rule).
                           rank ≤ 20 corresponds to R ≈ 1.4 on all three sessions,
                           so this structurally excludes the R < 1.0 leak
                                   ▼
 ②  STILL ACCUMULATING  ΔR over the trailing 30 min > 0.05      (excludes APOLLOHOSP-frozen)
                                   ▼
 ③  DIRECTION           CE if TF %chg > 0 else PE,  |chg| ≥ 0.3%
                        Supertrend(10,3) MUST agree
                                   ▼
 ④  BREAKOUT            opening-range breakout in the trade's direction
                                   ▼
 ⑤  TRADEABILITY        options premium pool ≥ ₹20 Cr
                        + existing: spread ≤ max, one lot ≤ capital budget, chaotic-open guard
                                   ▼
 ⑥  RANK                by TF R-Factor desc; tie-break ΔR₃₀, then Since-9:45 freshness
                                   ▼
                        picks → auto-trade → commentary

 EXIT (see §3a)         stop 1.0% of entry = 1R;  NO fixed target;
                        2R trailing stop;  square-off 15:12;
                        ONE full stop ends the trading day
```

### Measured result (3 sessions, one entry per name per day, 1% stop, 2R trail)

| Rule | n | win% | avg R | ₹/trade | ₹/day @2 |
|---|---|---|---|---|---|
| **This design** | 9 | **89%** | **+1.187** | **₹2,968** | **₹5,936** |
| same, without the breakout + premium filters | 18 | 61% | +0.840 | ₹2,100 | ₹4,200 |
| App engine, actual picks | 14 | — | **−0.199** | −₹498 | **−₹995** |

`n = 9` is very thin — see §6. The result is reported because its *shape* (few, small losses; wins
allowed to run) matches the benchmark in §3a, not because nine trades settle anything.

### Ablation — every component earns its place except one

| Variant | avg R | t | Verdict |
|---|---|---|---|
| Full rule | +0.774 | 3.56 | — |
| without Supertrend | +0.494 | 2.22 | **keep** (−0.28R without it) |
| without ΔR₃₀ | +0.627 | 2.81 | **keep** (−0.15R without it) |
| with top-8 concentration cap | +0.787 | 3.38 | **drop** — costs a candidate/day, adds nothing |
| premium filter alone, no TF core | +0.260 | 1.83 | TF core does the work |

### Threshold stability — not a knife-edge fit

| Premium pool ≥ | ₹6Cr | ₹8Cr | ₹10Cr | ₹12Cr | ₹15Cr | ₹20Cr |
|---|---|---|---|---|---|---|
| avg R | +0.697 | +0.650 | +0.787 | +0.821 | +0.801 | +1.110 |
| t | 3.44 | 2.88 | 3.38 | 3.43 | 3.17 | 4.17 |
| win% | 63% | 66% | 72% | 75% | 73% | 81% |

Every value from ₹6 to ₹20 Cr holds t ≈ 2.9–4.2 — a stable plateau, not a knife-edge fit.
**₹20 Cr is chosen** because it is the level at which the win rate reaches the operator's target
(§3a) while staying inside that plateau; it is the top of the tested range, so it must be treated
as the most fitted of the thresholds and re-checked first as live sessions accumulate.

### Rejected candidates, with reasons

- **VWAP confirmation** — dilutes. Supertrend alone +0.227R; Supertrend+VWAP +0.187R. Every
  Supertrend-only variant beat its both-must-agree counterpart.
- **"Since 9:45 > 0" as a hard gate** — slightly harmful on its own (+0.402 → +0.366). It helps only
  as a *band* (0, 2%): alive but not yet spent. Kept as a **ranking tie-break**, not a gate, because
  as a gate it drops candidates to 6/2/2 per day.
- **Top-N concentration cap** — redundant once the premium filter is applied (see ablation).
- **Rank-climb magnitude as the sort key** — a name climbing 190 places into R 1.4 is noise. Sort by
  absolute R, as `race.ts` already does.

## 3a. The exit model — where the operator's benchmark actually makes its money

The operator supplied TradeFinder's Sensibull-verified daily P&L, 23 sessions (2026-07-09 →
2026-08-10). Expressed in R at our ₹2,500 per-lot risk unit:

```
ALL FOUR losing days:  −0.14R   −0.98R   −0.94R   −0.84R
Winning days:           3.5 4.1 4.8 5.4 5.4 5.5 6.2 6.2 6.4
                        6.4 6.8 6.8 7.3 7.6 7.9 8.4 8.8 9.6
```

| | |
|---|---|
| Winning days | 19 / 23 = **82.6%** |
| Net | **+₹2,85,911** |
| Avg winning day | +₹15,430 |
| Avg losing day | **−₹1,812** |
| **Worst day in 23 sessions** | **−₹2,460** |
| Win : loss size | **8.5 : 1** |
| Profit factor | **40.4** |

**He has never lost more than 1R in a day.** Winners run to 5–9R. Every exit timestamp is
15:31–16:02 IST — he holds to the close and does not take a 2R profit at 11:00.

The 82.6% win rate is **not the strategy**; it is a by-product of two rules:

> **1. One full stop ends the day. 2. Let winners run to the close.**

Our engine does the opposite: it caps every winner at 2R and permits a second loss the same day
(`dailyLossHaltRupees` ₹5,000 = two full stops). Measured on our own TF-race candidates, one entry
per name per day:

| Exit model (1% stop) | n | win% | avg R | ₹/trade | best trade |
|---|---|---|---|---|---|
| fixed target 1:2 (today's model) | 18 | 61% | +0.700 | ₹1,750 | 2.0R (capped) |
| hold to close, no target | 18 | 56% | +0.747 | ₹1,866 | **6.4R** |
| **trail 2R, no fixed target** | 18 | 61% | +0.840 | ₹2,100 | **6.4R** |
| **trail 2R + breakout + prem ≥ ₹20 Cr** | 9 | **89%** | **+1.187** | **₹2,968** | 3.0R |

The fixed target caps the best available trade at exactly 2.0R. Removing it surfaces a 6.4R winner
in the same three sessions. **The target was truncating the trades that pay for the losers.**

### Exit decisions

1. **No fixed profit target.** Replaced by a **2R trailing stop** — the stop advances to
   (favourable extreme − 2R) once the trade is 2R onside, never loosens, and the existing 15:12
   square-off still terminates everything.
2. **Daily loss halt drops ₹5,000 → ₹2,500.** One full stop ends the day, matching the benchmark's
   observed discipline. This intentionally contradicts the current `CLAUDE.md` note that
   `dailyLossHaltRupees` must stay *above* `maxRiskPerLotRupees` — that note assumed a fixed-target
   system where a second trade could recover the first. With winners uncapped, protecting the
   day's remaining optionality is worth more than a revenge trade. **`CLAUDE.md` must be updated in
   the same change**, or the next reader will treat this as a bug.
3. **Spot stop widens 0.35% → 1.0%** (`MIN_RISK_PCT`). For a near-ATM option (delta ≈ 0.5, premium
   ≈ 2% of spot) a 1% adverse spot move ≈ a 25% premium loss — so this **aligns the spot stop with
   the 25% premium stop already in force**. At 0.35% the spot stop fires roughly three times sooner
   than the risk policy the operator actually chose, and the tighter unchosen stop wins. Measured:
   win rate 42% → 74% and ₹625 → ₹2,184 per trade, both improving.
4. **One entry per symbol per day** — already the rule; the replay now honours it so backtest and
   live agree.

### THETA — the one thing this backtest does not model

Grading walks the **spot** path. Holding an option to 15:12 pays a **full day of time decay**, which
a spot path cannot see. The benchmark's record proves the approach survives theta *for him*; our
numbers do not prove it for us. Concretely: the "hold to close" rows above are **optimistic by an
unmeasured amount**, and the effect grows the longer a position is held — precisely the change
being made here.

Mitigation, in order: (a) paper mode measures real premiums from day one, so the theta gap becomes
visible within days; (b) the 2R trailing stop exits winners on a real reversal rather than at
15:12 wherever possible; (c) `scripts/replay-tf-selector.ts` reports spot-R and, where option
snapshots exist, premium-R side by side and **refuses to report a single blended number**.

## 4. Architecture

| Module | Change | Responsibility |
|---|---|---|
| `lib/tf-live/selector.ts` | **new** | **Pure.** (board, baseline, prior board, candles-derived context) → ranked candidates. No I/O, no clock, so replay and live run byte-identical logic — the discipline `scoring.ts` and `grade.ts` already keep. |
| `lib/tf-live/race.ts` | extend | Add `getTfRaceRunnersAt(date, asOfMin)`: the point-in-time form. The existing `getTfRaceForWindow` display function is unchanged. |
| `lib/trade-suggest/engine.ts` | change | Candidate source swaps from the quote-row sweep to the TF selector. Plan building, premium attachment, storage unchanged. |
| `lib/trade-suggest/config.ts` | change | Add `TF_*` constants; remove `MIN_RFACTOR`, `MIN_CONFIDENCE`, `MIN_OI_LEVEL`, `MIN_NSE_OI_PCT`, `MIN_TURNOVER_SCORE` from the decision path. |
| `lib/auto-trade/decision/*` | change | Mechanically unchanged (it consumes scanner picks). Prompt context swaps App R for TF R + ΔR₃₀ + board age. |
| `lib/ai-commentary/generate.ts` | change | Narrates TF R and its slope in finished English. Same rule as `describeOptionChain`: **never hand the model a bare OI/R number** — the dry-run bench caught it turning `callOiChangePct: 74.3` into a fabricated price claim. |
| `scripts/replay-tf-selector.ts` | **new** | The proof harness. Re-runs every session with TF captures; prints n, avg R, ±SE, t, win%, per-day counts, rupee P&L at 1 lot, and its own caveats. |
| `scripts/verify-tf-selector.ts` | **new** | CI bench. Pure assertions on the selector: frozen-R rejected, R<1 unreachable, stale board → zero picks, direction/Supertrend agreement, threshold arithmetic. |

### Interfaces

```ts
// lib/tf-live/selector.ts — pure, no imports from db/env/clock
export interface TfSelectorInput {
  boardNow:  { symbol: string; rFactor: number; pctChange: number | null }[]; // ranked desc
  boardAgo:  Map<string, number>;   // symbol → R-Factor ~30 min earlier
  baseline:  Map<string, number>;   // symbol → rank at the 09:35 baseline board
  context:   Map<string, {          // per symbol, from candles + /live recording
    supertrendUp: boolean | null;
    premValueCr: number | null;
    sinceEntryPct: number | null;
  }>;
}
export interface TfCandidate {
  symbol: string; side: 'CE' | 'PE';
  tfRFactor: number; tfRankNow: number; tfRankAtBaseline: number;
  deltaR30: number; tfPctChange: number; sinceEntryPct: number | null;
  premValueCr: number;
}
export function selectTfCandidates(input: TfSelectorInput, cfg: TfSelectorConfig): TfCandidate[];
```

Each rejection carries a named reason so `/trade-suggest` reports **why** a board produced nothing —
the same discipline the existing `gated.*` counters keep.

## 5. Failure handling

**TF board older than 10 minutes → zero picks.** No fallback to the App engine (that is the −0.199R
system). The reason is surfaced on `/trade-suggest` and `/auto-trade`, not swallowed.

This matters because TradeFinder signs this account out roughly daily, **including mid-session**: on
2026-08-10 captures ran cleanly until 12:10 IST, then 263 consecutive requests returned
`TOKEN_ERROR: UNAUTHORISED` for 3h20m. A stale board is exactly how you buy a name that stopped
accumulating an hour ago.

Open positions are unaffected: premium SL/target, spot plan and the 15:12 square-off run under the
existing deterministic position guard, which never read R-Factor and runs with the LLM down.

## 6. Honest limits

These belong in the harness output, not just this document.

1. **Three sessions, and the headline cell is n = 9.** TF captures begin 2026-08-08 and **cannot be
   backfilled** — TF is live-capture only. The sample grows one session per day and nothing faster.
   Nine trades cannot establish an 89% win rate; the true rate could plausibly be anywhere from 50%
   to 95%.
2. **Roughly 100 rule variants were tested on those three days.** At that many comparisons, a t of
   3–5 arises by chance routinely. Treat every threshold in §3 as *fitted*. What is trustworthy is
   (a) the t = −11.12 anti-rule (TF R < 1.0 loses), the only unambiguous result here, and (b) the
   *direction* of each component, which was consistent across every cut.
3. **Theta is not modelled** — see §3a. This is the largest single unknown, and it works against the
   change being made (holding longer costs more decay).
4. **Spot R ≠ option P&L** more broadly: the bid-ask is real, fills are not guaranteed at the mark,
   and a market entry can fill above the ask. No rupee figure in this document is a profit forecast.
5. **The benchmark is not a like-for-like comparison.** The Sensibull record is *daily totals* at an
   unknown capital base, lot count and trade frequency; the ₹2,500 risk unit used to express it in R
   is **ours, not his**. What transfers is the *shape* — losses capped near 1R, winners uncapped —
   not the rupee magnitudes.
6. **`oi_intraday` covers only 99–109 symbols/session**, not all 206 — the premium-pool figure exists
   only for names that appeared in a `/live` watchlist section. Names without it are rejected (missing
   evidence is never a pass).

## 7. Rollout

1. Build selector, exit changes and both benches; full CI gate green (`lint`, `typecheck`,
   `typecheck:scripts`, `verify-dependency-hygiene`, all `verify-*`).
   **Update `CLAUDE.md` in the same change** for the `dailyLossHaltRupees` inversion (§3a decision 2)
   and the `MIN_RISK_PCT` widening — both contradict text currently in that file.
2. Run `scripts/replay-tf-selector.ts`; publish the scorecard with its caveats.
3. Deploy with `mode = paper`. Real picks, simulated fills at real live quotes, no money at risk.
4. **Paper mode is the theta experiment.** It records real option premiums at entry and exit, so
   after ~5 sessions the spot-R vs premium-R gap (§3a) is measured rather than assumed. This is the
   single most important number to watch and the main reason not to skip paper.
5. Promote to `approval` mode only once the live sample agrees with the replay *and* the theta gap
   is known. `live` mode additionally needs `AUTO_TRADE_LIVE_ENABLED=true` — the existing two-key
   rule is untouched.

**Stop rule for the rollout itself:** if paper trading over ~10 sessions does not clear roughly
+0.4R per trade after real premiums, the entry signal did not survive contact with option pricing.
Revert rather than re-tune — the thresholds are already fitted to three days, and tuning them again
on ten more would repeat the mistake that produced the current engine.

Kill switch: reverting `USE_TF_SELECTOR` to `false` restores the current engine, so the change is
one setting away from rollback at any point.

## 8. Out of scope

- The `/live` page keeps showing App R-Factor as a **column**. It simply stops deciding anything.
- `lib/r-factor/` is not deleted — `/live`, `/r-factor-history` and the EOD snapshot still use it.
- Premium stop policy, position sizing, risk gates and the square-off are untouched.
