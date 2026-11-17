# Fyers Standard-Plan Data Budget — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Fyers data call fits inside the Standard plan (5/s, 50/min, 5,000/day) with no loss to the trade path, a refusal can never be hammered or missed, and the count survives restarts.

**Architecture:** One data gate (`lib/fyers/client.ts`) counts every Fyers data call, persists the day's count in SQLite, latches shut on a Fyers refusal, and keeps the last 500 calls of the day for a `critical` lane (open-trade guard, entry spot). The poller downloads full data only for the priority set (open trades → TF top 10, cap 12) and a batched price snapshot for everyone else. Option-chain code is removed.

**Tech Stack:** Next.js 16 / TypeScript, Prisma raw SQL on SQLite, `fyers-api-v3` SDK + raw `fetch` to `api-t1.fyers.in/data`, pure-check benches run by `scripts/verify-quant-shadow.ts` in CI.

**Spec:** `docs/superpowers/specs/2026-11-17-fyers-standard-plan-budget-design.md`. Stopgap already live (v1.72.3): gate 4/40/4,500, poller 10 symbols, guard 15 s.

## Global Constraints

- Fyers Standard Data-API limits: **5/sec, 50/min, 5,000/day**. Gate: **4/sec, 40/min, 4,500/day**. Never raise above the Standard numbers.
- `FAST_GUARD_TICK_MS = 15_000`. `MAX_PRIORITY_SYMBOLS = 12`. Critical reserve = **500** calls.
- No new third-party packages. No fabricated data: snapshots are never written as candle rows.
- Never `prisma db push --accept-data-loss`; new tables are runtime `CREATE TABLE IF NOT EXISTS`.
- `COMMENTARY_SYSTEM` / `COMMENTARY_HARD_RULES` stay byte-identical.
- Validation before deploy = the full CI job (`pnpm typecheck`, `pnpm typecheck:scripts`, `pnpm lint`, every `verify-*.ts` in `.github/workflows/build-image.yml`).
- Style: hand-written edits in the surrounding style; never `prettier --write` existing files.

---

### Task 1: Record NSE OI % for every name without a Fyers call

Stopgap regression: `nseOiPct` (input to App OIΔ30m and `combinedOiSlope`) is only written by `attachFutDepth`, which now runs for ~10 names.

**Files:**
- Modify: `lib/fyers/candle-store.ts` (add `attachNseOiPct` after `attachFutDepth`)
- Modify: `lib/fyers/poller.ts` (call it once per cycle, before the priority depth loop)

**Interfaces:**
- Produces: `attachNseOiPct(date: string, bucketTs: number, bySymbol: Map<string, number>, nowMs?: number): Promise<number>`

- [ ] **Step 1: Add the writer** — `lib/fyers/candle-store.ts`

```ts
/**
 * Attach NSE's combined OI %-change (oi-spurts feed — NO Fyers call) to the
 * current bucket's FUT row for EVERY name the feed carries. Since the Fyers
 * Standard-plan budget (2026-11-17) only the priority set gets a depth call,
 * so attachFutDepth alone would leave App OIΔ30m (combinedOiSlope over this
 * series) blank for everyone else. Inserts a zero-OHLCV, oi=0 placeholder —
 * depth readers filter on oi > 0, so it never reads as a depth snapshot — and
 * on conflict touches ONLY nseOiPct/updatedAt.
 */
export async function attachNseOiPct(
  date: string,
  bucketTs: number,
  bySymbol: Map<string, number>,
  nowMs: number = Date.now()
): Promise<number> {
  if (bySymbol.size === 0) return 0;
  await ensureFyersCandlesTable();
  const entries = [...bySymbol.entries()];
  const at = new Date(nowMs).toISOString();
  for (let i = 0; i < entries.length; i += 200) {
    const chunk = entries.slice(i, i + 200);
    await prisma.$executeRawUnsafe(
      `INSERT INTO fyers_candles
         (symbol, instrument, date, bucketTs, open, high, low, close, volume, oi, nseOiPct, updatedAt)
       VALUES ${chunk.map(() => "(?, 'FUT', ?, ?, 0, 0, 0, 0, 0, 0, ?, ?)").join(', ')}
       ON CONFLICT(symbol, instrument, date, bucketTs) DO UPDATE SET
         nseOiPct = excluded.nseOiPct,
         updatedAt = excluded.updatedAt`,
      ...chunk.flatMap(([symbol, pct]) => [symbol, date, bucketTs, pct, at])
    );
  }
  return entries.length;
}
```

- [ ] **Step 2: Call it in the poller** — `lib/fyers/poller.ts`, right after `const nseOiPctBySymbol = …`:

