# Final Implementation Plan: Capped Priority Refresh with Sector-Aware Promotion

## 1. Goal

Reduce the delay between the start of each 5-minute market cycle and the Auto Trade AI decision.

Today, the poller may wait for roughly **50–80 unique priority symbols** before starting:

```text
Trade Suggest scan
→ Trade Commentary
→ Auto Trade AI decision
```

The new design will wait for a smaller, carefully selected set:

```text
Tier 0: risk-bearing and previously suggested symbols
Tier 1: maximum 40 unique fresh-first candidates
Tier 2: everything else continues in the background
```

The implementation must preserve:

- the complete scanner pool;
- all current strategy gates;
- open-position monitoring;
- reconciliation;
- stop, target, and square-off logic;
- full-universe background recording;
- immediate config-based rollback.

This feature must begin in **shadow mode only**.

---

# 2. Final Recommended Defaults

## Boolean settings

```ts
export const PRIORITY_REFRESH_SHADOW = true;
export const USE_CAPPED_PRIORITY_REFRESH = false;
export const BLOCK_STALE_AUTO_ENTRY = true;

export const PRIORITY_ACTIVE_SECTORS_SHADOW = true;
export const PRIORITY_INCLUDE_ACTIVE_SECTORS = false;
```

## Numeric settings

```ts
export const PRIORITY_PER_FEED = 10;
export const PRIORITY_MAX_UNIQUE = 40;

export const PRIORITY_SECTOR_RESERVED_SLOTS = 10;
export const PRIORITY_TOP_SECTORS_PER_SIDE = 2;
export const PRIORITY_SECTOR_MAX_AGE_SEC = 120;
```

## Meaning

```text
PRIORITY_REFRESH_SHADOW = ON
→ Calculate and record the reduced priority plan.
→ Live polling behavior remains unchanged.

USE_CAPPED_PRIORITY_REFRESH = OFF
→ Continue waiting for the current full priority set.
→ Safe production default.

BLOCK_STALE_AUTO_ENTRY = ON
→ Auto Trade cannot enter using an outdated 5-minute candle.
→ Exits and risk management remain unaffected.

PRIORITY_ACTIVE_SECTORS_SHADOW = ON
→ Measure sector-aware promotion in shadow.

PRIORITY_INCLUDE_ACTIVE_SECTORS = OFF
→ Sector promotion does not influence live capped selection yet.
```

---

# 3. Why 10 Per Feed Does Not Mean 10 Stocks

There are five independent candidate feeds:

```text
nse-oi
nse-gainers
nse-losers
nse-active-value
nse-active-volume
```

The planner considers up to:

```text
10 × 5 = 50 feed positions
```

But a hot stock can appear in several feeds:

```text
ABC
- OI rank 2
- Gainers rank 4
- Active Value rank 3
- Active Volume rank 6
```

ABC requires only one Fyers candle refresh.

Therefore:

```text
50 feed positions
→ deduplicated
→ maximum 40 unique Tier 1 symbols
```

The hard global cap is what guarantees a meaningful reduction.

---

# 4. Select Top 10 Only After Tradeability Filtering

The cap must be applied to the already-filtered `body.picks`.

## Wrong

```ts
const rawTop10 = rawNseRows.slice(0, 10);
const tradeable = rawTop10.filter(isTradeable);
```

This may leave only 4–6 usable names.

## Correct

```ts
const eligiblePicks = body.picks ?? [];
const considered = eligiblePicks.slice(0, perFeedLimit);
```

`body.picks` must already exclude:

```text
Non-F&O stocks
Index symbols
Avoid-band stocks
Stocks without a valid live futures contract
```

Meaning:

> Take the first 10 stocks that Auto Trade is actually allowed to consider.

---

# 5. Three-Tier Design

## Tier 0 — Always Fresh First

Tier 0 is never capped.

Include:

```text
Open positions
Risk-bearing trades
Orders in placing/submitted/part-filled states
Pending approvals that may become orders
Earlier Trade Suggest picks from today
```

Tier 0 symbols must remain first even if:

- they are no longer in an NSE movers list;
- they are absent from the current top sectors;
- they are not in the normal tracked universe;
- they are already extended;
- scanner entries are currently disabled.

Tier 0 is for continuity and risk management.

---

## Tier 1 — Maximum 40 Unique Fresh-First Candidates

Tier 1 is selected from:

```text
Five NSE candidate feeds
Optional active-sector promotion
Later: previous-cycle R-Factor
Later: rank climbers
```

Final Tier 1 maximum:

```text
PRIORITY_MAX_UNIQUE = 40
```

Tier 0 is outside this cap.

Expected wait group:

```text
Tier 0: approximately 2–8
Tier 1: maximum 40
Total: approximately 35–48 unique symbols
```

Compared with the current:

```text
Approximately 50–80 unique priority symbols
```

---

## Tier 2 — Background

Tier 2 contains:

```text
Remaining current mover candidates
Remaining full F&O universe
Remaining futures history work
Remaining futures depth/OI work
```

Tier 2 continues refreshing after the scanner and AI decision path is released.

Tier 2 symbols may remain visible to:

```text
Trade Suggest
Trade Commentary
Full-universe scanner
Replay storage
```

But Auto Trade entry is blocked if their latest completed candle is stale.

---

# 6. Fair Round-Robin Feed Selection

Do not process all OI names first and allow OI to consume the full cap.

Use this order:

```text
Round 1:
  OI #1
  Gainer #1
  Loser #1
  Active Value #1
  Active Volume #1

Round 2:
  OI #2
  Gainer #2
  Loser #2
  Active Value #2
  Active Volume #2

Continue until:
  each feed reaches rank 10
  OR
  Tier 1 reaches its allowed unique limit
```

