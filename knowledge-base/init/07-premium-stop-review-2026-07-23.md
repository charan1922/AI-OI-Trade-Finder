# Premium-stop review — 2026-07-23

## Status and safety boundary

This review uses the full read-only production database clone pulled twice on
2026-07-23 (230 MB mid-morning, 260 MB after the close). Production was not
written to or reconfigured. No toggle was flipped and no setting was changed on
the live box.

The implementation described below is a **branch**, `fix/premium-stop-sized-to-option`,
pushed but not merged and not deployed. It is not active in production until it
is reviewed, merged, deployed, and its effective production setting is confirmed
on `/auto-trade`.

This document supersedes the stop-loss half of
`05-live-loss-review-2026-07-22.md`. That document's cash-target and
WebSocket findings still stand.

## Session results

2026-07-23 was the first profitable live session since 2026-07-15.

- SRF 2800 PE: −₹1,610
- ETERNAL 292.5 CE: never filled — broker rejected on margin shortfall of
  ₹1,275 against ₹16,157 available
- BAJAJ-AUTO 11200 CE: +₹900
- M&M 3240 CE: +₹1,130
- HEROMOTOCO 5150 CE: +₹1,065
- day total: **+₹1,485**

Cumulative across all nine completed live trades on record: **−₹6,924**.

All five entries were admitted by the momentum-breakout path, which was turned
ON at 23:43 IST on 2026-07-22 and had produced zero picks on the twelve
recorded days before that.

## The defect: nobody chose the stop widths

Until this change the premium stop was `max(fill × 0.6, fill − ₹1500 ÷ lotSize)`
— the tighter of a 40% backstop and a flat rupee budget per lot. The rupee
branch always won.

Because F&O lot sizes range 75–700 units, `₹1,500 ÷ lotSize` produces a
different *percentage* for every contract. The effective stop across the nine
completed live trades:

| Stop width | Stock | Lot | Result |
|---|---|---|---|
| 7.7% | INDUSINDBK | 700 | −₹1,785 |
| 8.1% | AXISBANK | 625 | −₹1,344 |
| 9.2% | NESTLEIND | 500 | −₹1,725 |
| 9.4% | POLYCAB | 125 | −₹2,056 |
| 11.7% | COLPAL | 275 | −₹1,499 |
| 16.1% | BAJAJ-AUTO | 75 | +₹900 |
| 17.0% | SRF | 200 | −₹1,610 |
| 20.6% | HEROMOTOCO | 150 | +₹1,065 |
| 23.8% | M&M | 200 | +₹1,130 |

Every stop under 12% lost. Both stops above 20% won. None of those widths was a
decision; each fell out of the lot size.

## Why a tight premium stop fails independently of the trade thesis

An option re-prices on three inputs the underlying does not carry: time decay,
the post-open implied-volatility cool-off, and the bid-ask spread paid on exit.
A stop narrower than that combined noise band measures the contract breathing,
not the idea failing.

Measured on SRF's own guard snapshots: the option's bid ranged ₹36.10–₹45.05
during a 6.5-minute hold — **20.3% of the entry price** — while the underlying
was close to flat.

## Proof case — SRF 2800 PE, 2026-07-23

Entry ₹44.05 at 09:55:47, stop ₹36.55 (17.0%), exit ₹36 at 10:02:21, −₹1,610.

The decision log at 10:01:48 records the underlying at 2798.9 against an entry
of 2797.9. At that instant:

- the underlying had travelled 1 point of the 21.8 required to invalidate the
  setup — 4.6% of the way to the spot stop
- the option had given up ₹5.85 of its ₹7.50 stop budget — **78% of the way to
  the premium stop**

Thirty-three seconds later the bid printed ₹36.10 against the ₹36.55 stop and
the guard exited. The last traded price at that same snapshot was ₹36.85, above
the stop; only the bid was below it.

The directional call was correct. From `fyers_candles` the underlying fell to
2615.6 by 14:55 — 175 points — and from `rfactor_v2_option_snapshots` the same
contract was bid **₹178.45 at 14:50**. A 25% stop sits at ₹33.04; the lowest bid
recorded in the entire session was ₹36.10, so it would never have been touched.