```ts
    if (attachOi && nseOiPctBySymbol.size > 0) {
      const inUniverse = new Map([...nseOiPctBySymbol].filter(([symbol]) => universeSet.has(symbol)));
      await attachNseOiPct(date, fyersBucketFor(Date.now()), inUniverse).catch((err) => {
        console.warn(`${TAG} nseOiPct attach failed: ${(err as Error).message}`);
      });
    }
```
and add `attachNseOiPct` to the existing `@/lib/fyers/candle-store` import.

- [ ] **Step 3:** `pnpm exec eslint lib/fyers/candle-store.ts lib/fyers/poller.ts` and `pnpm typecheck` → clean.

---

### Task 2: Budget rules (pure) + persisted counter + refusal latch + critical lane

**Files:**
- Create: `lib/fyers/budget.ts` (pure rules)
- Create: `lib/fyers/budget-store.ts` (SQLite table `fyers_data_budget`)
- Modify: `lib/fyers/client.ts` (gate uses both; lane param; latch on refusal; status export)
- Modify: `lib/market-data/provider.ts` (`MAX_PRIORITY_SYMBOLS`, `CALLS_PER_SYMBOL = 2`)
- Test: `scripts/fyers-budget-checks.ts` (extend `runFyersBudgetChecks`)

**Interfaces:**
- Produces (budget.ts): `type FyersLane = 'critical' | 'normal'`, `type LimitKind = 'minute' | 'day'`, `CRITICAL_RESERVE = 500`, `classifyLimitRefusal(message: string): LimitKind | null`, `istDayKey(nowMs: number): string`, `latchUntilFor(kind: LimitKind, nowMs: number): number`, `admitCall(s: BudgetState, lane: FyersLane, perDay: number, nowMs: number): string | null` (null = admitted, else refusal reason), `resumeBudget(row: StoredBudget | null, nowMs: number): BudgetState`.
- Produces (budget-store.ts): `loadStoredBudget(date: string): Promise<StoredBudget | null>`, `saveStoredBudget(s: BudgetState): Promise<void>`.
- Produces (client.ts): `requestFyersData(endpoint, params, deadline?, lane?: FyersLane)`, `class FyersBudgetError extends Error`, `getFyersDataBudgetStatus(): FyersDataBudgetStatus`.

- [ ] **Step 1: Write the failing checks** — append to `runFyersBudgetChecks` in `scripts/fyers-budget-checks.ts`:

```ts
  // ── Refusal latch, critical reserve, restart resume (lib/fyers/budget.ts) ──
  const t0 = Date.parse('2026-11-18T10:00:00+05:30');
  check('budget: Fyers per-minute message latches the minute',
    classifyLimitRefusal("You've reached the Standard plan limit of 50 requests/minute. Upgrade to Prime") === 'minute');
  check('budget: Fyers per-day message latches the day',
    classifyLimitRefusal("You've reached the Standard plan limit of 5,000 requests/day. Upgrade to Prime") === 'day');
  check('budget: unrelated errors do not latch', classifyLimitRefusal('Invalid symbol') === null);
  check('budget: a minute latch lasts ~61s', latchUntilFor('minute', t0) - t0 === 61_000);
  check('budget: a day latch lasts until 00:00 IST',
    latchUntilFor('day', t0) === Date.parse('2026-11-19T00:00:00+05:30'));
  const fresh = resumeBudget(null, t0);
  check('budget: a new day starts at 0, unlatched', fresh.count === 0 && fresh.latchUntil === 0 && fresh.date === '2026-11-18');
  const resumed = resumeBudget({ date: '2026-11-18', count: 1234, latchUntil: t0 + 30_000, latchReason: 'minute' }, t0);
  check('budget: a restart resumes the stored count and an active latch', resumed.count === 1234 && resumed.latchUntil === t0 + 30_000);
  check('budget: yesterday\'s row does not carry over',
    resumeBudget({ date: '2026-11-17', count: 4400, latchUntil: 0, latchReason: null }, t0).count === 0);
  check('budget: latched → every lane refused', admitCall({ ...fresh, latchUntil: t0 + 1 }, 'critical', 4_500, t0) !== null);
  check('budget: normal lane stops 500 short of the cap', admitCall({ ...fresh, count: 4_000 }, 'normal', 4_500, t0) !== null);
  check('budget: critical lane may use the reserve', admitCall({ ...fresh, count: 4_000 }, 'critical', 4_500, t0) === null);
  check('budget: critical lane stops at the cap', admitCall({ ...fresh, count: 4_500 }, 'critical', 4_500, t0) !== null);
```
and the import:
```ts
import { admitCall, classifyLimitRefusal, latchUntilFor, resumeBudget } from '../lib/fyers/budget';
```