Duplicates do not consume another slot.

## Suggested source order

```ts
const FEED_ORDER: PriorityFeed[] = [
  'nse-oi',
  'nse-gainers',
  'nse-losers',
  'nse-active-value',
  'nse-active-volume',
];
```

## Example implementation

```ts
function selectRoundRobin(
  feedPicks: Record<PriorityFeed, RankedFeedPick[]>,
  perFeedLimit: number,
  maxUnique: number
): string[] {
  const selected = new Set<string>();
  const ordered: string[] = [];

  for (let rankIndex = 0; rankIndex < perFeedLimit; rankIndex += 1) {
    for (const source of FEED_ORDER) {
      const pick = feedPicks[source][rankIndex];
      if (!pick?.symbol) continue;

      if (!selected.has(pick.symbol)) {
        if (selected.size >= maxUnique) return ordered;
        selected.add(pick.symbol);
        ordered.push(pick.symbol);
      }
    }
  }

  return ordered;
}
```

---

# 7. Sector-Aware Promotion

## Purpose

Use sector participation to prioritize stocks from sectors where money and direction are concentrated.

Do not add all stocks from a strong sector.

A stock qualifies for sector promotion only when:

```text
It is already present in at least one of the five active feeds
AND
It belongs to a qualified active sector
AND
Its direction agrees with the sector
```

Example:

```text
PSU Bank is strongly bullish.

SBIN:
- OI list
- Active Value list
- positive stock move
→ eligible for sector promotion

Another PSU bank stock:
- not present in any candidate feed
→ not added only because the sector is strong
```

---

# 8. Sector Promotion Must Stay Inside the Same 40 Cap

Do not increase Tier 1 from 40 to 50.

Reserve part of the 40 slots:

```text
Base round-robin slots: 30
Sector promotion slots: 10
Tier 1 maximum: 40
```

Config:

```ts
PRIORITY_MAX_UNIQUE = 40;
PRIORITY_SECTOR_RESERVED_SLOTS = 10;
```

Calculate:

```ts
const sectorSlots = Math.min(
  sectorReservedSlots,
  maxUniqueTier1
);

const baseSlots = maxUniqueTier1 - sectorSlots;
```

With defaults:

```text
Base slots = 30
Sector slots = 10
```

---

# 9. Sector Selection Flow

## Step 1 — Build Base 30

Use normal feed round-robin until:

```text
30 unique stocks
```

## Step 2 — Select Active Sectors

Pick up to:

```text
2 bullish sectors
2 bearish sectors
```

Config:

```ts
PRIORITY_TOP_SECTORS_PER_SIDE = 2;
```

## Step 3 — Promote Sector-Aligned Stocks

Inspect feed candidates not already in the base 30.

Promote up to 10 unique stocks that satisfy:

```text
Already present in at least one feed
Belongs to a selected active sector
Stock direction agrees with sector direction
Not already selected
Sector snapshot is fresh
```

## Step 4 — Fill Unused Sector Slots

If only 6 sector-promoted stocks qualify:

```text
Base selected: 30
Sector promoted: 6
Unused slots: 4
```

Continue normal round-robin and fill the final 4.

Final:

```text
Tier 1 = 40
```

## Fallback

If sector data is:

```text
missing
stale
failed
invalid
```

use ordinary round-robin for all 40 slots.

Sector data must never block a cycle.

---

# 10. Sector Qualification

Use F&O sector participation as the primary signal.

Each sector snapshot should include:

```text
Turnover-weighted percentage move
Total turnover
Advancers
Decliners
Advance ratio
Number of stocks
Snapshot time
```

## Bullish sector

Initial shadow rule:

```text
weightedPct >= +0.50%
advanceRatio >= 0.60
sector is in the high-turnover group
```

## Bearish sector

Initial shadow rule:

```text
weightedPct <= -0.50%
advanceRatio <= 0.40
sector is in the high-turnover group
```

## Turnover ranking

Do not use an absolute turnover number initially.

Rank sectors by total turnover and consider, for example:

```text
Top 6 sectors by total turnover
```

Then select:

```text
Top 2 qualifying bullish
Top 2 qualifying bearish
```

This supports both:

```text
CE opportunities
PE opportunities
```

---

# 11. Direction Agreement

A stock must agree with the sector.

## Bullish

```text
sector.direction = bullish
stock.retPct > 0
stock is present in:
  nse-gainers
  OR nse-oi
  OR active-value
  OR active-volume
```

## Bearish

```text
sector.direction = bearish
stock.retPct < 0
stock is present in:
  nse-losers
  OR nse-oi
  OR active-value
  OR active-volume
```

OI and active feeds may contain both bullish and bearish names.

Use the stock’s latest feed move/direction when available.

If stock direction is unclear:

```text
do not sector-promote it
```

It can still enter through normal round-robin.

---

# 12. Do Not Fetch Heatmap Data on the Critical Path

The priority planner must not synchronously call:

```text
/api/heatmap
/api/nse/heatmap
Dhan full-universe quote
NSE allIndices
```

before the scanner starts.

That would replace one latency problem with another.

Use a previously stored healthy sector snapshot.

Recommended design:

```text
Cycle N:
  start scan/AI after priority refresh
  then refresh sector snapshot in background

Cycle N+1:
  use the stored Cycle N sector snapshot
```

Maximum accepted age:

```ts
PRIORITY_SECTOR_MAX_AGE_SEC = 120;
```

If older than 120 seconds:

