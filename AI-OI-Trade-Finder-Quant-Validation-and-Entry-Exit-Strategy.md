# AI OI Trade Finder — Quant Validation and Entry/Exit Strategy Review

**Repository:** `charan1922/AI-OI-Trade-Finder`  
**Latest reviewed commit:** `7795c49360ccb89bf8b0f716ca9f02e054e3509d`  
**Primary safety batch reviewed:** `5ebff323ddd3be4c7bd2593fc1873270a9db6bb8`  
**Review date:** 20 July 2026

---

# 1. Executive Verdict

The recent safety work is meaningful and several earlier recommendations are now implemented:

- Broker quantities are parsed strictly.
- Malformed broker position data is no longer treated as flat.
- Broker-wide position discovery exists.
- Risk incidents can latch and block new entries.
- Quote blindness is detected and escalated.
- The position guard now targets a 10-second cadence.
- Premium targets use executable bid rather than LTP alone.
- One entry attempt per AI pass is code-enforced.
- A recent `check_order` ALLOW is required before placement.
- Exchange-session verification fails closed.

However, the strategy is **not yet a coherent live 1:2R system**.

The main reasons are:

1. The scanner creates a 2R **spot** plan.
2. The live premium target is independently fixed at ₹5,000 per lot.
3. The premium hard loss is capped around ₹1,500 per lot.
4. The spot plan is stored from scanner time and is not rebuilt using fresh underlying spot immediately before placement.
5. A late fill can therefore have far worse forward reward-to-risk than the stored plan shows.
6. Several other exit rules can close the trade before the 2R target.
7. Option premium does not move linearly with the underlying.

The most important quant improvement is not simply changing the target number. It is:

```text
Recalculate the entire trade geometry at the actual entry moment.
```

The recommended hierarchy is:

```text
Fresh spot structure = strategy thesis
Premium cash stop = emergency account protection
Realized cash R = performance measurement
```

For late-entry control, the strongest immediate metric is:

```text
How far has the underlying already moved in R
between scanner selection and actual placement?
```

For exits, replace isolated rules with a deterministic state machine covering:

- Emergency loss protection.
- Structural invalidation.
- Thesis deterioration.
- No-progress/time exits.
- R-based profit protection.
- Structure/ATR trailing.
- Planned target.
- EOD square-off.

---

# 2. Latest Code Cross-Check

## 2.1 Implemented and validated in code

| Area | Status | Quant/operational meaning |
|---|---|---|
| Strict broker quantity parsing | Implemented | Missing or malformed quantity is not silently treated as zero |
| Negative quantity handling | Implemented | Unexpected short positions are visible and block automated SELL |
| Excess quantity handling | Implemented | Automation refuses to blindly exit an unexplained larger position |
| Partial broker position handling | Implemented in normal exit sizing | SELL quantity is reduced to the verified venue quantity |
| Full position-book read | Implemented | Broker-to-DB orphan discovery is possible |
| Risk latch | Implemented | New entries can be halted after reconciliation or guard incidents |
| Guard quote health | Implemented | Repeated quote failure becomes degraded/blind state |
| Stale spot detection | Implemented | Old candle data does not drive spot exits |
| Fast guard cadence | Implemented | `FAST_GUARD_TICK_MS = 10_000` |
| Executable bid target | Implemented | Premium target no longer fires only because LTP printed above target |
| One entry call per pass | Implemented | AI cannot place two entries in the same pass |
| Check-before-place | Implemented | Same-symbol, recent ALLOW is required |
| Session verification | Implemented | Holiday/session state must be positively verified |
| Immutable Docker image tag | Implemented | SHA image tag provides a rollback identity |

## 2.2 Still incomplete or unsafe