- [ ] **Step 2:** Run `pnpm exec tsx scripts/verify-quant-shadow.ts` → FAIL (module not found).

- [ ] **Step 3: Create `lib/fyers/budget.ts`**

```ts
/**
 * Fyers data-budget rules — PURE (no I/O), CI-checked by
 * scripts/fyers-budget-checks.ts. Standard plan since 2026-11-16: 5/s, 50/min,
 * 5,000/day for Data APIs. The gate (lib/fyers/client.ts) applies these:
 *   - the day's count is persisted (budget-store.ts) so a deploy mid-session
 *     resumes instead of believing it has 4,500 calls left;
 *   - a Fyers refusal LATCHES the gate shut (a minute, or until 00:00 IST) —
 *     on 2026-11-16/17 the poller kept firing ~495 refused calls every cycle;
 *   - the last CRITICAL_RESERVE calls of the day belong to the critical lane
 *     (open-trade guard quotes, entry spot) so a trade is never left blind.
 */

export type FyersLane = 'critical' | 'normal';
export type LimitKind = 'minute' | 'day';

export const CRITICAL_RESERVE = 500;
const IST_OFFSET_MS = 19_800_000;

export interface BudgetState {
  date: string;
  count: number;
  latchUntil: number;
  latchReason: string | null;
}

export type StoredBudget = BudgetState;

/** Fyers' own refusal text ("…limit of 50 requests/minute", "…5,000 requests/day"). */
export function classifyLimitRefusal(message: string): LimitKind | null {
  if (/requests\s*\/\s*day|per\s+day/i.test(message)) return 'day';
  if (/requests\s*\/\s*min(ute)?|per\s+minute/i.test(message)) return 'minute';
  return null;
}

export function istDayKey(nowMs: number): string {
  return new Date(nowMs + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export function latchUntilFor(kind: LimitKind, nowMs: number): number {
  if (kind === 'minute') return nowMs + 61_000;
  return Date.parse(`${istDayKey(nowMs)}T00:00:00+05:30`) + 86_400_000;
}

/** Today's state from the stored row: same IST day → resume, else a fresh day. */
export function resumeBudget(row: StoredBudget | null, nowMs: number): BudgetState {
  const date = istDayKey(nowMs);
  if (!row || row.date !== date) return { date, count: 0, latchUntil: 0, latchReason: null };
  return { date, count: row.count, latchUntil: row.latchUntil, latchReason: row.latchReason };
}

/** null = admitted; otherwise the human-readable refusal. */
export function admitCall(s: BudgetState, lane: FyersLane, perDay: number, nowMs: number): string | null {
  if (nowMs < s.latchUntil) {
    const until = new Date(s.latchUntil + IST_OFFSET_MS).toISOString().slice(11, 16);
    return `Fyers data paused until ${until} IST (${s.latchReason ?? 'limit'})`;
  }
  const allowance = lane === 'critical' ? perDay : perDay - CRITICAL_RESERVE;
  if (s.count >= allowance) {
    return lane === 'critical'
      ? `Fyers daily data budget exhausted (${s.count}/${perDay})`
      : `Fyers daily data budget: last ${CRITICAL_RESERVE} calls reserved for open trades (${s.count}/${perDay})`;
  }
  return null;
}
```

- [ ] **Step 4: Create `lib/fyers/budget-store.ts`**

```ts
/**
 * Persisted Fyers data-budget counter (one row per IST day). Runtime table,
 * never declared in schema.prisma (house rule: no db push). Read once per
 * process; written at most once a second plus immediately on a latch.
 */
import { prisma } from '@/lib/db';
import type { BudgetState, StoredBudget } from './budget';

let ready = false;

async function ensureTable(): Promise<void> {
  if (ready) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS fyers_data_budget (
      date        TEXT    PRIMARY KEY,
      count       INTEGER NOT NULL DEFAULT 0,
      latchUntil  INTEGER NOT NULL DEFAULT 0,
      latchReason TEXT,
      updatedAt   TEXT    NOT NULL
    )`);
  ready = true;
}

