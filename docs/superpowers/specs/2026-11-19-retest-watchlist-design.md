# Retest watch-list (order-block first-retest entries) — design

Date: 2026-11-19 · Operator decisions in brainstorming: fix "/trade-commentary is dumb" (no clear call, says nothing
useful) **and** add order-block.com-style retest entries; watch-list with triggers; eligibility = 6 fitting checks;
code triggers, AI confirms; exit chosen by Claude (operator: "I don't know"); "no assumptions and hardcodings".

## Why

Two weeks of prod: 1 day in 8 had any pick. TradeFinder data was missing on several days and, when present, the 10
breakout checks rarely all pass — so every 5-min read was "stand aside". A retest plan gives a concrete call *before*
anything happens ("if a candle trades back into ₹a–b before <window end> → buy CE, stop ₹c").

## Rules (every number has a source)

| Piece | Rule | Source |
|---|---|---|
| Eligibility | `selectTfCandidates` with `RETEST_TF_SELECTOR_CONFIG`: TF ① climbing, ② moving, options pool, not chasing (stretch), in OI/active list, Supertrend veto | the existing selector; differs from the breakout config ONLY in `requireBreakout`, `requireTfBeacon`, `maxSinceEntryPct`, `rejectMoveProfiles` (CI-pinned) |
| Zone | latest live order block on the trade's side, confirmed inside the entry window | `lib/order-blocks` engine; window = auto-trade settings `entryStartMin`/`entryEndMin` |
| Trigger | first completed 5-min candle after confirmation that trades into the zone | the engine's own `retested` event |
| Actionable | only the first scan after the trigger candle closes (≤ one bar length), and price still **inside** the zone | `FYERS_BUCKET_SEC`; "inside the zone" = what the replay filled at |
| Stop | the zone's far edge | order-block.com: "just beyond the far side of the block" |
| Target | `TARGET_RR` × risk | the one reward:risk constant spot plans already use |
| Exit | the existing guard: spot stop / spot target / 15:12 square-off | unchanged code (`spotExitReason`) |

Statuses: waiting · triggered · missed (late or price left the zone) · broken (closed through, or price at/through the
stop) · expired (not revisited before the window end / session end).

Price comparisons in the order-block engine use ₹0.01 (one paisa): the finest unit any NSE price is quoted in. Per-stock
exchange ticks are not in our master data, so no tick is assumed.

## Flow

`buildTfSelection` also returns `retestCandidates` → `buildRetestWatchlist` (scanner, each 5-min cycle) →
`base.retestWatchlist` + `ob_retest_watchlist` table → triggered items join `tfBySymbol` and `tfSelection.selected`
(`kind: 'retest'`, so TF provenance accepts them) → same depth/liquidity, option resolution and premium pipeline →
plan = `retestSpotPlan` → `entryKind: 'retest'` pick → AI (`retestCall`, prompt section "RETEST PICKS") → normal gates.

The trader prompt now ends every read with a clear call: on a no-entry pass the Bottom line names the waiting/triggered
watch-list calls word for word.

`/trade-commentary`: "Retest watch-list" card (`GET /api/order-blocks/watchlist`), window and target shown from the
stored meta, never from literals.

## Evidence and limits

`scripts/measure-order-block-entries.ts` (17 sessions, spot only, no option decay/costs): first-retest entries are
fewer (most zones are never revisited before 11:00) and lumpy; with a 2R target they were positive in both halves.
Not proven. Paper mode; every trade carries `entryKind` so breakout vs retest paper P&L can be compared.