| Area | Status | Main concern |
|---|---|---|
| Partial-fill lifecycle | Not safe enough | Local trade can be closed while residual venue quantity may remain |
| Filled state without verified quantity | Not safe enough | Missing fill quantity can still be treated as a complete fill |
| Fresh spot plan at placement | Missing | Fresh premium is fetched, but underlying plan remains scanner-time |
| Deterministic anti-chase gate | Missing | No code gate on progress-R, breakout distance, or remaining reward |
| Coherent 1:2 policy | Missing | Spot and premium exits use different R definitions |
| Exit-state machine | Missing | Current exits are separate conditions rather than one explicit lifecycle |
| Isolated CI verification DB | Missing | Full auto-trade bench is not a required PR/main check |

---

# 3. Critical Execution Issue: Partial Fill Residual

The quantity hardening is useful, but the lifecycle still needs correction.

Example:

```text
Expected exit quantity: 75
Broker reports filled: 25
Possible broker residual: 50
Local result: trade may be marked closed
```

A risk latch can block new entries, but a locally closed trade is no longer returned as an open trade and therefore may stop receiving normal guard protection.

## Required quantity model

```ts
interface PositionQuantityState {
  entryQtyUnits: number;
  exitedQtyUnits: number;
  openQtyUnits: number;
}
```

Recommended states:

```ts
type PositionState =
  | 'opening'
  | 'open'
  | 'partially_open'
  | 'exit_pending'
  | 'partially_exited'
  | 'quantity_unknown'
  | 'closed';
```

The local row may become `closed` only after broker truth confirms:

```text
openQtyUnits === 0
```

For a partial SELL:

```ts
openQtyUnits = previousOpenQtyUnits - verifiedFilledQtyUnits;
status = openQtyUnits > 0 ? 'partially_exited' : 'closed';
```

The residual position must remain:

- Visible on the auto-trade page.
- Included in `getOpenTrades()`.
- Included in stop/target monitoring.
- Included in exposure.
- Included in reconciliation.
- Blocked from an oversized retry.

For real brokers, a filled order with no verified filled quantity should become:

```text
quantity_unknown
```

until trade book or position book corroborates it.

---

# 4. Is 1:2R Working as Expected?

## Verdict

**No. The current system calculates a 2R spot target, but it does not execute as one consistent live 1:2R strategy.**

---

# 5. Current Spot 2R Plan

The scanner uses:

```text
entrySpot = scanner-time underlying LTP
slSpot = last completed 5-minute candle low/high,
         opening-range boundary,
         or minimum risk floor
targetSpot = entrySpot ± 2 × spot risk
```

Formula:

```ts
spotRisk = Math.abs(entrySpot - slSpot);
targetSpot = entrySpot + directionSign * 2 * spotRisk;
```

This is valid as a **scanner-time planned spot 2R setup**.

It is not automatically the actual live R:R.

---

# 6. Current Premium Risk/Target

After actual option fill, premium levels are re-anchored as:

```ts
slPremium =
  max(
    entryFillPremium * 0.60,
    entryFillPremium - 1500 / lotSize
  );

targetPremium =
  entryFillPremium + 5000 / lotSize;
```

Nominal cash relationship:

```text
₹1,500 risk : ₹5,000 target
≈ 1 : 3.33
```

This is not 1:2.

The premium stop may be tighter than ₹1,500 because the system uses the tighter of:

- A 40% premium stop.
- A ₹1,500-per-lot stop.

Therefore the planned premium target can be greater than 3.33R for certain option prices.

---

# 7. Core 1:2 Problem: Spot Plan Is Not Rebuilt at Placement

The placement flow refreshes:

- Option premium.
- Spread.
- Broker funds.
- Settings.
- Session state.
- Risk latch.
- Capital and daily caps.

But the persisted spot values remain:

```ts
entrySpot: pick.plan.entrySpot
slSpot: pick.plan.slSpot
targetSpot: pick.plan.targetSpot
```

These were created during the scanner pass.

A fresh underlying spot is not used to rebuild the plan immediately before placing the order.

## Example

Scanner plan:

```text
Entry spot: 1,000
SL:          990
Target:    1,020
Risk:         10
Reward:       20
Planned R:R: 1:2
```

The AI/tool flow takes time and the real entry occurs when spot is already 1,008.