export async function loadStoredBudget(date: string): Promise<StoredBudget | null> {
  await ensureTable();
  const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT date, count, latchUntil, latchReason FROM fyers_data_budget WHERE date = ?`,
    date
  );
  const r = rows[0];
  if (!r) return null;
  return {
    date: String(r.date),
    count: Number(r.count ?? 0),
    latchUntil: Number(r.latchUntil ?? 0),
    latchReason: r.latchReason == null ? null : String(r.latchReason),
  };
}

export async function saveStoredBudget(s: BudgetState): Promise<void> {
  await ensureTable();
  await prisma.$executeRawUnsafe(
    `INSERT INTO fyers_data_budget (date, count, latchUntil, latchReason, updatedAt)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       count = MAX(fyers_data_budget.count, excluded.count),
       latchUntil = excluded.latchUntil,
       latchReason = excluded.latchReason,
       updatedAt = excluded.updatedAt`,
    s.date,
    s.count,
    s.latchUntil,
    s.latchReason,
    new Date().toISOString()
  );
}
```

- [ ] **Step 5: Gate changes** — `lib/fyers/client.ts`:
  1. Imports: `import { admitCall, classifyLimitRefusal, istDayKey, latchUntilFor, resumeBudget, type BudgetState, type FyersLane } from './budget';` and `import { loadStoredBudget, saveStoredBudget } from './budget-store';`
  2. Replace `day?`/`dayCount?` in `FyersGateState` with `budget?: BudgetState; budgetLoaded?: boolean; saveTimer?: ReturnType<typeof setTimeout> | null;`
  3. Add:

```ts
export class FyersBudgetError extends Error {}

async function currentBudget(nowMs: number): Promise<BudgetState> {
  const day = istDayKey(nowMs);
  if (!gate.budgetLoaded || gate.budget?.date !== day) {
    let stored = null;
    try {
      stored = await loadStoredBudget(day);
    } catch (err) {
      console.warn(`${TAG} budget table unreadable — counting from memory: ${(err as Error).message}`);
    }
    // Never move backwards within a day (memory may be ahead of the last flush).
    const resumed = resumeBudget(stored, nowMs);
    if (gate.budget?.date === day && gate.budget.count > resumed.count) resumed.count = gate.budget.count;
    gate.budget = resumed;
    gate.budgetLoaded = true;
  }
  return gate.budget!;
}

function scheduleBudgetSave(immediate = false): void {
  const flush = () => {
    gate.saveTimer = null;
    if (gate.budget) void saveStoredBudget(gate.budget).catch(() => undefined);
  };
  if (immediate) {
    if (gate.saveTimer) clearTimeout(gate.saveTimer);
    flush();
    return;
  }
  gate.saveTimer ??= setTimeout(flush, 1_000);
}

/** Shut the gate after a Fyers refusal (see budget.ts). */
function noteLimitRefusal(message: string): boolean {
  const kind = classifyLimitRefusal(message);
  if (!kind || !gate.budget) return false;
  const until = latchUntilFor(kind, Date.now());
  if (until > gate.budget.latchUntil) {
    gate.budget.latchUntil = until;
    gate.budget.latchReason = `Fyers refused: ${kind} limit`;
    console.warn(`${TAG} ${gate.budget.latchReason} — all Fyers data calls paused until ${new Date(until + 19_800_000).toISOString().slice(11, 16)} IST`);
    scheduleBudgetSave(true);
  }
  return true;
}

export interface FyersDataBudgetStatus {
  date: string | null;
  count: number;
  perDay: number;
  latchUntil: number | null;
  latchReason: string | null;
}

export function getFyersDataBudgetStatus(): FyersDataBudgetStatus {
  const b = gate.budget;
  const latched = b != null && b.latchUntil > Date.now();
  return {
    date: b?.date ?? null,
    count: b?.count ?? 0,
    perDay: fyersDataLimits().perDay,
    latchUntil: latched ? b!.latchUntil : null,
    latchReason: latched ? b!.latchReason : null,
  };
}
```
  4. `throughFyersGate<T>(task, deadline = Date.now() + 60_000, lane: FyersLane = 'normal')` — inside the dispatch replace the two `gate.day`/`dayCount` lines with:

```ts
    const budget = await currentBudget(Date.now());
    const refusal = admitCall(budget, lane, limits.perDay, Date.now());
    if (refusal) throw new FyersBudgetError(refusal);
```
and replace `gate.dayCount = (gate.dayCount ?? 0) + 1;` with `budget.count += 1; scheduleBudgetSave();`.
  5. `requestFyersData(endpoint, params, deadline = Date.now() + 8_000, lane: FyersLane = 'normal')` — pass `lane` to `throughFyersGate`; drop `'options-chain-v3'` from the endpoint allowlist; on `response.status === 429` read the body once:

```ts
  if (response.status === 429) {
    const body = await response.text().catch(() => '');
    if (!noteLimitRefusal(body)) noteFyers429();
    throw new Error(`Fyers data rate limit; ${body.slice(0, 120) || 'cooling down'}`);
  }
```
  6. `classifyFailure`: before the `code === 429` test add `if (noteLimitRefusal(message)) return { rateLimited: true, message };` and widen the regex to `/rate|limit exceeded|too many|requests\/(minute|day|second)/i`.
  7. `fetchHistory5m` / `fetchFutDepth`: a `FyersBudgetError` from the gate must not be logged once per symbol — in each `catch (err)` add `if (err instanceof FyersBudgetError) return [];` (history) / `return null;` (depth) before the existing fallback.

- [ ] **Step 6: provider.ts constants**

```ts
/** History + depth calls the poller makes per PRIORITY symbol per cycle (EQ candles, FUT depth). */
const CALLS_PER_SYMBOL = 2;
/** Most symbols that get full per-cycle data: open trades first, then TF's top 10. */
export const MAX_PRIORITY_SYMBOLS = 12;
```
Update the `POLLER_DAILY_BUDGET` comment: share covers ≤ 12 priority × 2 calls + ~4 snapshot calls per cycle.

- [ ] **Step 7:** `pnpm exec tsx scripts/verify-quant-shadow.ts` → all `budget:` checks PASS; `pnpm typecheck` clean.

---

### Task 3: Critical lane for the guard, entry spot and the order smoke quote

**Files:**
- Modify: `lib/fyers/market-feed.ts` (`fetchFyersDepth(symbol, deadline, lane)`, `marketFeed(endpoint, securities, opts?)`)
- Modify: `lib/auto-trade/quotes.ts` (`fetchOptionQuotesWithHealth`, `fetchLiveSpot` pass `{ lane: 'critical' }`)
- Modify: `lib/auto-trade/brokers/fyers-adapter.ts:123` (smoke quote via `requestFyersData`)
- Create: `scripts/verify-fyers-no-bypass.ts`; Modify: `.github/workflows/build-image.yml` (run it next to `verify-dependency-hygiene.ts`)

**Interfaces:**
- Consumes: `requestFyersData(…, lane)`, `FyersLane` (Task 2)
- Produces: `marketFeed(endpoint: 'quote' | 'ohlc', securities: Record<string, number[]>, opts?: { lane?: FyersLane }): Promise<MarketFeedResponse>`

- [ ] **Step 1:** `market-feed.ts` — `fetchFyersDepth(symbol: string, deadline = Date.now() + 8_000, lane: FyersLane = 'normal')` passes `lane` as the 4th arg of `requestFyersData`; `marketFeed(endpoint, securities, opts: { lane?: FyersLane } = {})` passes `opts.lane ?? 'normal'` to both the batched `quotes` call and `fetchFyersDepth`.
- [ ] **Step 2:** `quotes.ts` — `marketFeed('quote', { NSE_FNO: ids }, { lane: 'critical' })` and `marketFeed('ohlc', { NSE_EQ: [id] }, { lane: 'critical' })`.
- [ ] **Step 3:** `fyers-adapter.ts` — replace the SDK `getQuotes` line with:

```ts
  // Data API → through the shared data gate (counted, latch-aware), not serial().
  const quote = await requestFyersData('quotes', { symbols: symbol }, Date.now() + 8_000, 'critical');
```
(import `requestFyersData` from `@/lib/fyers/client`; the response shape `d[0].v.lp` is unchanged).
- [ ] **Step 4: Bypass guard** — `scripts/verify-fyers-no-bypass.ts`:

```ts
/**
 * Every Fyers DATA call must go through lib/fyers/client.ts (counted, latched,
 * budgeted). Fails CI when any other source file calls the SDK's data methods
 * or the data REST host directly. The order-placement SDK calls and the
 * websocket (fyersDataSocket) are not Data REST and are allowed.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOTS = ['lib', 'app'];
const ALLOWED = new Set([path.normalize('lib/fyers/client.ts')]);
const PATTERN = /\.(getQuotes|getHistory|getMarketDepth|getOptionChain)\s*\(|api-t1\.fyers\.in\/data/;

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
}

const files: string[] = [];
for (const root of ROOTS) walk(root, files);
const offenders = files.filter((f) => !ALLOWED.has(path.normalize(f)) && PATTERN.test(readFileSync(f, 'utf8')));
if (offenders.length > 0) {
  console.error(`✗ Fyers data calls outside lib/fyers/client.ts:\n  ${offenders.join('\n  ')}`);
  process.exit(1);
}
console.log(`✓ no Fyers data-call bypass (${files.length} files scanned)`);
```
Add to `build-image.yml` validate job: `- run: pnpm exec tsx scripts/verify-fyers-no-bypass.ts`.
- [ ] **Step 5:** run the script → `✓`; `pnpm typecheck` clean.

---

### Task 4: Poller — priority-only data, snapshots for the rest, EOD grading fetch

**Files:**
- Create: `lib/fyers/quote-snapshots.ts`
- Modify: `lib/fyers/poller.ts` (`getPrioritySymbols`, cycle body, retention, `runEodScorecard`)
- Test: `scripts/fyers-budget-checks.ts` (day simulation numbers)

**Interfaces:**
- Consumes: `MAX_PRIORITY_SYMBOLS` (Task 2), `requestFyersData` (Task 2)
- Produces: `recordQuoteSnapshots(date: string, rows: QuoteSnapshot[]): Promise<number>`, `getLatestQuoteSnapshots(symbols: string[], date: string): Promise<Map<string, QuoteSnapshot>>`, `pruneQuoteSnapshotHistory(): Promise<number>`, `interface QuoteSnapshot { symbol: string; tsMs: number; ltp: number; open: number | null; high: number | null; low: number | null; prevClose: number | null; volume: number | null }`

- [ ] **Step 1: Create `lib/fyers/quote-snapshots.ts`**

```ts
/**
 * Batched price snapshots for F&O names OUTSIDE the priority set (Fyers
 * Standard plan, 2026-11-17): one quotes call per 50 symbols per cycle instead
 * of 3 calls per symbol. Kept in their OWN table — a snapshot is a point
 * reading, never a 5-min candle, so it is never written into fyers_candles.
 */
import { prisma } from '@/lib/db';
import { FYERS_CANDLE_RETENTION_SESSIONS } from './candle-store';

export interface QuoteSnapshot {
  symbol: string;
  tsMs: number;
  ltp: number;
  open: number | null;
  high: number | null;
  low: number | null;
  prevClose: number | null;
  volume: number | null;
}

let ready = false;

async function ensureTable(): Promise<void> {
  if (ready) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS fyers_quote_snapshots (
      symbol    TEXT    NOT NULL,
      date      TEXT    NOT NULL,
      tsMs      INTEGER NOT NULL,
      ltp       REAL    NOT NULL,
      open      REAL,
      high      REAL,
      low       REAL,
      prevClose REAL,
      volume    REAL,
      PRIMARY KEY (symbol, date, tsMs)
    )`);
  ready = true;
}