```text
skip sector promotion
use normal round-robin
```

---

# 13. Sector Snapshot Producer

Create a background producer that runs after capture release.

It may:

1. Fetch a Dhan quote batch for the mapped F&O universe.
2. Build stock tiles:
   - symbol;
   - sector;
   - previous-close move;
   - intraday move;
   - turnover.
3. Aggregate by sector.
4. Store the snapshot.
5. Never throw into the poller.

Use the existing shared Dhan rate gates.

Do not issue the sector quote concurrently with another forbidden Dhan endpoint call.

Recommended frequency:

```text
Once per 5-minute cycle
```

That is enough for next-cycle priority planning.

---

# 14. Optional Official NSE Confirmation

Official NSE sector indices may later be used as supporting evidence.

Example:

```text
F&O sector aggregate bullish
Official NSE sector index also bullish
→ stronger confirmation
```

Do not make official NSE confirmation mandatory initially because:

```text
Internal sector names may not map one-to-one to NSE index names
The NSE endpoint may throttle or be stale
Priority planning must remain resilient
```

Implement official confirmation only as optional metadata:

```ts
officialNsePct: number | null;
```

---

# 15. Modular Folder Structure

Create:

```text
lib/priority-refresh/
  config.ts
  types.ts
  build-plan.ts
  round-robin.ts
  sector-signal.ts
  sector-snapshot-store.ts
  freshness.ts
  telemetry.ts
  telemetry-store.ts
  index.ts
```

Later:

```text
lib/priority-refresh/
  previous-rfactor.ts
  rank-climbers.ts
```

---

# 16. Module Responsibilities

## `config.ts`

Exports:

```ts
PRIORITY_REFRESH_SHADOW
USE_CAPPED_PRIORITY_REFRESH
BLOCK_STALE_AUTO_ENTRY
PRIORITY_ACTIVE_SECTORS_SHADOW
PRIORITY_INCLUDE_ACTIVE_SECTORS

PRIORITY_PER_FEED
PRIORITY_MAX_UNIQUE
PRIORITY_SECTOR_RESERVED_SLOTS
PRIORITY_TOP_SECTORS_PER_SIDE
PRIORITY_SECTOR_MAX_AGE_SEC
```

---

## `types.ts`

```ts
export type PriorityFeed =
  | 'nse-oi'
  | 'nse-gainers'
  | 'nse-losers'
  | 'nse-active-value'
  | 'nse-active-volume';

export type PriorityTier = 0 | 1 | 2;

export type PriorityReason =
  | 'risk-bearing-position'
  | 'earlier-suggestion'
  | `feed:${PriorityFeed}`
  | 'active-sector'
  | 'previous-rfactor'
  | 'rank-climber'
  | 'background';

export interface RankedFeedPick {
  symbol: string;
  sector: string;
  source: PriorityFeed;
  eligibleRank: number;
  retPct: number | null;
}

export interface ActiveSectorSignal {
  sector: string;
  direction: 'bullish' | 'bearish';
  weightedPct: number;
  totalTurnover: number;
  turnoverRank: number;
  advanceRatio: number | null;
  stocks: number;
  officialNsePct: number | null;
  asOfMs: number;
}

export interface PrioritySymbol {
  symbol: string;
  sector: string;
  tier: PriorityTier;
  reasons: PriorityReason[];
  feedRanks: Partial<Record<PriorityFeed, number>>;
  feedReturns: Partial<Record<PriorityFeed, number | null>>;
  sourceCount: number;
  sectorPromoted: boolean;
  sectorDirection: 'bullish' | 'bearish' | null;
  sectorRank: number | null;
}

export interface PriorityPlan {
  version: 1;
  createdAtMs: number;

  perFeedLimit: number;
  maxUniqueTier1: number;
  sectorReservedSlots: number;

  tier0Symbols: string[];
  baseTier1Symbols: string[];
  sectorPromotedSymbols: string[];
  tier1Symbols: string[];
  tier2Symbols: string[];

  fullPrioritySymbols: string[];
  cappedWaitSymbols: string[];

  bySymbol: Record<string, PrioritySymbol>;
}
```

---

## `round-robin.ts`

Contains pure feed selection only.

```ts
export function selectRoundRobinCandidates(...): string[];
```

No database, provider, or AI calls.

---

## `sector-signal.ts`

Contains pure sector qualification and promotion logic.

```ts
export function selectActiveSectors(input: {
  snapshots: ActiveSectorSignal[];
  topPerSide: number;
  nowMs: number;
  maxAgeSec: number;
}): {
  bullish: ActiveSectorSignal[];
  bearish: ActiveSectorSignal[];
};

export function selectSectorPromotions(input: {
  remainingFeedCandidates: RankedFeedPick[];
  activeSectors: ActiveSectorSignal[];
  existingSymbols: ReadonlySet<string>;
  maxPromotions: number;
}): string[];
```

---

## `build-plan.ts`

Pure orchestration:

```ts
export function buildPriorityPlan(input: {
  feedPicks: Record<PriorityFeed, RankedFeedPick[]>;

  riskBearingSymbols: string[];
  earlierSuggestionSymbols: string[];

  fullPrioritySymbols: string[];
  fullUniverseSymbols: string[];

  perFeedLimit: number;
  maxUniqueTier1: number;

  activeSectors: ActiveSectorSignal[];
  sectorEnabled: boolean;
  sectorReservedSlots: number;
  topSectorsPerSide: number;
  sectorMaxAgeSec: number;

  nowMs: number;
}): PriorityPlan;
```

---

## `freshness.ts`