The stored target remains 1,020 and the stored stop remains 990.

Actual forward geometry:

```text
Reward remaining = 1,020 - 1,008 = 12
Risk to old stop = 1,008 - 990 = 18

Actual forward R:R = 12 / 18 = 0.67
```

The database still displays a planned 1:2 structure, but the actual entry is approximately 1:0.67.

This directly explains the pattern:

```text
Entry after large move
→ normal pullback
→ old/tight stop hit
```

---

# 8. Other Reasons 2R Does Not Equal Realized 2R

## 8.1 Option nonlinearity

Option value depends on:

- Delta.
- Gamma.
- Implied volatility.
- Theta.
- DTE.
- Spread.
- Liquidity.

A 2R spot move does not guarantee a 2R option gain.

## 8.2 Multiple first-hit exit rules

The position can exit through:

1. Premium stop.
2. Premium ₹5,000 target.
3. Spot stop.
4. Spot target.
5. Supertrend reversal.
6. AI discretionary exit.
7. Premium breakeven trail after a 30% gain.
8. EOD square-off.
9. Manual exit.

This is a hybrid multi-exit strategy, not a fixed 2R strategy.

## 8.3 Trigger is not fill

The guard can detect a threshold, but the actual SELL fill is affected by:

- Bid/ask spread.
- Bid quantity.
- Market gaps.
- Network latency.
- Broker latency.
- Exchange queue.
- Partial fills.

The system can target 2R; it cannot guarantee an exact 2R fill.

## 8.4 Spot target currently uses completed candle data

Spot target/stop evaluation uses the latest fresh stored candle close.

That means:

- A target may be touched intrabar and reverse before the close.
- A stop may be touched intrabar but not confirmed by the completed close.
- Premium emergency stop may still fire independently.

The exact intended trigger semantics must be explicit:

```text
touch
1-minute close
5-minute close
deep-breach emergency
```

---

# 9. Better Risk/Target Architecture

## Recommended primary policy

```ts
targetPolicy = 'spot_structure_with_cash_backstop';
```

Meaning:

```text
Spot structure controls the strategy thesis.
Premium cash cap protects the account.
Realized cash R measures performance.
```

## 9.1 Primary strategy stop

Immediately before placement:

1. Fetch fresh underlying spot.
2. Fetch latest completed candles.
3. Recalculate ATR and structure.
4. Rebuild the spot stop.
5. Rebuild the spot target.
6. Verify the forward reward/risk.
7. Reject if the new structure is no longer valid.

## 9.2 Primary target

```ts
freshSpotRisk = Math.abs(freshEntrySpot - freshSlSpot);
freshTargetSpot =
  freshEntrySpot + directionSign * targetRR * freshSpotRisk;
```

For a 2R strategy:

```text
targetRR = 2
```

## 9.3 Premium cash stop

Retain an emergency account backstop:

```text
Exit when executable option bid reaches the maximum tolerated cash loss.
```

This is not the alpha stop. It is the disaster/capital stop.

## 9.4 Fixed ₹5,000 target

The fixed ₹5,000 target should not silently compete with the spot 2R target.

Choose one explicit policy:

```ts
type TargetPolicy =
  | 'spot_structure_with_cash_backstop'
  | 'premium_exact_r'
  | 'fixed_rupees'
  | 'hybrid_first_hit';
```

The audit/UI must display the selected policy.

## 9.5 Exact premium 2R alternative

For a premium-based 2R system:

```ts
premiumRiskPerUnit = entryFillPremium - slPremium;
targetPremium = entryFillPremium + 2 * premiumRiskPerUnit;
```

This produces a coherent planned premium R system.

But it may exit at a premium level that is unrelated to the underlying structure because IV and gamma can move the option independently.

For this OI/price-action strategy, the preferred baseline is:

```text
Spot structure target
+ premium cash-loss backstop
```

---

# 10. Better Long-Term Option Risk Model

The enterprise-grade model estimates the option premium at the underlying spot stop.