export async function recordQuoteSnapshots(date: string, rows: QuoteSnapshot[]): Promise<number> {
  if (rows.length === 0) return 0;
  await ensureTable();
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    await prisma.$executeRawUnsafe(
      `INSERT OR REPLACE INTO fyers_quote_snapshots (symbol, date, tsMs, ltp, open, high, low, prevClose, volume)
       VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
      ...chunk.flatMap((r) => [r.symbol, date, r.tsMs, r.ltp, r.open, r.high, r.low, r.prevClose, r.volume])
    );
  }
  return rows.length;
}

export async function getLatestQuoteSnapshots(symbols: string[], date: string): Promise<Map<string, QuoteSnapshot>> {
  const out = new Map<string, QuoteSnapshot>();
  if (symbols.length === 0) return out;
  await ensureTable();
  const placeholders = symbols.map(() => '?').join(',');
  const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT s.* FROM fyers_quote_snapshots s
       JOIN (SELECT symbol, MAX(tsMs) AS tsMs FROM fyers_quote_snapshots
              WHERE date = ? AND symbol IN (${placeholders}) GROUP BY symbol) latest
         ON latest.symbol = s.symbol AND latest.tsMs = s.tsMs
      WHERE s.date = ?`,
    date,
    ...symbols,
    date
  );
  const num = (v: unknown) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  for (const r of rows) {
    out.set(String(r.symbol), {
      symbol: String(r.symbol),
      tsMs: Number(r.tsMs),
      ltp: Number(r.ltp),
      open: num(r.open),
      high: num(r.high),
      low: num(r.low),
      prevClose: num(r.prevClose),
      volume: num(r.volume),
    });
  }
  return out;
}

