# TF Climbers cockpit (live-trading card on /live)

**Date:** 2026-10-08 · **Approved by:** the operator ("Approve, build it") · **Approach:** A of A/B/C — rebuild the card in place; Telegram alerts on TAKE changes (B) are the next, separate sub-project.

## Goal

Between 09:35 and 11:00 the card must answer, at a glance on a laptop or a phone, and while supervising auto-trade: **what to trade now, which side, why — and which names are close**. Today's card holds the right logic behind the wrong presentation (8–9px text, reasons only in hover tooltips, a 5-minute refresh against a once-a-minute board).

## Trading-rule changes (operator, 2026-10-08 — these DO touch the money path)

- **Race source = TF Intraday Boost** (`market_pulse.intraday_boost`), top 20 by R-Factor. Identical ranking to the full board (80/80), so picks are unchanged by the switch itself.
- **Breakout = our 15-min ORB (09:15–09:30) AND TF's breakout beacon** in the trade direction (BULL for CE, BEAR for PE). No beacon = reject. The 30-min ORB is recorded on every candidate as a shadow for a later comparison; the 15-min range is added for the TF selector only (stops, App R-Factor and spot plans keep the 30-min range).
- Entries 09:45–11:00 (unchanged rule; the card's "09:35" label was wrong). Measuring starts 09:35.
- The beacon cannot be replayed on history (stored beacons exist only for 2026-08-26 and 2026-10-07/08, and that August day has no usable board), so it is measured forward via the `noTfBeacon` rejection count.

## Non-goals

- Apart from the trading-rule changes above, thresholds, the 09:35 baseline and `TF_RACE_MAX_RANK` stay as they are.
- TF breakout beacon and sector strength are **display evidence only** — they gate, rank and size nothing (the standing rule: an unmeasured signal does not touch the money path).
- The Climbed Stocks card is unchanged. Telegram alerts are sub-project B.

## Data (display route `/api/tf/race`, additive fields)

Every existing field keeps its meaning; these are added per board row:

| Field | Meaning | Source |
| --- | --- | --- |
| `gates` | Five results in the selector's own order — `climbing` (ΔR30 > `minDeltaR`), `moving` (\|%\| ≥ `minAbsPctChange`), `breakout`, `pool` (premium ≥ `minPremValueCr`), `notExtended` (since-09:45 < `maxSinceEntryPct`). Each `true` / `false` / `null` (no data). | board + `buildRecordedTfContext`, same values the selector reads |
| `needs` | Plain-English text of the first failing gate, or null when all pass. | replaces `blockedBy` wording in the card |
| `trend` | `'faster'` / `'slower'` / `'steady'` / null — R-Factor gain over the last 15 min vs the 15 min before (±0.02 band = steady). Null without boards that far back. | boards of the day |
| `climbingSince` | IST minute the name's 30-min gain last rose above `minDeltaR` and stayed there, or null. | boards of the day |
| `rPath` | TF R-Factor at each board minute in the window (for a small sparkline). | boards of the day |
| `beacon` | TF breakout beacon `{ dir: 'BULL' \| 'BEAR', time: 'HH:MM' }` from the last `market_pulse` capture at or before the board, or null. Uses only `param_2` (direction) and `param_3` (time) — the other params are unconfirmed and not shown. | `market_pulse.breakout_beacon` |
| `sector` | `{ name, value }` — the stock's first industry basket (TF's basket order, skipping the broad NiFTY 50 / SENSEX / NIFTY MID SELECT / OTHERS) and that sector's TF value (a signed R-Factor, NOT a %), or null. | `sector_scope` board baskets + its `daily-index` list |

Route-level additions: `windowStartMin` / `windowEndMin` (09:35 / 11:00) for the client countdown.

**Consistency rule:** a row's five `gates` are all `true` exactly when `selectTfCandidates` picks that name (before the `maxCandidates` cap and before the stale/old-board verdict override). Pinned by a CI check.