Defines the canonical candle-freshness rule.

```ts
export interface CandleFreshness {
  symbol: string;
  requiredBucketTs: number;
  latestBucketTs: number | null;
  fresh: boolean;
  ageBuckets: number | null;
}
```

---

## `sector-snapshot-store.ts`

Stores the newest healthy sector snapshot.

Use SQLite so it survives:

```text
deploys
process restarts
server restarts
```

Reads must be cheap.

Writes are best-effort.

---

## `telemetry.ts`

Builds cycle and symbol telemetry.

It must never delay or fail the trading path.

---

# 17. Candidate Snapshot Changes

Extend the existing candidate snapshot.

```ts
export interface CandidateSnapshot {
  discoveredAt: number;
  fullUniverse: boolean;

  // Complete scanner membership.
  sectorEntries: [symbol: string, sector: string][];

  // Complete OI evidence membership.
  oiSpurtSymbols: string[];

  // Existing full priority set.
  prioritySymbols: string[];

  // New ranked per-feed information.
  feedPicks: Record<PriorityFeed, RankedFeedPick[]>;
}
```

Important:

```text
Do not cap sectorEntries
Do not cap oiSpurtSymbols
Do not cap prioritySymbols
```

The cap applies only when building:

```text
proposed Tier 1
```

---

# 18. Candidate Discovery Pseudocode

```ts
const feedPicks = emptyFeedRecord();

for (const source of CANDIDATE_SOURCES) {
  const response = await fetchWatchlist(source);
  const eligible = response.picks ?? [];

  feedPicks[source] = eligible.map((pick, index) => ({
    symbol: pick.symbol,
    sector: pick.sector ?? '',
    source,
    eligibleRank: index + 1,
    retPct: pick.retPct ?? null,
  }));

  for (const pick of eligible) {
    addToFullScanPool(pick);
    addToFullPriority(pick);

    if (source === 'nse-oi') {
      addToOiEvidence(pick);
    }
  }
}
```

---

# 19. Priority Plan Algorithm

```ts
const tier0 = dedupe([
  ...riskBearingSymbols,
  ...earlierSuggestionSymbols,
]);

const sectorSlots = sectorEnabled
  ? Math.min(sectorReservedSlots, maxUniqueTier1)
  : 0;

const baseSlots = maxUniqueTier1 - sectorSlots;

const baseTier1 = selectRoundRobinCandidates(
  feedPicks,
  perFeedLimit,
  baseSlots
);

const activeSectors = sectorEnabled
  ? selectActiveSectors(...)
  : [];

const sectorPromoted = sectorEnabled
  ? selectSectorPromotions({
      remainingFeedCandidates,
      activeSectors,
      existingSymbols: new Set([...tier0, ...baseTier1]),
      maxPromotions: sectorSlots,
    })
  : [];

let tier1 = dedupe([
  ...baseTier1,
  ...sectorPromoted,
]);

if (tier1.length < maxUniqueTier1) {
  const fillers = selectRoundRobinCandidates(
    feedPicks,
    perFeedLimit,
    maxUniqueTier1,
    new Set(tier1)
  );

  tier1 = dedupe([...tier1, ...fillers]).slice(0, maxUniqueTier1);
}

const cappedWaitSymbols = dedupe([
  ...tier0,
  ...tier1,
]);

const tier2 = dedupe([
  ...fullPrioritySymbols,
  ...fullUniverseSymbols,
]).filter((symbol) => !cappedWaitSymbols.includes(symbol));
```

---

# 20. Poller Integration

Read settings once per cycle:

```ts
const [
  shadowEnabled,
  cappedLiveEnabled,
  blockStaleEntry,

  sectorShadowEnabled,
  sectorLiveEnabled,

  perFeedLimit,
  maxUniqueTier1,
  sectorReservedSlots,
  topSectorsPerSide,
  sectorMaxAgeSec,
] = await Promise.all([
  getToggle('PRIORITY_REFRESH_SHADOW', true),
  getToggle('USE_CAPPED_PRIORITY_REFRESH', false),
  getToggle('BLOCK_STALE_AUTO_ENTRY', true),

  getToggle('PRIORITY_ACTIVE_SECTORS_SHADOW', true),
  getToggle('PRIORITY_INCLUDE_ACTIVE_SECTORS', false),

  getNumberSetting('PRIORITY_PER_FEED', 10),
  getNumberSetting('PRIORITY_MAX_UNIQUE', 40),
  getNumberSetting('PRIORITY_SECTOR_RESERVED_SLOTS', 10),
  getNumberSetting('PRIORITY_TOP_SECTORS_PER_SIDE', 2),
  getNumberSetting('PRIORITY_SECTOR_MAX_AGE_SEC', 120),
]);
```

Build two plans when required:

```text
Live plan
Shadow comparison plan
```

## Live plan

When:

```text
USE_CAPPED_PRIORITY_REFRESH = OFF
```

continue waiting for the full existing priority set.

When ON:

```text
wait for Tier 0 + Tier 1 only
```

## Sector behavior

When:

```text
PRIORITY_INCLUDE_ACTIVE_SECTORS = OFF
```

the live capped plan uses ordinary round-robin.

When:

```text
PRIORITY_ACTIVE_SECTORS_SHADOW = ON
```

the shadow comparison plan includes sector promotion.

This lets sector promotion be measured separately before enabling it in live capped mode.

---

# 21. Poller Ordering

```ts
const ordered = dedupe([
  ...plan.tier0Symbols,
  ...plan.tier1Symbols,
  ...plan.fullPrioritySymbols,
  ...universe,
]);
```