export async function pruneQuoteSnapshotHistory(): Promise<number> {
  await ensureTable();
  return prisma.$executeRawUnsafe(
    `DELETE FROM fyers_quote_snapshots WHERE date NOT IN (
       SELECT DISTINCT date FROM fyers_quote_snapshots ORDER BY date DESC LIMIT ${FYERS_CANDLE_RETENTION_SESSIONS}
     )`
  );
}
```

- [ ] **Step 2: `getPrioritySymbols`** — keep risk-bearing first, then `candidateSnapshot.prioritySymbols`; earlier suggestions are still returned in `earlierSuggestions` (for logging/EOD) but are NOT added to `symbols`. Comment: they only need candles for grading, fetched once after 15:30 (Step 5).

- [ ] **Step 3: Cycle body** — replace the rotating-tail block with:

```ts
    const maxSymbolsThisCycle = Math.min(MAX_PRIORITY_SYMBOLS, symbolsPerCycle(pollerDataLimits(), universe.length));
    const ordered = priorityOrdered.slice(0, maxSymbolsThisCycle);
    const priorityCount = ordered.length;
    const snapshotSymbols = universe.filter((symbol) => !ordered.includes(symbol));
```
Recorder loop over `ordered` only: resolve `futSymbol`, then (when `attachOi`) `fetchFutDepth` + `attachFutDepth` exactly as today; **delete** the `fetchHistory5m(futSymbol, date)` call and the `symbolIdx >= priorityCount` tail branch. After the loop, when `attachOi`, the snapshot pass:

```ts
    // Everyone outside the priority set: ONE quotes call per 50 symbols.
    if (attachOi && !cycleAborted && snapshotSymbols.length > 0) {
      const snaps: QuoteSnapshot[] = [];
      for (let i = 0; i < snapshotSymbols.length; i += 50) {
        const batch = snapshotSymbols.slice(i, i + 50);
        try {
          summary.apiCalls += 1;
          const res = await requestFyersData('quotes', { symbols: batch.map(toEqSymbol).join(',') });
          const data = Array.isArray(res.d) ? (res.d as { n: string; s: string; v: Record<string, unknown> }[]) : [];
          const at = Date.now();
          for (const symbol of batch) {
            const v = data.find((e) => e.n === toEqSymbol(symbol) && e.s === 'ok')?.v;
            const ltp = Number(v?.lp);
            if (!v || !Number.isFinite(ltp) || ltp <= 0) continue;
            const n = (x: unknown) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Number(x) : null);
            snaps.push({ symbol, tsMs: at, ltp, open: n(v.open_price), high: n(v.high_price), low: n(v.low_price), prevClose: n(v.prev_close_price), volume: n(v.volume) });
          }
        } catch (err) {
          summary.errors.push({ symbol: '*', stage: 'snapshot', message: (err as Error).message });
          if (err instanceof FyersBudgetError) break;
        }
      }
      summary.snapshotSymbols = await recordQuoteSnapshots(date, snaps);
    }
