# Order blocks on /trade-commentary + AI trader context — design

Date: 2026-11-19 · Source: operator's handoff `claude_orderblock_handoff.zip` (README spec v1.0, CLAUDE.md contract)
Operator decisions (2026-11-19): AI **considers** order blocks (advisory, not a code rule); trading stays **paper**;
the entry **stop-risk gate is switched off** (setting, not deleted); liquidity checks stay.

## What an order block is here

OUR documented rule set (`OB_ALGORITHM_VERSION = ob-v1.0-single-candle`), not a reconstruction of any vendor's
algorithm and not proof of an institutional order. On completed 5-min EQ candles:

- ATR(14), Wilder: seed = mean of the first 14 true ranges (bar 0 has none), then RMA.
- Swing high/low: strictly beyond 3 bars left and 3 right; ties reject; known only at the close of bar p+3.
- BOS at bar i: close crosses the latest UNUSED swing level known by the close of i-1 (`close[i-1] <= level < close[i]`,
  mirror for bearish), and the bar is a strong same-direction candle: body/range ≥ 0.60 and body/ATR[i-1] ≥ 1.5
  (hypotheses, not validated thresholds). A level is consumed by its first qualifying BOS.
- Origin: last opposite-colour candle within the 8 bars before the BOS, **same IST session** (doji excluded).
  Zone = its full high–low. No origin → `bos_no_origin`, no zone.
- Confirmation = the BOS bar's endMs. A zone does not exist before it.
- Lifecycle on later bars: overlap → `retested` (first time); close beyond the far edge → `invalidated` (wick alone
  doesn't); both on one bar → both events, final invalidated; live zones expire at their session's last close.
- Prices compared to the paisa (₹0.01 — the finest unit any NSE price is quoted in; per-stock exchange ticks
  are not in our master data, so none is assumed). One streaming core (`processClosedBar`) backs batch replay.

**Session rule added after a real-data check:** ALKEM 2026-11-09 produced a zone confirmed 09:20 from a 10:25 candle of
the previous day (the 8-bar lookback crossed the overnight gap). `originSameSession: true` stops that; ATR and pivots
still carry over as warm-up.

## Data

`fyers_candles` EQ bars (the recorder; up to one bar + one poller cycle behind → label `DELAYED` today,
`HISTORICAL` for past days), previous recorded session as warm-up. Since the Fyers Standard-plan budget only the
priority set (open trades + TF top 10) has fresh candles — exactly the names the commentary and trader discuss. No
extra Fyers calls. No CSV import / vendor adapter / market-wide scanner: the spec's full-universe scanner is not
possible inside 5,000 Fyers calls/day.

## Surfaces

1. `/trade-commentary`: each pick card → "Chart · order blocks": 5-min candles AS OF that read (`asOf`), zones as
   rectangles from origin to end, ▲/▼ OB marker on the confirming candle, the pick's Entry/SL/Target lines, click a
   zone → source candle, confirmation time, broken level, strength checks, state, invalidation rule.
   `GET /api/order-blocks?symbol&date&asOf` (any signed-in role, read-only).
2. AI trader: `orderBlocks` (`lib/order-blocks/read.ts`) on every pick and every held position — nearest live
   with-trade zone, nearest live opposite zone in the path, inside-zone flag, latest broken with-trade zone, and a
   plain-English `read`. The trader prompt frames it as context: avoid walking into a live opposite zone; a broken
   with-trade zone is thesis damage worth an exit review; never by itself a reason to enter; never overrides gates.
   The standalone narrator (`COMMENTARY_SYSTEM`) is unchanged.

## Entry stop-risk gate OFF

`ENTRY_STOP_RISK_GATE = false` (`lib/trade-suggest/config.ts`): no refusal for modelled loss at the chart stop
(> ₹2,500/lot or unmodellable); the scanner no longer writes that note into `liquidityWarning` (the AI reads a
non-null one as no-trade); the prompt drops "room to target beats risk to stop". Kept: spread, size at the ask,
slippage, stops on open trades, 15:12 square-off, daily limits, capital cap. Set true to restore.

## Verification

`scripts/order-block-checks.ts` (CI): ATR seed/recurrence, pivot causality and ties, no signal at the origin,
emission at the BOS close, zone bounds, retest/invalidation/same-bar precedence, bearish mirror, wick-only BOS,
one break per level, no-warm-up, no-origin, same-session origin, expiry, duplicate/out-of-order bars, streaming =
batch, replay at every t shows exactly the zones confirmed by t, and the AI read's with/against/inside/broken logic.
`scripts/premium-stop-checks.ts`: gate logic still tested with the switch on; switch-off allows over-budget risk
while liquidity refusals stay. Real data (local, 2026-11-09): 144 zones over 165 names, median 1 per name.

## Not done / next

- **Measurement before any promotion:** pair graded suggestions with the order-block read at or before entry (no
  lookahead) — does entering into / away from zones change R? Until then it stays advisory.
- Options-liquidity module, CSV import and the market-wide scanner from the handoff are not built (see Data).