## Wait set

```ts
const waitSymbols = cappedLiveEnabled
  ? plan.cappedWaitSymbols
  : plan.fullPrioritySymbols;
```

The full universe still appears later in `ordered`.

No symbols are dropped.

---

# 22. Shadow Mode

## Phase A — Membership Shadow

Keep existing live behavior.

Record:

```text
Current full priority count
Proposed Tier 0 count
Proposed base Tier 1 count
Proposed sector-promoted count
Proposed total wait count
Symbols inside/outside proposed cap
```

## Phase B — Realistic Timing Shadow

Order symbols as:

```text
Tier 0
Proposed Tier 1
Remaining full priority
Remaining universe
```

But still wait for the full priority set.

Record:

```ts
shadowReleaseMs =
  time when Tier 0 + proposed Tier 1 finished;

actualReleaseMs =
  time when full priority finished;

estimatedSavedMs =
  actualReleaseMs - shadowReleaseMs;
```

No live AI timing changes yet.

---

# 23. Candle Freshness

The scanner uses Fyers candles for:

```text
Setup score
Opening range
VWAP
Supertrend
ATR
Breakout checks
Stop construction
Target construction
```

Therefore, Auto Trade must not enter using an old completed candle.

## Required bucket

At cycle time:

```ts
requiredBucketTs =
  latest fully completed 5-minute bucket;
```

## Fresh

```text
latest stored EQ bucket >= required bucket
```

## Stale

```text
latest stored EQ bucket < required bucket
OR
no usable stored candle
```

---

# 24. Add Freshness to Suggestions

```ts
export interface SuggestionCandleContext {
  requiredBucketTs: number;
  latestBucketTs: number | null;
  fresh: boolean;
  ageBuckets: number | null;

  priorityTier: 0 | 1 | 2 | null;
  priorityReasons: PriorityReason[];

  feedRanks: Partial<Record<PriorityFeed, number>>;
  sectorPromoted: boolean;
  sectorDirection: 'bullish' | 'bearish' | null;
}
```

Add to:

```ts
export interface TradeSuggestion {
  // existing fields...
  candleContext: SuggestionCandleContext;
}
```

Derive this from the candle data already loaded by the scanner.

Avoid an additional query for every symbol.

---

# 25. Auto Trade Stale-Candle Gate

The AI prompt is not the safety mechanism.

Enforce the block in code.

Both:

```text
check_order
place_entry_order
```

already rebuild gate input.

Extend `EntryGateInput`:

```ts
export interface EntryGateInput {
  // existing fields...

  blockStaleAutoEntry: boolean;
  candleFresh: boolean;
  candleLatestBucketTs: number | null;
  candleRequiredBucketTs: number;
}
```

Gate:

```ts
if (input.blockStaleAutoEntry && !input.candleFresh) {
  reasons.push(
    `latest completed 5-minute candle is stale: ` +
    `required=${input.candleRequiredBucketTs}, ` +
    `latest=${input.candleLatestBucketTs ?? 'missing'}`
  );
}
```

---

# 26. Recheck Freshness at Placement Time

Do not trust only the scanner-time freshness stamp.

Inside `buildGateInput()`:

1. Recalculate the required completed bucket using current time.
2. Read the latest stored EQ bucket for the requested symbol.
3. Read the effective `BLOCK_STALE_AUTO_ENTRY` toggle.
4. Pass the result to `checkEntryGates()`.

This protects against:

```text
Scanner ran at 10:04:50
AI took 20 seconds
Placement happened after 10:05:00
New completed bucket is now required
```

`place_entry_order` must recheck and reject if freshness changed.

---

# 27. Stale Entry Gate Must Not Affect Exits

Never apply the stale-candle gate to:

```text
Order reconciliation
Broker truth reconciliation
Orphan-position detection
Premium stop
Premium target
Spot safety stop
Momentum exit
Square-off
Manual exit
Emergency exit
Approval rejection
```

It is only a new-entry gate.

Position management must continue even when all candles are stale.

---

# 28. Trade Commentary

Add to the trimmed pick context:

```ts
candleFresh
candleAgeBuckets
priorityTier
priorityReasons
feedRanks
sectorPromoted
sectorDirection
```

Add deterministic context:

> A pick with `candleFresh=false` is watch-only. Do not recommend entry. Code will reject placement even if the model asks.

Example:

```text
ABC is visible in the full scanner pool, but its latest completed
5-minute candle was not refreshed before this decision.

Watch only this cycle.
Auto Trade entry is blocked until fresh context is available.
```

---

# 29. Config Page

Category:

```text
Priority Refresh (Experimental)
```

## Toggles

```text
Shadow reduced priority refresh
Use reduced priority refresh live
Block stale-candle Auto Trade entries
Shadow active-sector promotion
Use active-sector promotion live
```

## Numeric settings

```text
Priority depth per feed = 10
Maximum unique Tier 1 stocks = 40
Sector-reserved Tier 1 slots = 10
Top sectors per side = 2
Maximum sector snapshot age = 120 seconds
```

---

# 30. Unsafe Config Combination Rules

Reject:

```text
USE_CAPPED_PRIORITY_REFRESH = ON
BLOCK_STALE_AUTO_ENTRY = OFF
```

Reject disabling stale block while capped mode is ON.

```ts
if (
  key === 'USE_CAPPED_PRIORITY_REFRESH' &&
  value === true &&
  !(await getToggle('BLOCK_STALE_AUTO_ENTRY', true))
) {
  throw new Error(
    'Enable stale-candle entry blocking before enabling capped priority refresh'
  );
}
```