```
Add `snapshotSymbols: number` to `CycleSummary` (init 0) and `'snapshot'` to its error `stage` union. Imports: `requestFyersData, FyersBudgetError` from `@/lib/fyers/client`; `recordQuoteSnapshots, pruneQuoteSnapshotHistory, type QuoteSnapshot` from `@/lib/fyers/quote-snapshots`; `MAX_PRIORITY_SYMBOLS` from `@/lib/market-data/provider`. Update the stale log line `FUT/depth and … more symbols continue in background` to `FUT depth for ${priorityCount} + snapshots for ${snapshotSymbols.length} continue in background`.

- [ ] **Step 4: Retention** — next to `pruneCandleHistory()`: `await pruneQuoteSnapshotHistory().catch(() => 0);`

- [ ] **Step 5: EOD grading fetch** — at the top of the `try` in `runEodScorecard`, before `reviewUngradedBacklog()`:

```ts
    // Earlier suggestions are no longer recorded every cycle (Fyers Standard
    // budget). One full-day history call each, after the close, so review.ts
    // grades them on complete candles. ≤ ~10 calls a day.
    try {
      const { getSuggestions } = await import('@/lib/trade-suggest/store');
      const symbols = [...new Set((await getSuggestions(istToday)).map((s) => s.symbol))];
      for (const symbol of symbols) {
        const bars = await fetchHistory5m(toEqSymbol(symbol), istToday);
        if (bars.length > 0) await upsertCandles(symbol, 'EQ', istToday, bars);
      }
    } catch (err) {
      console.warn(`${TAG} EOD grading fetch failed: ${(err as Error).message}`);
    }
```

- [ ] **Step 6: Day simulation** — in `scripts/fyers-budget-checks.ts` replace the poller line of the day check with:

```ts
  const poller = Math.min(MAX_PRIORITY_SYMBOLS, perCycle) * 2 * 75 + Math.ceil((166 - MAX_PRIORITY_SYMBOLS) / 50) * 75;
```
and the "10 symbols a cycle" check with `perCycle >= MAX_PRIORITY_SYMBOLS` (the cap, not the budget, now binds). Expected detail: `1800 + 300 = 2100 poller + 1308 guard + 400 other = 3808 / 4500`.

- [ ] **Step 7:** `pnpm exec tsx scripts/verify-quant-shadow.ts` PASS; `pnpm typecheck` clean.

---

### Task 5: /live uses the snapshot when it is fresher than the last candle

**Files:**
- Modify: `app/api/live/quote/route.ts` (after the `snapshots` query, before `rows`)

- [ ] **Step 1:** Load and merge:

```ts
  // Names outside the Fyers priority set have no fresh candles (Standard-plan
  // budget, 2026-11-17) — only a batched snapshot per cycle. Use it when it is
  // newer than the last candle's close. A snapshot is the DAY's open/high/low,
  // never a 5-min bar; candle-derived columns stay "—" for these names.
  const quoteSnaps = await getLatestQuoteSnapshots(allowed, today).catch(() => new Map<string, QuoteSnapshot>());