That ₹178.45 bid is a **₹26,880/lot maximum favorable move** — what the contract
*offered*, not what the exit policy would have taken. The auto-trader holds to a
~₹1,100 cash target, so a surviving SRF books **≈₹1,100**, not ₹26,880. The point
this proves is exact and narrow: the tight stop fired on the contract's own noise
and flipped a would-be winner into a −₹1,610 loss. It does **not** show that a
wider stop harvests the whole move — do not cite ₹26,880 as an expected result.

## Secondary finding — entry slippage silently enlarges the risk

The stop is computed from the scanner's quote, but the fill lands higher, and
the stop is not recomputed. Actual risk therefore exceeds planned risk on every
trade:

| Date | Stock | Planned risk | Actual risk |
|---|---|---|---|
| 2026-07-17 | AXISBANK | ₹1.60 | ₹2.40 (+50%) |
| 2026-07-22 | NESTLEIND | ₹2.25 | ₹3.00 (+33%) |
| 2026-07-20 | COLPAL | ₹4.75 | ₹5.45 (+15%) |
| 2026-07-23 | SRF | ₹6.80 | ₹7.50 (+10%) |

**Addressed in the PR #18 review round** (see below): the entry gate now sizes
capital and per-lot risk off the **best ask** (the price a market BUY lifts), and
`applyEntryFill` re-anchors the stop to the **actual fill** and raises a critical
alert + risk latch when that fill pushed the lot above the approved budget. The
planned figure is now an ask-based number, and any excess the market fill added
on top is measured and surfaced rather than hidden.

## Implementation on `fix/premium-stop-sized-to-option`

- `OPTION_STOP_PCT = 25` — the stop is a flat percentage of the option's own
  entry price, independent of lot size (`stopPremiumForFill()` in
  `lib/auto-trade/backstops.ts`)
- `MAX_RISK_PER_LOT_RUPEES = 2500` — the per-lot rupee budget becomes a sizing
  filter. `risk/gates.ts` refuses a contract whose risk at the stop exceeds it;
  the stop is never tightened to fit
- both are runtime-tunable on `/auto-trade`: `optionStopPct` (10–40),
  `maxRiskPerLotRupees` (₹1,000–₹10,000)
- `dailyLossHaltRupees` default raised ₹3,000 → ₹5,000. At ₹2,500 of per-lot
  risk, a ₹2,500 halt ends the session after a single full stop. **The stored
  production value is still ₹2,500 and has not been changed.**
- `backstopsFromProposalFill()` now recovers the stop *width* from the proposal
  (`slPremium ÷ entryPremium`) exactly as it already recovered the cash target,
  so changing `optionStopPct` while an approval is pending cannot move a level a
  human already approved
- `lib/trade-suggest/premiums.ts` applies the same rule to the suggested stop
  and warns when a lot exceeds the per-lot budget
- `app/trade-suggest/history` no longer re-caps historical rows at today's
  budget; each row grades against the stop it was actually run under
- bench `scripts/verify-auto-trade.ts` 34 → 50 checks

## PR #18 review round (follow-up hardening)

A detailed code review of the branch raised six points; the valid ones were
implemented on the same branch:

- **Capital + broker-funds gates priced off the ask.** They used to size off the
  ltp/mid *mark*; a market BUY lifts the ask, so the mark understated the cash
  committed and could permit an order the executable price pushes over budget.
  Now `perLotCost` on both the AI path (`tools/execute.ts`) and the approval
  path (`approval.ts`) is `ask × lotSize`, matching the per-lot risk ceiling. The
  slippage-vs-scan check stays mark-to-mark on purpose — it measures *drift*, and
  folding the spread into it would trip on wide-but-stable books.
- **The approved risk ceiling is snapshotted on the trade.**
  `approvedMaxRiskPerLotRupees` is written at proposal time; the post-fill breach
  check compares the actual fill against *that* number, not the live setting, so
  an operator changing `maxRiskPerLotRupees` between gate and fill can neither
  hide a real breach nor manufacture a false one. A genuine breach now also
  **activates the risk latch** (blocks further entries, never forces an exit —
  the open position stays guarded), not just an alert.