```ts
if (
  key === 'BLOCK_STALE_AUTO_ENTRY' &&
  value === false &&
  (await getToggle('USE_CAPPED_PRIORITY_REFRESH', false))
) {
  throw new Error(
    'Cannot disable stale-candle entry blocking while capped priority refresh is enabled'
  );
}
```

Also validate:

```text
PRIORITY_SECTOR_RESERVED_SLOTS <= PRIORITY_MAX_UNIQUE
```

Clamp or reject invalid values.

---

# 31. Sector Snapshot Table

```sql
CREATE TABLE IF NOT EXISTS priority_sector_snapshots (
  date             TEXT    NOT NULL,
  bucketTs         INTEGER NOT NULL,
  sector           TEXT    NOT NULL,

  weightedPct      REAL    NOT NULL,
  totalTurnover    REAL    NOT NULL,
  turnoverRank     INTEGER NOT NULL,

  stocks           INTEGER NOT NULL,
  advancers        INTEGER NOT NULL,
  decliners        INTEGER NOT NULL,
  unchanged        INTEGER NOT NULL,
  advanceRatio     REAL,

  officialNsePct   REAL,
  source           TEXT    NOT NULL,
  createdAt        TEXT    NOT NULL,

  PRIMARY KEY (date, bucketTs, sector)
);
```

Indexes:

```sql
CREATE INDEX IF NOT EXISTS
idx_priority_sector_snapshots_latest
ON priority_sector_snapshots (date, bucketTs DESC);
```

Retention:

```text
20 trading sessions
```

---

# 32. Priority Cycle Telemetry

```sql
CREATE TABLE IF NOT EXISTS priority_refresh_cycles (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  date                     TEXT    NOT NULL,
  bucketTs                 INTEGER NOT NULL,
  planVersion              INTEGER NOT NULL,

  shadowEnabled            INTEGER NOT NULL,
  cappedLiveEnabled        INTEGER NOT NULL,
  blockStaleEntry          INTEGER NOT NULL,

  sectorShadowEnabled      INTEGER NOT NULL,
  sectorLiveEnabled        INTEGER NOT NULL,

  perFeedLimit             INTEGER NOT NULL,
  maxUniqueTier1           INTEGER NOT NULL,
  sectorReservedSlots      INTEGER NOT NULL,

  universeCount            INTEGER NOT NULL,
  scanPoolCount            INTEGER NOT NULL,
  fullPriorityCount        INTEGER NOT NULL,

  tier0Count               INTEGER NOT NULL,
  baseTier1Count           INTEGER NOT NULL,
  sectorPromotedCount      INTEGER NOT NULL,
  cappedWaitCount          INTEGER NOT NULL,

  cappedFreshCount         INTEGER NOT NULL,
  actualReleaseMs          INTEGER,
  shadowReleaseMs          INTEGER,
  estimatedSavedMs         INTEGER,

  suggestionCount          INTEGER NOT NULL DEFAULT 0,
  suggestionsOutsideCap    INTEGER NOT NULL DEFAULT 0,
  staleSuggestionCount     INTEGER NOT NULL DEFAULT 0,
  staleEntryBlockCount     INTEGER NOT NULL DEFAULT 0,

  createdAt                TEXT NOT NULL,

  UNIQUE(date, bucketTs)
);
```

---

# 33. Symbol-Level Telemetry

```sql
CREATE TABLE IF NOT EXISTS priority_refresh_symbols (
  cycleId                INTEGER NOT NULL,
  symbol                 TEXT    NOT NULL,
  sector                 TEXT,

  tier                   INTEGER NOT NULL,
  reasonsJson            TEXT    NOT NULL,
  feedRanksJson          TEXT    NOT NULL,

  sectorPromoted         INTEGER NOT NULL,
  sectorDirection        TEXT,
  sectorWeightedPct      REAL,
  sectorTurnoverRank     INTEGER,
  sectorAdvanceRatio     REAL,

  inFullPriority         INTEGER NOT NULL,
  inCappedPriority       INTEGER NOT NULL,

  requiredBucketTs       INTEGER NOT NULL,
  latestBucketAtScan     INTEGER,
  freshAtScan            INTEGER,
  refreshCompletedMs     INTEGER,

  suggested              INTEGER NOT NULL DEFAULT 0,
  suggestionRank         INTEGER,
  suggestionScore        REAL,
  suggestionRFactor      REAL,

  checkOrderAttempted    INTEGER NOT NULL DEFAULT 0,
  staleEntryBlocked      INTEGER NOT NULL DEFAULT 0,
  entryPlaced            INTEGER NOT NULL DEFAULT 0,

  PRIMARY KEY (cycleId, symbol)
);
```

All telemetry is best-effort.

Telemetry failure must never fail a scan or order-management cycle.

---

# 34. Operator Display

On Trade Commentary:

```text
Priority Refresh Shadow

Current full priority: 78
Tier 0: 5
Base Tier 1: 30
Sector promoted: 10
Proposed wait group: 45

Capped fresh: 44/45
Shadow release: 15.4s
Actual release: 28.1s
Estimated saving: 12.7s
```

Sector summary:

```text
Bullish active sectors:
PSU Bank, Pharma

Bearish active sectors:
Private Bank, Financial Services

Sector-promoted names:
SBIN, PNB, TORNTPHARM, SUNPHARMA, HDFCBANK, AXISBANK
```

---

# 35. Testing

## Planner Tests

Create:

```text
scripts/verify-priority-refresh.ts
```

Required tests:

1. Cap is applied after eligibility filtering.
2. All five feeds are handled.
3. Up to 10 eligible names per feed are considered.
4. Round-robin prevents one feed dominating.
5. Duplicate symbols use one unique slot.
6. Duplicate symbols preserve all feed ranks.
7. Tier 1 never exceeds 40 unique symbols.
8. Tier 0 is never counted against the 40 cap.
9. Tier 0 survives when absent from feeds.
10. Earlier suggestions remain Tier 0.
11. Remaining full-priority names become Tier 2.
12. Full scan pool remains unchanged.
13. OI evidence remains unchanged.
14. Empty feed does not crash.
15. Failed feed does not crash.
16. Ordering is deterministic.
17. Sector reservations reduce base slots correctly.
18. Sector promotion remains inside the 40 cap.
19. Unused sector slots are returned to normal round-robin.
20. Stale sector snapshot disables promotion.
21. Missing sector snapshot disables promotion.
22. Bullish sectors do not promote negative stocks.
23. Bearish sectors do not promote positive stocks.
24. Stocks outside all five feeds are not added through sector promotion.
25. Sector failure falls back to ordinary 40-stock selection.

---

## Freshness Tests

1. Latest bucket equals required bucket → fresh.
2. Latest bucket newer than required → fresh.
3. Latest bucket one interval older → stale.
4. Missing candle → stale.
5. Invalid/future bucket handled safely.
6. Correct required bucket at 09:45.
7. Correct required bucket at exact 5-minute boundary.
8. Placement crossing a new bucket rechecks freshness.

---

## Entry Gate Tests

1. Fresh candle + normal gates pass → allow.
2. Stale candle + block ON → reject.
3. Missing candle + block ON → reject.
4. Stale candle + block OFF → existing gates decide.
5. `check_order` rejects stale.
6. `place_entry_order` rechecks.
7. Placement rejects if candle became stale after prior ALLOW.
8. Paper mode uses the gate.
9. Approval mode uses the gate.
10. Live mode uses the gate.
11. Exit logic is unaffected.
12. Guard logic is unaffected.
13. Rejection reason appears in trace.

---

## Poller Tests

1. Shadow ON/live OFF preserves full wait behavior.
2. Shadow plan records 10-per-feed/40-unique membership.
3. Sector shadow records promoted symbols.
4. Live capped mode waits for Tier 0 + Tier 1 only.
5. Tier 2 continues background EQ refresh.
6. Tier 2 continues futures refresh.
7. Tier 2 continues depth/OI refresh.
8. Full universe remains recorded.
9. Failed priority refresh marks stale.
10. Capture still runs for position management.
11. No candidate feeds still allows guard/reconciliation.
12. Sector snapshot refresh happens after capture release.
13. Sector snapshot failure does not affect capture.
14. Telemetry failure does not affect capture.
15. Fyers dispatch spacing remains unchanged.
16. Dhan shared gates remain unchanged.

---

## Config Tests

1. Defaults are safe.
2. Capped live defaults OFF.
3. Stale entry block defaults ON.
4. Sector live defaults OFF.
5. Unknown keys are rejected.
6. Numeric ranges are enforced.
7. Sector slots cannot exceed max unique.
8. Capped live cannot enable with stale block OFF.
9. Stale block cannot disable while capped live ON.
10. Turning capped live OFF restores full wait behavior next cycle.

---

# 36. CI

Add:

```yaml
- run: pnpm exec tsx scripts/verify-priority-refresh.ts
```

Keep:

```text
Typecheck
Lint
Existing quant checks
Docker image build
Runtime container smoke test
```

---

# 37. PR Sequence

## PR A — Planner, Config, and Types

Add:

```text
lib/priority-refresh/config.ts
lib/priority-refresh/types.ts
lib/priority-refresh/round-robin.ts
lib/priority-refresh/build-plan.ts
CandidateSnapshot.feedPicks
/config registrations
planner tests
```

Behavior:

```text
No poller release change
No Auto Trade change
```

---

## PR B — Sector Snapshot and Sector Shadow

Add:

```text
sector-signal.ts
sector-snapshot-store.ts
background sector snapshot producer
sector-aware shadow plan
sector telemetry
```

Behavior:

```text
No live priority change
No Auto Trade change
```

---

## PR C — Freshness Metadata and Entry Gate

Add:

```text
freshness.ts
TradeSuggestion.candleContext
EntryGateInput fields
check_order stale rejection
place_entry_order stale recheck
```

Behavior:

```text
Full priority behavior still live
New entries fail closed when candle is stale
Exits remain unchanged
```

Start in paper/approval mode.

---

## PR D — Shadow Timing Telemetry

Add:

```text
shadow release timing
actual vs proposed release comparison
inside/outside-cap suggestion analysis
operator display
```

Run for 5–10 trading sessions.

---

## PR E — Capped Live Release

Implement:

```text
USE_CAPPED_PRIORITY_REFRESH
```

Default:

```text
OFF
```

When enabled:

```text
Wait for Tier 0 + Tier 1
Release scan/AI
Continue Tier 2 in background
```

Sector live promotion remains independently controlled.

---

## PR F — Optional Sector Live Promotion

Only after sector shadow results are reviewed.

Enable:

```text
PRIORITY_INCLUDE_ACTIVE_SECTORS
```

Default remains OFF until evidence is accepted.

---

# 38. Shadow Acceptance Criteria

Collect at least:

```text
5–10 normal trading sessions
```

## Latency

```text
p50 estimated saving >= 8 seconds
p95 capped release comfortably below next 5-minute cycle
```

## Freshness

```text
Tier 0 fresh rate = 100% except provider outages
Tier 1 fresh rate >= 98%
No stale Auto Trade placement
```