```
In the row map, replace `const eqQ = eqMap.get(s);` with:

```ts
    const candle = eqMap.get(s);
    const snap = quoteSnaps.get(s);
    const eqQ =
      snap && (!candle || snap.tsMs > (candle.bucketTs + 300) * 1000)
        ? { ...(candle ?? {}), close: snap.ltp, open: snap.open ?? 0, high: snap.high ?? 0, low: snap.low ?? 0 }
        : candle;
```
(`eqQ` is only read for `close`, `open`, `high`, `low` in this function — confirm with `grep -n "eqQ" app/api/live/quote/route.ts` before editing.) Import `getLatestQuoteSnapshots, type QuoteSnapshot` from `@/lib/fyers/quote-snapshots`.
- [ ] **Step 2:** `pnpm typecheck` clean.

---

### Task 6: Remove the option chain

**Files:**
- Delete: `lib/fyers/option-chain.ts`, `lib/signals/nifty-gamma-context.ts`, `lib/signals/gex.ts` (only used by the two), `lib/option-chain/shadow.ts`, `app/api/live/nifty-context/route.ts`, `app/live/_components/nifty-market-context.tsx`
- Modify: `lib/option-chain/index.ts` (drop the `./shadow` export line), `lib/market-data/index.ts` (drop the `@/lib/fyers/option-chain` export line), `lib/fyers/poller.ts` (delete `refreshDisplayOnlyNiftyContext`, its call and the `allowDisplayRefresh` plumbing), `app/live/page.tsx` (delete the commented-out NiftyMarketContext lines), `lib/ai-commentary/generate.ts` (remove `getCachedOptionEvidence` import, the `optionEvidence` const and the `optionChain:` field; keep `describeOptionChain` only if still referenced — otherwise delete it), `scripts/dry-run-commentary.ts` (delete Turn 3, which seeded the deleted shadow cache)
- Keep: `lib/option-chain/{evidence,store,types}.ts` + `pruneOptionChainSnapshots` (history readers for `scripts/measure-option-evidence.ts`); `COMMENTARY_*` prompt text unchanged (it already says "If optionChain is null, say nothing about options").

- [ ] **Step 1:** Before deleting, `grep -rn "<each deleted module>" lib app scripts` — every importer must be in the Modify list above; `lib/signals/gex.ts` must have no importer besides `nifty-gamma-context.ts` and `lib/option-chain/evidence.ts` (if `evidence.ts` imports it, keep `gex.ts`).
- [ ] **Step 2:** Delete / edit as listed. `pnpm typecheck`, `pnpm typecheck:scripts`, `pnpm lint` clean.

---

### Task 7: /fyers shows the budget; docs; full CI; deploy

**Files:**
- Modify: `lib/fyers/poller.ts` (`PollerStatus.dataBudget = getFyersDataBudgetStatus()`), `app/fyers/page.tsx` (one line + amber banner when latched)
- Modify: `CLAUDE.md` (Fyers budget bullet: full fix, not stopgap; option-chain section: collector removed, history kept), memory `fyers-live-downloader`

- [ ] **Step 1:** In `getFyersPollerStatus()` add `dataBudget: getFyersDataBudgetStatus()` and `dataBudget: FyersDataBudgetStatus` on the interface. In `app/fyers/page.tsx` extend the status type with `dataBudget?: { count: number; perDay: number; latchUntil: number | null; latchReason: string | null }`, render `Fyers data calls today: {count} / {perDay}` under the cycle line, and when `latchUntil` is set an amber box: `Fyers data paused until HH:MM IST — {latchReason}`.
- [ ] **Step 2:** Docs updates as listed.
- [ ] **Step 3:** Full CI job locally (Global Constraints). All green.
- [ ] **Step 4:** Commit, tag `v1.73.0`, push `main` + tag, `release: main -> prod (v1.73.0 — …)` merge commit on `prod` via a temporary worktree, push `prod`.
- [ ] **Step 5:** After the box deploys: `/api/health` 200; container log shows the poller cycle line with `snapshots`; `fyers_data_budget` has today's row; next session `/fyers` count < 4,500 at 15:30 and no "Standard plan limit" log lines.