```text
Fresh spot SL
    ↓
Estimated option premium at that spot
    ↓
Expected cash loss
    ↓
Entry allowed only if expected loss is within budget
```

Formula:

```ts
expectedCashLoss =
  Math.max(0, entryPremium - estimatedPremiumAtSpotSL) * qtyUnits
  + estimatedTransactionCosts;
```

Then require:

```text
expectedCashLoss <= allowedCashRisk
```

Possible estimators:

1. Broker-provided delta/gamma/IV.
2. Black-Scholes or another option model with current IV.
3. Recent empirical option-to-spot sensitivity.
4. Conservative bounded delta estimate.

This must be replayed with historical spot and option quotes before live deployment.

---

# 11. Required R Metrics

Store:

```ts
interface TradeRMetrics {
  plannedSpotR: number;
  plannedCashR: number | null;
  entryProgressR: number | null;
  remainingRewardRAtEntry: number | null;
  triggeredAtR: number | null;
  realizedCashR: number | null;
  maeR: number | null;
  mfeR: number | null;
}
```

Recommended realized cash R:

```ts
realizedCashR =
  netRealizedPnlAfterCosts / initialCashRiskBudget;
```

Do not report “2R achieved” only because spot touched the target.

---

# 12. Why Late Entries Still Happen

The scanner currently classifies a name as extended when:

```text
absolute change from open >= 3%
```

Extended candidates are hard-excluded by default unless an experimental bypass is enabled.

This is useful but not sufficient.

A setup can still be late when:

- It moved 2.0%–2.9%, below the extended threshold.
- The breakout occurred 10–20 minutes earlier.
- Price is far beyond the breakout level.
- Price is far from VWAP.
- The last impulse candle is abnormally large.
- The AI/tool loop takes time while price continues moving.
- Option premium moved less than 4% but underlying reward geometry deteriorated.
- The remaining target distance is small.
- The old scanner stop becomes too far from actual entry.
- A normal pullback is enough to hit the stop.

The present execution slippage gate checks:

```text
fresh option premium vs scanner option premium
```

It does not check:

```text
fresh underlying vs scanner entry
progress in R
remaining reward in R
breakout age
distance from breakout
distance from VWAP
```

---

# 13. Strongest Immediate Anti-Chase Gate

At placement time calculate progress in the original plan.

For bullish trades:

```ts
plannedRisk = plannedEntrySpot - plannedSlSpot;

progressR =
  (freshSpot - plannedEntrySpot) / plannedRisk;

remainingRewardR =
  (plannedTargetSpot - freshSpot) / plannedRisk;
```

Mirror signs for bearish trades.

## Starting replay hypothesis

```text
Reject when:
progressR > 0.25
OR
remainingRewardR < 1.50
```

Meaning:

- Do not enter after price already travelled more than 0.25R from the planned entry.
- Do not enter when less than 1.5R remains to the original target.

These are experiment starting points, not proven production values.

Test:

```text
Maximum progress:
0.10R, 0.25R, 0.40R, 0.50R

Minimum remaining reward:
1.25R, 1.50R, 1.75R
```

---

# 14. Fresh Plan Recalculation

A better execution gate does not rely only on the old plan.

At `check_order` and again before placement:

```ts
const freshSpot = await fetchFreshUnderlyingSpot(symbol);
const latestBars = await fetchLatestCompletedBars(symbol);

const freshPlan = buildSpotPlan(
  side,
  freshSpot,
  latestBars,
  openingRange,
  currentBucket,
  stopOptions,
);
```

Then require:

```text
Fresh stop exists.
Fresh target exists.
Fresh stop risk fits account budget.
Fresh forward R:R meets the strategy minimum.
Fresh data is recent.
```

Do not simply move the old target higher after a late entry. That creates an unvalidated chase.

---

# 15. Breakout Distance Gate

Store the breakout level and calculate:

```ts
breakoutDistanceAtr =
  Math.abs(freshSpot - breakoutLevel) / atr5m;
```

