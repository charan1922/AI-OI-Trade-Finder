# "Don't chase" — 7th TF Climbers check (design)

Date: 2026-10-09 · Approved by the operator the same day ("go ahead").

## Problem

On 2026-10-09 the auto-trader bought COLPAL and TCS calls after the move was already made:

| Trade | 09:15 candle ÷ normal day | Moved from prev close ÷ normal day | Result |
|---|---|---|---|
| COLPAL 1860 CE (09:57) | 1.62× | 2.92× | −₹4,001 (chart stop) |
| TCS 2200 CE (10:36) | 1.54× | 2.37× | −₹2,351 (chart stop) |

"Normal day" = 10-session average daily range (ADR) from the official NSE bhavcopy high/low.

The existing "not extended" check measures only from the 09:45 candle, so a move made between
09:15 and 09:45 was invisible to it.

## Rule

Refuse an entry when EITHER:

1. **Long opening candle** — the 09:15 candle's range ≥ **1.25 × ADR**; or
2. **Already ran** — (price − previous close), in the trade's direction, ≥ **2.0 × ADR**.

Missing evidence (no ADR baseline, no 09:15 candle) **rejects** — the house fail-closed rule.

## Why these numbers

Every good entry we have sits below both limits; the two chase entries sit above both:

| Entry | 09:15 candle | From prev close | Verdict |
|---|---|---|---|
| COLPAL 10-09 | 1.62 | 2.92 | blocked |
| TCS 10-09 | 1.54 | 2.37 | blocked |
| JUBLFOOD 10-08 (+2R) | 1.02 | 1.85 | passes |
| ITC 10-08 | 0.78 | 1.80 | passes |
| ADANIGREEN 10-08 | 0.70 | 1.56 | passes |
| ADANIENT 10-08 (TF's trade) | 0.44 | 1.34 | passes |
| ADANIPORTS 10-08 | 0.53 | 1.33 | passes |
| RELIANCE 10-06 | 0.21 | 0.90 | passes |

On 1,458 historical 30-min ORB breakouts (20 sessions, spot only) the rule blocks 11 (0.8%), which
won 6 of 11 on spot. The rule is therefore an **operator rule** backed by option-side evidence (both
blocked trades bled while the stock went flat), not a proven spot edge. It stays measured:
`scripts/measure-stretch.ts` keeps reporting option P&L by stretch.

## Out of scope

EICHERMOT 10-09 (−₹970) is NOT caught: it was less stretched than JUBLFOOD (+2R) on every measure,
so any stretch rule that blocks it also blocks a winner. Its failure (stock flat after entry) is the
next, separate item.

## Design

- `lib/tf-live/stretch.ts` — `Stretch` gains `fromPrevCloseAdr` (direction-aware, ADR units).
- `lib/tf-live/selector.ts` — `TfSymbolContext.stretch` becomes REQUIRED (every builder must supply
  it, enforced by the compiler); new config `maxFirstCandleAdr: 1.25`, `maxFromPrevCloseAdr: 2.0`;
  check ⑥ after "not extended"; rejection keys `stretchUnknown` and `chasing`; a passing candidate's
  reasons say how far it had moved.
- Context builders — the live engine (money path), the recorded builder (/live card) and the replay
  all compute `stretch` from `loadDayBaselines()` + today's candles + the decision price.
- `lib/tf-live/board-view.ts` — 7th gate `notChasing` ("not chasing"); `firstNeed` explains which
  limit failed with the measured number.
- Previous-close freshness (added in self-review): the newest daily bar must be at least as recent
  as the newest earlier session in our own candle store (`MAX(date) FROM fyers_candles WHERE date <
  today`, index-covered, 1 ms). If the overnight bhavcopy sync missed a session, the baseline is
  refused and the check fails closed instead of measuring against an older close.
- `auto_trades.entryFromPrevCloseAdr` — stored alongside the three existing stretch columns, so the
  measurement reads the rule's own metric.

## Tests (CI: `scripts/verify-tf-selector.ts`)

- Each limit, each boundary (exactly 1.25 / 2.0 rejects), missing baseline and missing 09:15 candle
  reject with their own counters.
- The real numbers in the table above: COLPAL and TCS blocked, every 8 Oct / 6 Oct entry passes.
- "All dots green ⇔ the selector picks it" re-proven over every combination with the 7th check.