## Coverage

Review:

```text
Suggestions outside proposed cap
Targets outside proposed cap
Positive-R picks outside proposed cap
Auto Trade candidates outside proposed cap
```

Suggested starting threshold:

```text
Suggestions outside cap <= 5%
```

But every outside-cap winner must be inspected manually.

---

## Sector Quality

Measure:

```text
How many sector-promoted stocks became suggestions?
How many became entries?
How many reached target?
How many lost?
How many ordinary feed names were displaced?
Were any displaced names winners?
```

Do not enable sector promotion live if it only reshuffles candidates without improving quality.

---

## Stability

Require:

```text
No increase in Fyers 429 rate
No increase in Dhan 429 rate
No increase in cycle overlap skips
No missing position-guard cycles
No increase in scanner errors
No background recorder regression
```

---

# 39. Decision Rules After Shadow

## Keep 10 / 40

```text
No important outside-cap misses
Meaningful latency saving
Stable provider behavior
```

## Increase per-feed depth to 15

```text
Important ranks 11–15 repeatedly become good suggestions
```

## Increase maximum unique to 50

```text
Good candidates are excluded specifically by the 40-unique ceiling
```

## Keep full current behavior

```text
Latency benefit is small
Outside-cap winners are frequent
Provider stability worsens
```

## Enable sector live promotion

Only when:

```text
Sector-promoted picks improve suggestion/entry quality
Displaced normal picks are not better
Both bullish and bearish cases work
```

---

# 40. Live Rollout

## Stage 1 — Paper

```text
PRIORITY_REFRESH_SHADOW = ON
USE_CAPPED_PRIORITY_REFRESH = ON
BLOCK_STALE_AUTO_ENTRY = ON

PRIORITY_PER_FEED = 10
PRIORITY_MAX_UNIQUE = 40

PRIORITY_INCLUDE_ACTIVE_SECTORS = OFF
Auto Trade mode = paper
```

Run:

```text
3–5 sessions
```

---

## Stage 2 — Paper with Sector Promotion

Only after base capped mode is clean:

```text
PRIORITY_INCLUDE_ACTIVE_SECTORS = ON
Auto Trade mode = paper
```

Run:

```text
3–5 sessions
```

---

## Stage 3 — Approval Mode

Verify:

```text
Freshness displayed correctly
Stale entries rejected
Sector reasons visible
No position-management regression
No order regression
```

---

## Stage 4 — Live One Lot

Keep:

```text
10 per feed
40 unique Tier 1
Stale entry block ON
Risky scanner bypasses OFF
Morning window unchanged
One lot
```

Do not combine with another strategy change.

---

# 41. Rollback

No deployment required.

## Restore current full-priority behavior

```text
USE_CAPPED_PRIORITY_REFRESH = OFF
```

Effective from the next cycle.

## Disable sector live promotion only

```text
PRIORITY_INCLUDE_ACTIVE_SECTORS = OFF
```

## Stop shadow processing

```text
PRIORITY_REFRESH_SHADOW = OFF
PRIORITY_ACTIVE_SECTORS_SHADOW = OFF
```

Recommended after rollback:

```text
BLOCK_STALE_AUTO_ENTRY = ON
```

Keep the safety gate even if capped mode is disabled.

---

# 42. Definition of Done

- [ ] Feature is modular under `lib/priority-refresh/`.
- [ ] Five feed ranks are retained after eligibility filtering.
- [ ] Complete scanner membership remains unchanged.
- [ ] Complete OI evidence remains unchanged.
- [ ] Tier 0 includes all risk-bearing positions.
- [ ] Tier 0 includes earlier suggestions.
- [ ] Tier 0 is never capped.
- [ ] Base Tier 1 uses fair round-robin.
- [ ] Tier 1 never exceeds 40 unique symbols.
- [ ] Sector promotion stays inside the same 40 cap.
- [ ] Sector promotion only uses stocks already in active feeds.
- [ ] Sector direction and stock direction must agree.
- [ ] Both bullish and bearish sectors are supported.
- [ ] Sector snapshots are produced off the critical path.
- [ ] Stale sector snapshots fail open to normal round-robin.
- [ ] Scanner suggestions contain freshness metadata.
- [ ] `check_order` rejects stale entries.
- [ ] `place_entry_order` independently rechecks freshness.
- [ ] Position exits are never blocked by freshness.
- [ ] Tier 2 continues background recording.
- [ ] Config page exposes all toggles and numeric limits.
- [ ] Unsafe config combinations are rejected.
- [ ] Shadow telemetry runs for 5–10 sessions.
- [ ] CI covers planner, sector logic, freshness, and gates.
- [ ] Capped live mode defaults OFF.
- [ ] Sector live promotion defaults OFF.
- [ ] One toggle restores current full-priority behavior.
- [ ] First live rollout uses one lot.
- [ ] No simultaneous strategy changes during rollout.

---

# Final Recommendation

Implement:

```text
Tier 0
  Open/risk-bearing positions
  Earlier suggestions
  Never capped

Tier 1
  10 eligible stocks considered per feed
  Fair five-feed round-robin
  Maximum 40 unique symbols

  30 normal feed slots
  10 active-sector promotion slots

Tier 2
  Remaining movers and F&O universe
  Continue in background
```

Safety:

```text
Full scanner visibility
Mandatory stale-candle entry blocking
No effect on exits or position guards
Shadow-first rollout
Config-controlled live activation
Immediate config rollback
```

Do not enable capped live mode or sector promotion directly.

Collect evidence first, then enable one change at a time.