Replay candidates:

```text
Maximum distance:
0.25 ATR
0.50 ATR
0.75 ATR
```

A candidate far beyond the breakout level is vulnerable to ordinary retest/pullback behavior.

The correct limit should be segmented by market regime.

---

# 16. VWAP Distance Gate

Calculate:

```ts
vwapDistanceAtr =
  Math.abs(freshSpot - sessionVwap) / atr5m;
```

Replay:

```text
Reject above:
1.0 ATR
1.25 ATR
1.5 ATR
```

This must not be blindly applied across all regimes. Strong trend days can remain far from VWAP.

---

# 17. Breakout Age Gate

Persist:

```ts
firstQualifiedAt
firstQualifiedSpot
firstBreakoutAt
breakoutLevel
firstSuggestedAt
```

Calculate:

```ts
breakoutAgeBars
moveSinceQualificationR
```

Suggested entry separation:

```text
Fresh breakout:
entry within 1–2 completed 5-minute bars.

Older breakout:
wait for retest/reclaim.
```

---

# 18. Separate Entry Modes

Do not treat every momentum setup as one strategy.

```ts
type EntryMode =
  | 'fresh_breakout'
  | 'breakout_retest'
  | 'trend_continuation';
```

## Fresh breakout

Requirements:

- Breakout just confirmed.
- Price is still close to the level.
- OI/trend remains aligned.
- Sufficient reward remains.
- No exhaustion profile.
- Spread and premium freshness pass.

## Breakout retest

Requirements:

- Pullback toward OR high/low, prior level, or VWAP.
- Level holds.
- Completed candle reclaims in trade direction.
- OI slope is stable or positive.
- Spread remains acceptable.

This is the preferred mode after the first impulse has already moved.

## Trend continuation

Separate strategy with:

- Strong trend regime.
- Persistent VWAP/Supertrend alignment.
- Wider structure/ATR stop.
- Shallower pullback requirement.
- Different trailing behavior.
- Independent replay scorecard.

Do not use a trend-continuation entry with the same tight last-candle stop used for a fresh breakout.

---

# 19. Exhaustion Features to Test

Potential features:

- Last candle range / ATR.
- Consecutive same-direction candles.
- Close location within candle.
- Wick ratio.
- Volume climax.
- OI slope deceleration.
- Price acceleration with flat OI.
- Gap from VWAP.
- Gap from breakout level.
- Option premium acceleration.
- Spread expansion.

Do not hard-block a large candle only because it is large. Strong trends also contain large candles.

Use a replayed exhaustion score.

---

# 20. Better Exit Strategy

A robust exit process should be an explicit deterministic state machine.

```text
Layer 0: Venue/account safety
Layer 1: Emergency premium stop
Layer 2: Structural spot invalidation
Layer 3: Thesis deterioration
Layer 4: Time/no-progress exit
Layer 5: Profit protection
Layer 6: Planned target
Layer 7: EOD square-off
```

---

# 21. Layer 0 — Venue and Account Safety

Must remain independent of AI:

- Position quantity truth.
- Partial-fill handling.
- Orphan detection.
- Unknown-order reconciliation.
- Quote-health monitoring.
- Guard heartbeat.
- No local close before verified flat.
- Broker-native protection where available.

---

# 22. Layer 1 — Emergency Premium Stop

For a long option:

```text
Use executable bid.
```

Purpose:

```text
Prevent the option loss from exceeding the account cash-risk budget.
```

This is the emergency stop, not the strategy thesis.

---

# 23. Layer 2 — Structural Spot Exit

For bullish trades, exit when the selected structure is invalidated.

Examples:

- Breakout closes back inside the opening range.
- Retest level fails.
- Fresh swing low breaks.
- Breakout base fails.

Mirror for bearish trades.

Trigger semantics must be explicit:

```text
Immediate touch
1-minute close
5-minute close
Deep-breach emergency
```

Recommended hierarchy:

- Premium emergency stop: immediate.
- Structural stop: fresh completed candle.
- Deep structural breach: immediate.
- Never act on stale candle data.

---

# 24. Layer 3 — Thesis Deterioration

Avoid exiting on one noisy indicator.

Candidate rule:

```text
Exit when at least 2 of 3 are true:

1. Price loses VWAP against the position.
2. Supertrend flips against the position.
3. Combined OI slope becomes materially adverse.
```

Additional confirmation:

- Sector reversal.
- Breakout grade becomes fakeout-risk.
- Persistent order-book imbalance reversal.
- Price returns below/above the breakout base.

Replay the score before production use.

---

# 25. Layer 4 — Time/No-Progress Exit

Momentum breakouts should show progress reasonably quickly.

Starting hypothesis:

```text
After 3 completed 5-minute bars:

if MFE < 0.25R
AND OI slope is flat/negative
AND price has not established beyond the breakout,
exit.
```

Replay:

```text
Time stop:
2, 3, 4, 5 bars

Minimum MFE:
0.15R, 0.25R, 0.40R
```

A time stop releases capital from a setup that is not working but has not reached the hard stop.

---

# 26. Layer 5 — R-Based Profit Protection

The current code moves the premium stop to entry after a 30% premium gain.

That is inconsistent because a 30% premium move can represent different spot R values depending on:

- Strike.
- Delta.
- Gamma.
- IV.
- DTE.

Use R-based progress.

## One-lot baseline

The current strategy enters one lot, so partial profit-taking is unavailable.

Test:

```text
State A — INITIAL
0R to +0.75R:
keep original structure stop.

State B — PROGRESS
At +1.0R:
protect near actual breakeven plus estimated costs,
only when a valid structure level supports the move.

State C — TRAILING
After +1.25R or +1.50R:
trail using completed structure or ATR.

State D — TARGET
At fresh 2R spot target:
submit exit using executable bid logic.
```

Do not automatically move to breakeven after a small gain. Early breakeven stops can convert large future winners into scratches.

---

# 27. ATR/Structure Trailing

For bullish trades:

```ts
atrTrail =
  highestCloseSinceEntry - atrMult * atr5m;
```

Test:

```text
ATR multiple:
0.75, 1.0, 1.25, 1.5

Activation:
1.0R, 1.25R, 1.5R
```

Alternative trail:

```text
Low of the last two completed candles
or
latest confirmed swing low
or
Supertrend line
```

Use only levels that tighten risk.

---

# 28. Layer 6 — Regime-Based Target Variants

A fixed target may not fit every regime.

## Weak/range regime

```text
Target: 1.25R–1.5R
Faster time stop
No runner
```

## Normal trend

```text
Target: 2R
Trail after 1R–1.25R
```

## Strong trend

```text
Target: 2.5R+
or no fixed target after 2R
Trail by structure/ATR
```

Do not enable regime adaptation without walk-forward validation. It can easily become overfitted discretion.

---

# 29. Optional Two-Lot Strategy

Only after quantity accounting is corrected and capital permits:

```text
Lot 1:
exit at 1R or 1.25R.

Lot 2:
trail toward 2R+.
```

Benefits:

- Pays the trade earlier.
- Preserves a runner.

Risks:

- More exposure.
- More transaction costs.
- Partial-position complexity.
- Potential breach of ₹60,000 capital cap.

This is not the immediate recommendation.

---

# 30. Immediate Implementation Priorities

## P0 — Quantity correctness

1. Add `entryQtyUnits`, `exitQtyUnits`, `openQtyUnits`.
2. Keep residual quantity open and guarded.
3. Require verified real-broker fill quantity.
4. Treat missing quantity as unknown.
5. Close only when broker verifies zero.

## P0 — Fresh spot plan

Before ALLOW and before placement:

```text
Fetch fresh spot.
Fetch latest completed candles.
Rebuild stop.
Rebuild target.
Recalculate actual forward R:R.
```

## P0 — Anti-chase gate

Add:

```ts
interface EntryFreshnessInput {
  plannedEntrySpot: number;
  plannedSlSpot: number;
  plannedTargetSpot: number;
  freshSpot: number;
  progressR: number;
  remainingRewardR: number;
  breakoutDistanceAtr: number | null;
  vwapDistanceAtr: number | null;
  breakoutAgeBars: number | null;
}
```

Start in shadow mode.

## P1 — Target-policy cleanup

Recommended baseline:

```text
spot_structure_with_cash_backstop
```

- Fresh spot 2R target.
- Premium cash hard stop.
- No competing fixed ₹5,000 first-hit target in the initial baseline.
- Store spot R and cash R separately.

## P1 — Exit state machine

```ts
type ExitManagementState =
  | 'initial'
  | 'progress'
  | 'breakeven_protected'
  | 'trailing'
  | 'exit_pending'
  | 'closed';
```

Record every transition with:

- Time.
- Spot.
- Executable option bid.
- R progress.
- Reason.
- Rule version.
- Quote freshness.

## P1 — Shadow time/thesis exit

Log:

- What current AI did.
- What deterministic time stop would do.
- What multi-signal thesis exit would do.
- Resulting MFE/MAE and realized R.

## P2 — Broker-native OCO protection

Where broker support is reliable:

- Protective stop.
- Target limit.
- OCO cancellation.
- Partial-fill quantity adjustment.
- REST/stream guard as backup.

---

# 31. Quant Validation Plan

No threshold should move directly from idea to autonomous live trading.

## 31.1 Additive variants

```text
A. Current baseline.
B. Baseline + fresh spot re-anchor.
C. B + progressR late-entry gate.
D. C + breakout-age/retest logic.
E. D + ATR stop floor.
F. E + time stop.
G. F + R-based trailing.
H. Alternative target policies.
```

Change one major component at a time.

## 31.2 Data to persist

```ts
interface QuantTradeSnapshot {
  firstQualifiedAt: string | null;
  firstQualifiedSpot: number | null;
  firstBreakoutAt: string | null;
  breakoutLevel: number | null;

  scanSpot: number;
  checkSpot: number | null;
  placementSpot: number | null;
  fillPremium: number | null;

  plannedSlSpot: number | null;
  freshSlSpot: number | null;
  plannedTargetSpot: number | null;
  freshTargetSpot: number | null;

  atr5m: number | null;
  vwap: number | null;
  progressRAtEntry: number | null;
  remainingRewardRAtEntry: number | null;
  breakoutDistanceAtr: number | null;
  vwapDistanceAtr: number | null;
  breakoutAgeBars: number | null;

  maeR: number | null;
  mfeR: number | null;
  realizedR: number | null;
  barsHeld: number | null;
  exitRule: string | null;
}
```

---

# 32. Late-Entry Diagnostics

Bucket trades by entry progress:

```text
<= 0R
0–0.25R
0.25–0.50R
0.50–1.00R
> 1.00R
```

Measure:

- Trade count.
- Win rate.
- Expectancy.
- Median realized R.
- Stop rate.
- Median MAE.
- Median MFE.
- Time to MFE.
- Target-hit rate.
- Pullback depth after entry.

This will directly confirm whether late entries are producing the losing pattern.

---

# 33. Stop-Quality Diagnostics

Measure:

```text
Stopped and never recovered.
Stopped, later reached 1R.
Stopped, later reached 2R.
```

A high rate of:

```text
Stopped, later reached 2R
```

indicates one or more of:

- Entry was too late.
- Stop was inside normal volatility.
- Last-candle stop was inappropriate for the setup.
- Trend continuation needs a wider stop.
- Breakeven/trailing activated too early.

---

# 34. Exit-Quality Diagnostics

Measure:

- MFE before exit.
- Realized R / MFE R.
- Profit given back.
- Time from trigger to broker fill.
- Bid target touches vs fills.
- Exit reason.
- Indicator state at exit.
- Whether price later reached target.
- Whether AI exit outperformed deterministic baseline.

A higher win rate alone is not enough.