- **The two new controls are on `/auto-trade`.** `Stop width (%)` and
  `Max risk/lot (₹)` are editable cap fields; the page shows the biggest lot cost
  that still fits (`maxRisk ÷ stop%`) and warns when the daily loss halt is at or
  below max risk/lot. Previously these were editable only by a direct API call.
- **Honest labelling.** The scanner scorecard still targets ₹5,000/lot while the
  live auto-trader targets ~₹1,100 cash — two different reward policies, now
  called out (see the SRF note above). `maxRiskPerLotRupees` is described as
  *planned* premium risk (before exit slippage, fees and taxes), not a guaranteed
  maximum loss. `OPTION_STOP_PCT = 25` is documented as a calibrated starting
  point from a 9-trade in-sample set, not a proven universal stop.
- **Replay reframed** as a fill-price sensitivity analysis (below).

Not done (deliberately): a full risk-policy snapshot (approved ask/askQty/policy
version) and a marketable-limit entry to hard-cap fill risk. The single-column
ceiling snapshot achieves the correctness fix; the rest is a larger design change
and the marketable-limit swap trades a fill guarantee for a no-fill risk on a
protective entry — an operator decision, not a review fix.

## Replay verdict

Reproducible with `npx tsx scripts/replay-premium-stop.ts`. It is a **fill-price
sensitivity analysis, not an exact replay of the production gate**: it decides
allow/refuse from each trade's *actual fill* against the ₹2,500 ceiling, whereas
production gates on the *pre-order ask*, the ask quantity, and the runtime
settings at that moment. A trade whose ask-risk sat just under the ceiling but
whose market fill nudged it over would be *allowed-and-latched* by production yet
labelled *refused* here. It uses `auto_quote_snapshots` and
`rfactor_v2_option_snapshots`.

- allowed under the new rule: 4 — the three winners unchanged, plus SRF, which
  survives its stop and is never re-tested for the rest of the session
- refused as too large a lot: 5 — those five actually returned −₹8,409
- previously stopped out, would now survive: 1

Attribution honesty: the current production capital cap (₹16,570) already blocks
2 of those 5 refusals (AXISBANK ₹18,469, INDUSINDBK ₹19,425). The new per-lot
risk gate is uniquely responsible for **3 refusals, worth −₹5,280 of realized
loss avoided**.

### Limits that bound every number above

1. n = 9 completed live trades over 5 sessions.
2. Full-day option prices exist only for 2026-07-23, so "what happened after the
   real exit" is answerable for SRF and no other trade.
3. Lot cost and the old stop width are the same underlying variable — a large
   lot received a tight stop *because* ₹1,500 divided by a large lot size is
   small. "Refused the losers" and "tight stops lost" are one finding observed
   twice, not two independent confirmations.
4. Refusing a trade also forgoes whatever it might have won. All five refusals
   in this sample were losses; that is a property of the sample, not a guarantee.

## Configuration drift observed on 2026-07-23

Ten settings differ from their coded-safe defaults. Four experimental admission
paths were enabled at 23:43 IST on 2026-07-22 with no replay evidence, and two
safety gates were disabled at 09:34–09:35 IST on 2026-07-23, fifteen minutes
before the first scan.

| Changed (IST) | Setting | Stored | Safe default |
|---|---|---|---|
| 21-Jul 10:54 | `SCAN_OUTSIDE_WINDOW` | ON | OFF |
| 22-Jul 10:01 | `MAX_PICKS` | 10 | 7 |
| 22-Jul 16:20 | `WINDOW_END_MIN` | 12:45 | 11:00 |
| 22-Jul 23:43 | `USE_BREAKOUT_BYPASS` | ON | OFF |
| 22-Jul 23:43 | `USE_EXTENDED_TREND_BYPASS` | ON | OFF |
| 22-Jul 23:43 | `USE_RANK_CLIMB_GATE` | ON | OFF |
| 22-Jul 23:43 | `USE_MOMENTUM_BREAKOUT` | ON | OFF |
| 23-Jul 09:34 | `USE_CHAOTIC_OPEN_GATE` | OFF | ON |
| 23-Jul 09:35 | `EXCLUDE_EXTENDED` | OFF | ON |
| 21-Jul 10:55 | `entryEndMin` (auto-trade) | 12:15 | 11:00 |

