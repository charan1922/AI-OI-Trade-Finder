# Priority Refresh Implementation

## Status

As of 2026-07-21, PRs #8 through #14 were promoted from `main` to `prod` through
production PR #13.

The release contains two different kinds of behavior:

1. A real safety rule that can block unsafe new entries.
2. Shadow calculations that only measure a proposed faster refresh plan.

No software change can guarantee profits or remove market risk.

## Real behavior: stale-candle entry protection

`BLOCK_STALE_AUTO_ENTRY` is ON by default and was confirmed ON in production on
2026-07-21.

Before a new Auto Trade entry, the application checks the exact five-minute equity
candle that should already be complete. The entry is allowed only when that candle
exists and was refreshed after its closing time.

The authoritative check runs for:

- AI `check_order`;
- AI `place_entry_order`;
- human approval placement.

It does not block:

- exits;
- stop movement;
- position guards;
- reconciliation;
- forced square-off.

If the candle is missing, old, or was saved while still forming, the new entry is
rejected with a reason similar to:

> latest completed 5-min candle is stale — new entry blocked; exits/guards unaffected

The suggestion scanner also attaches candle-freshness metadata. That metadata is
informational only. Its database read is best-effort: a temporary read failure is
logged, represented as stale/missing, and cannot abort the complete Auto Trade pass.
Placement still performs the strict authoritative recheck.

## Shadow behavior: proposed reduced refresh list

`PRIORITY_REFRESH_SHADOW` is ON by default and was confirmed ON in production on
2026-07-21.

Every eligible five-minute cycle, after the Auto Trade decision, the application
builds a proposed smaller refresh list and stores the result for analysis.

The proposed plan contains:

- **Tier 0:** open/risk-bearing positions and earlier suggestions. These are always
  included and do not consume Tier 1 capacity.
- **Tier 1:** a fair round-robin selection from five NSE feeds, capped at 40 unique
  stocks by default.
- **Tier 2:** the remainder of the full universe, for background processing.

The five feeds are:

1. NSE OI build-up;
2. NSE gainers;
3. NSE losers;
4. NSE most active by value;
5. NSE most active by volume.

The default planner considers the top 10 eligible names from each feed. It selects
rank-by-rank across feeds so one feed cannot consume the whole cap.

## Shadow behavior: active-sector promotion

`PRIORITY_ACTIVE_SECTORS_SHADOW` is ON by default and was confirmed ON in production
on 2026-07-21.

The shadow planner can reserve up to 10 of the 40 Tier 1 slots for stocks aligned
with strong bullish or bearish sectors. A stock can be promoted only when:

- it is already eligible on a mover feed;
- its own price direction agrees with the sector direction;
- the sector snapshot is valid and fresh;
- the promotion remains inside the Tier 1 cap.

The current sector source is the scanner's mover-feed candidate pool, not the full
F&O heatmap. This is suitable for measurement but is not the final sector-live data
source.

Sector data is produced in one cycle and consumed by the next cycle. The default
maximum age is 420 seconds: one five-minute cycle plus grace.

## Decision-path and database protections

- Shadow settings, sector reads, planning, and persistence happen after the real
  Auto Trade decision.
- Shadow work runs only when this process owned and completed the Auto Trade pass.
- Shadow failures are best-effort and do not fail the trading decision.
- Priority/sector retention deletes are skipped while Auto Trade capture is active.
- Invalid, missing, or future sector timestamps produce an empty marker instead of
  reviving older data.
- Sector snapshot replacement is atomic.

## What this release does not do

- It does not use the proposed 40-stock list for live waiting.
- It does not reorder live market-data requests.
- It does not reduce the current approximately 50–80-stock wait.
- It does not use sectors to change real stock selection.
- It does not make every scanner indicator completed-candle-only.
- It does not guarantee better trades or profits.

The real live flags remain hardcoded OFF and are intentionally absent from `/config`:

```text
USE_CAPPED_PRIORITY_REFRESH=false
PRIORITY_INCLUDE_ACTIVE_SECTORS=false
```