The objective is:

```text
Maximum long-run expectancy
within the allowed drawdown and account risk.
```

---

# 35. Regime Segmentation

Segment results by:

- Trend/range regime.
- ATR percentile.
- Gap size.
- Entry time.
- Change from open.
- Progress R at entry.
- Breakout age.
- DTE.
- Spread.
- Sector alignment.
- OI slope.
- VWAP distance.
- Breakout distance.

Do not use one threshold across all segments until evidence supports it.

---

# 36. Walk-Forward Discipline

```text
Calibration period
    ↓
Freeze thresholds
    ↓
Unseen validation period
    ↓
Paper mode
    ↓
Approval-mode shadow
    ↓
One-lot controlled live rollout
```

Do not retune after every losing trade.

---

# 37. Acceptance Criteria

A new policy should show:

```text
No safety regression
Higher or equal expectancy
Lower late-entry stop rate
Lower adverse excursion
No material loss of best trend winners
Acceptable trade count
Equal or better decision/execution latency
```

Do not approve merely because:

- Win rate increased.
- Backtest profit increased on one day.
- One known loser was avoided.
- Commentary appears better.

---

# 38. Recommended Baseline to Test First

This is a replay/paper baseline, not an immediate live instruction.

## Entry

```text
1. Existing scanner gates pass.
2. Fresh underlying spot is loaded.
3. Latest completed candles are loaded.
4. Spot plan is rebuilt.
5. Reject if progress from original plan > 0.25R.
6. Reject if remaining reward < 1.5R.
7. Reject fresh-breakout mode when breakout age > two completed bars.
8. Older setup waits for retest/reclaim.
9. Existing spread, premium freshness, funds, session, latch, and cap gates pass.
```

## Stop

```text
Primary:
fresh structural spot stop with tested ATR floor.

Emergency:
executable premium bid reaches cash-loss cap.
```

Test ATR floor:

```text
0.0, 0.5, 0.75, 1.0 ATR
```

The current configuration uses:

```text
SL_ATR_MULT = 0
```

so no ATR volatility floor is active.

## Management

```text
Before +1R:
keep original structural stop.

At +1R:
protect near entry plus estimated costs when structure supports it.

After +1.25R:
trail by completed swing or ATR.

No progress after three bars:
exit if trend/OI confirmation is absent.
```

## Target

```text
Primary target:
fresh spot 2R.

Emergency loss:
premium cash cap.

Baseline removes:
competing fixed ₹5,000 first-hit target.
```

## Reporting

Display:

- Planned spot R.
- Actual entry progress R.
- Remaining reward R.
- Realized cash R.
- MAE R.
- MFE R.
- Exit rule.
- Trigger price.
- Actual fill price.

---

# 39. Final Quant Verdict

## 1:2R

The current implementation contains a scanner-time 2R spot target, but it is not a coherent live 1:2R system because:

- Entry spot is not refreshed at placement.
- Premium target is fixed ₹5,000.
- Premium risk and spot risk are different scales.
- Options are nonlinear.
- Multiple exits override the target.
- Trigger and fill are different.

## Late entry

The 3% extended filter helps but does not solve chase risk.

The strongest missing metric is:

```text
progress in R at actual entry
```

The system should reject a setup when forward reward has collapsed even if OI, Supertrend, VWAP, and breakout evidence still appear strong.

## Exit strategy

Recommended direction:

```text
Fresh structural plan
+ emergency premium cash stop
+ deterministic no-progress exit
+ multi-signal thesis exit
+ R-based profit protection
+ structure/ATR trailing
```

AI remains useful for discretionary early exits, but mandatory baseline management should remain deterministic, measurable, and replayable.

## Deployment order

```text
1. Fix quantity lifecycle.
2. Add fresh spot re-anchoring.
3. Record late-entry metrics in shadow mode.
4. Replay anti-chase thresholds.
5. Replay stop/exit variants.
6. Validate in paper and approval mode.
7. Use controlled one-lot live rollout.
```