The 12:15 entry override flagged in `05-live-loss-review-2026-07-22.md` is still
in place and was not acted on.

## Toggle audit

Requested during this session. **No toggle was removed and none should be**,
on current evidence.

### `USE_EXTENDED_TREND_BYPASS` — keep

It emits the marker `extended-trend bypass admitted it`, and searching that
marker across all 125 recorded suggestions returns **23 admissions across 8
days** (10, 13, 14, 15, 16, 17, 20 July). Of the 18 with retained price data the
average best move in the trade's direction is **+2.40%**, including PATANJALI
15-Jul at **+11.49%** and ABB 16-Jul at **+7.77%**. It also admitted COLPAL
20-Jul, which became a −₹1,499 loss.

It is unreachable in the *current* configuration only because it lives inside
the `EXCLUDE_EXTENDED` branch and that gate was switched OFF on 23-Jul at 09:35.
That is a configuration state, not dead code. A toggle left ON whose parent rule
is OFF reads as a live permission and is not one.

*(Correction: an earlier pass in this session reported zero admissions for this
toggle. That measurement searched for the wrong marker text and was wrong.)*

### `USE_BREAKOUT_BYPASS` — keep for now, but make it measurable

Enabled only since 22-Jul 23:43, so 23-Jul is its single candidate day. Its
unique slice over the momentum path is narrow: both require a confirmed
opening-range breakout with Supertrend and VWAP aligned, and the bypass still
requires R-Factor ≥ 3.6, which is the ordinary gate. Only a strong-R breakout
that has moved **less than 1.5%** from the open needs the bypass specifically.

At most three 23-Jul picks fit that shape (TORNTPHARM stop, JSWSTEEL target,
DIVISLAB stop — net 0R), and that is an inference, because **this path writes no
reason marker at all**. Its admissions are invisible in the Trade Log. It cannot
be evaluated until that is fixed.

### `AUTO_SHUTDOWN` — not unused

It has zero `getToggle()` call sites in TypeScript but is read directly from
SQLite by `deploy/box/autostop.sh`. Do not remove it on a grep result.

## Recommended operating decisions

1. Merge and deploy `fix/premium-stop-sized-to-option`, then confirm
   `optionStopPct` and `maxRiskPerLotRupees` on `/auto-trade`.
2. Raise the stored `dailyLossHaltRupees` from ₹2,500 to at least ₹5,000, or a
   single full-stop loss will halt the session.
3. Watch for the failure mode this change can cause: larger individual losses
   (~₹2,200 rather than ~₹1,500) **without** a matching improvement in winners.
   If that appears, lower `optionStopPct` — do not restore a ₹/lot squeeze.
4. Resolve the `USE_EXTENDED_TREND_BYPASS` / `EXCLUDE_EXTENDED` combination.
   Note that re-enabling `EXCLUDE_EXTENDED` would have blocked HEROMOTOCO on
   23-Jul (+₹1,065), which entered at +3.47% from the open.
5. Add a reason marker for breakout-bypass admissions before judging that
   toggle, and surface an explicit warning when a bypass is enabled while its
   parent gate is disabled.
6. ~~Recompute the premium stop from the **actual fill** rather than the scanner
   quote, to remove the 10–50% silent risk inflation documented above.~~ **Done in
   the PR #18 review round:** the gate sizes off the ask and `applyEntryFill`
   re-anchors to the actual fill and latches on a budget breach.
7. Keep several thousand rupees of margin headroom above the lot cost. Two picks
   have been lost to shortfalls of ₹1,275 (ETERNAL 23-Jul) and ₹1,909
   (SONACOMS 17-Jul).
8. Review the still-active 12:15 entry-window override.

No configuration is battle-proof and no code can guarantee profit. Nine trades
over five sessions is a small sample, and the two supporting findings behind
this change are correlated rather than independent.