**Cost:** the route re-parses every board capture of the day (~11 MB of JSON by the close) on every call. The whole response is cached in memory keyed by `(today, latest board capture, current IST minute)` — everything time-dependent (board age, verdict) has minute resolution — so a 30-second poll from several viewers costs at most one computation per minute. The unused per-runner daily screen (`screen`, no reader since the card switched to the board) is dropped from the route.

## Card (`app/live/_components/tf-race-card.tsx`)

```text
TF CLIMBERS   ● board 10:14   entry window closes in 46 min
TAKE
 [CE] UNIONBANK  +2.70%   R 3.99  ↑0.42/30m ▲faster   TF▲10:15   PSU BANK 3.25
      ●●●●●  climbing · moving · breakout · ₹86 Cr pool · not extended
WATCH  (most checks passed first)
 #8  TIINDIA   R 2.46 ↑0.33 ▼slower  -3.66%  ●●○●●  needs: opening-range breakout
 #10 FORCEMOT  R 2.23 ↑1.45 ▲faster  -4.38%  ●●●○●  needs: options pool ≥ ₹20 Cr (has ₹18)
STALLED (15) ▸  PETRONET 2.9 · ASTRAL 2.9 · …
```

1. **Refresh:** every 30 s from 09:15 to 15:30 IST on weekdays; every 5 min otherwise.
2. **Header:** board time (amber past `TF_BOARD_MAX_AGE_MIN`) and the entry window — "opens 09:35" / "closes in N min" / "closed". The two warning paragraphs become one line; the existing "not today" / "no picks from this board" notices stay, unchanged in meaning.
3. **TAKE:** large rows — side, symbol, %, TF R, 30-min gain with trend, beacon and sector chips, then the five dots with their names.
4. **WATCH** (was "Building · one gate away" — inaccurate, it meant "still climbing, fails something"): non-TAKE names whose R-Factor is still climbing, sorted by gates passed (desc), then TF R. Each shows the dots and a `needs:` line.
5. **STALLED:** collapsed, as today.
5a. **DROPPED — climbers never vanish** (operator, 2026-10-08: "show climbed stocks when active or not, not removed from the board like currently"). Any name that was **climbing inside TF's top 20** (30-min gain above `minDeltaR`) at any board since 09:35 but has **left the top 20** stays listed under **DROPPED**, with its climbing span and where it is now — e.g. `ADANIENT · climbing 10:12–10:41 · now #27, R 2.1 flat`. (A name still in the top 20 is already visible under TAKE / WATCH / STALLED, so it is not repeated.) Built from the day's boards alone, so it is cheap and survives a reload. Collapsed by default with a count, most recent drop first. The separate Climbed Stocks card is unchanged.
6. **Gate dots:** green = pass, hollow = fail, grey `?` = no data — **never green without evidence**. When verdicts are withheld (stale or old board), no row is TAKE and no dot strip is presented as a verdict: the strip still renders for the numbers, under the existing withheld notice.
7. **Tap a row** to expand its full numbers (what the tooltip held). The TradingView chart opens from a small icon on the row, not the whole row.
8. **Phone width:** each row wraps to two lines (identity + numbers / dots + needs); no horizontal scroll; no information available only on hover.

## Testing

- `lib/tf-live/board-view.ts` (new, pure): `gateStrip()`, `firstNeed()`, `rTrend()`, `climbingSince()`, `pickSector()`, `parseBeacon()`.
- `scripts/verify-tf-selector.ts` (runs in CI) gains checks:
  - **all five gates true ⇔ `selectTfCandidates` picks the name**, over mixed fixtures;
  - missing evidence gives `null`, never `true`;
  - trend faster / slower / steady / null, and `climbingSince` against hand-built boards;
  - sector picking skips broad baskets; beacon parsing accepts only BULL/BEAR + HH:MM.
- Route: the cache returns the same body for the same board minute and recomputes on a new one.
