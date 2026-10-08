# TF Climbers Cockpit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the /live TF Climbers card into a live-trading cockpit built on TF's Intraday Boost top 20, and make TF's breakout beacon a required entry check alongside our ORB.

**Architecture:** Pure helpers (`lib/tf-live/board-view.ts`, parsers in `lib/tf-live/parse.ts`) compute everything the card shows; the selector gains one gate (`tfBeacon`); the race reads Intraday Boost captures; `/api/tf/race` assembles the view behind a per-minute cache; the card is rewritten to render it. Spec: `docs/superpowers/specs/2026-10-08-tf-climbers-cockpit-design.md`.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Prisma + SQLite (raw SQL), Tailwind 4, lucide-react. Benches are `tsx` scripts (`check(name, ok)`), no test framework.

## Global Constraints

- Operator decisions (2026-10-08), verbatim: base list = **TF Intraday Boost, top 20 by R-Factor**; **entries 09:45–11:00, measuring from 09:35**; momentum = 30-min R-Factor rise (unchanged); breakout = **our 15-min ORB (09:15–09:30) AND TF's beacon** must agree (BULL for CE, BEAR for PE) — the 30-min ORB is recorded next to it on every candidate as a shadow, never a gate; the 15-min range is ADDED to `deriveSessionContext` and read only by the TF selector (the 30-min range keeps feeding stops, App R-Factor, spot plans and commentary unchanged); sector strength **shown only, never a check**; climbers that **leave the top 20 stay visible (DROPPED)**; **30 s refresh** in session, 5 min otherwise.
- Missing evidence is never a pass (fail closed). A null gate renders grey, never green.
- No new third-party dependencies. Validate with `pnpm typecheck`, `pnpm typecheck:scripts`, `pnpm lint`, and the CI benches (`.github/workflows/build-image.yml`).
- No `git add` / commit without the operator's explicit OK.

---

### Task 1: Parsers — Intraday Boost board and TF breakout beacons

**Files:**
- Modify: `lib/tf-live/parse.ts`
- Modify: `lib/tf-live/endpoints.ts`
- Test: `scripts/verify-tf-ingest.ts`

**Interfaces:**
- Produces: `parseIntradayBoost(payload): TfStockRow[]`; `parseBeacons(payload): Map<string, TfBeacon>`; `type TfBeacon = { dir: 'BULL' | 'BEAR'; time: string }`; `parseTfBoard('market_pulse', p)` → Intraday Boost rows; `TF_RACE_ENDPOINTS`, `TF_RACE_ENDPOINTS_SQL`.

- [ ] **Step 1: Failing tests** — append to `main()` in `scripts/verify-tf-ingest.ts`:

```ts
  // ── Intraday Boost is the race board (operator, 2026-10-08). Real rows. ──
  const pulsePayload = {
    status: 'SUCCESS',
    payload: {
      data: {
        intraday_boost: [
          { Symbol: 'INDIANB', param_0: 826.6, param_1: 813, param_2: 1.67, param_3: 4.27 },
          { Symbol: 'UNIONBANK', param_0: 172.99, param_1: 168.44, param_2: 2.7, param_3: 3.99 },
        ],
        breakout_beacon: [
          { Symbol: 'UNIONBANK', param_0: 2.7, param_1: 3.99, param_2: 'BULL', param_3: '10:15' },
          { Symbol: 'ASTRAL', param_0: 1.62, param_1: 2.95, param_2: 'BULL', param_3: '9:40' },
          { Symbol: 'ASTRAL', param_0: 1.62, param_1: 2.95, param_2: 'BEAR', param_3: '10:05' },
          { Symbol: 'JUNK', param_0: 1, param_1: 1, param_2: 'UP', param_3: 'soon' },
        ],
      },
    },
  };
  const boost = parseIntradayBoost(pulsePayload);
  check(
    'intraday boost: param_0..3 = LTP, prev close, %, R-Factor',
    boost.length === 2 && boost[0].symbol === 'INDIANB' && boost[0].ltp === 826.6 && boost[0].pctChange === 1.67 && boost[0].rFactor === 4.27,
  );
  check('parseTfBoard reads market_pulse as Intraday Boost', parseTfBoard('market_pulse', pulsePayload)[1]?.rFactor === 3.99);
  const beacons = parseBeacons(pulsePayload);
  check('beacon: BULL + time is read', beacons.get('UNIONBANK')?.dir === 'BULL' && beacons.get('UNIONBANK')?.time === '10:15');
  check('beacon: the LATEST signal for a symbol wins', beacons.get('ASTRAL')?.dir === 'BEAR');
  check('beacon: anything but BULL/BEAR + HH:MM is skipped', !beacons.has('JUNK'));
  check('beacon: no list, no beacons', parseBeacons({ payload: { data: {} } }).size === 0);
  check('race endpoints: Intraday Boost first', TF_RACE_ENDPOINTS[0] === 'market_pulse');
```

Add `parseBeacons, parseIntradayBoost` to the existing `@/lib/tf-live/parse` import and `TF_RACE_ENDPOINTS` to the `@/lib/tf-live/endpoints` import.

- [ ] **Step 2: Run, expect FAIL** — `pnpm exec tsx scripts/verify-tf-ingest.ts` → `does not provide an export named 'parseBeacons'`.

- [ ] **Step 3: Implement** — in `lib/tf-live/parse.ts`, after `parseMarketPulse`:

```ts
/**
 * TF's Intraday Boost as a race board: `market_pulse.data.intraday_boost`, whose
 * param_0..3 are LTP, prev close, % change and R-Factor — all four checked on the
 * 2026-10-08 captures ((p0−p1)/p1 = p2 on every row; p3 equals the sector_scope
 * R-Factor on 80 of 80). No sector baskets: those live in sector_scope.
 */
export function parseIntradayBoost(payload: unknown): TfStockRow[] {
  const list = parseMarketPulse(payload).find((l) => l.name === 'intraday_boost');
  return (list?.rows ?? []).map((r) => ({
    symbol: r.symbol.trim().toUpperCase(),
    baskets: [],
    ltp: num(r.params[0]),
    previousClose: num(r.params[1]),
    pctChange: num(r.params[2]),
    rFactor: num(r.params[3]),
  }));
}

export interface TfBeacon {
  dir: 'BULL' | 'BEAR';
  /** 'HH:MM' IST as TF prints it. */
  time: string;
}

/**
 * TF's breakout beacon per symbol (`market_pulse.data.breakout_beacon`). Only
 * param_2 (BULL/BEAR) and param_3 (HH:MM) are read — plain on every row;
 * param_0/1 are unconfirmed and ignored. A symbol listed more than once keeps
 * its LATEST signal. Malformed rows are skipped, never guessed.
 */
export function parseBeacons(payload: unknown): Map<string, TfBeacon> {
  const out = new Map<string, TfBeacon>();
  const list = parseMarketPulse(payload).find((l) => l.name === 'breakout_beacon');
  for (const { symbol, params } of list?.rows ?? []) {
    const dir = params[2];
    const time = params[3];
    if ((dir !== 'BULL' && dir !== 'BEAR') || typeof time !== 'string' || !/^\d{1,2}:\d{2}$/.test(time)) continue;
    const key = symbol.trim().toUpperCase();
    const prev = out.get(key);
    if (prev && prev.time.padStart(5, '0') >= time.padStart(5, '0')) continue;
    out.set(key, { dir, time });
  }
  return out;
}
```

In `parseTfBoard`, first line: `if (endpoint === 'market_pulse') return parseIntradayBoost(payload);`

In `lib/tf-live/endpoints.ts`, after `TF_BOARD_ENDPOINTS`:

```ts
/** Feeds the RUNNING RACE reads: TF's Intraday Boost (market_pulse — operator,
 *  2026-10-08) and, for days before it was captured, the full boards. A day with
 *  Intraday Boost captures races on those alone (see race.ts raceCaptures). */
export const TF_RACE_ENDPOINTS = ['market_pulse', ...TF_BOARD_ENDPOINTS] as const;
export const TF_RACE_ENDPOINTS_SQL = TF_RACE_ENDPOINTS.map((e) => `'${e}'`).join(', ');
```

- [ ] **Step 4: Run, expect PASS** — `pnpm exec tsx scripts/verify-tf-ingest.ts` → `ALL CHECKS PASSED`.

---

### Task 2: Selector — TF beacon is a required check

**Files:**
- Modify: `lib/tf-live/selector.ts`
- Modify: `lib/trade-suggest/engine.ts:1062-1091`, `lib/tf-live/context.ts`, `scripts/replay-tf-selector.ts` (every `TfSymbolContext` literal)
- Create: `lib/tf-live/beacon.ts`
- Test: `scripts/verify-tf-selector.ts`

**Interfaces:**
- Consumes: `parseBeacons`, `TfBeacon` (Task 1); `getTfLiveCaptureForDate(endpoint, date, atOrBefore?)` (store.ts).
- Produces: `TfSymbolContext.tfBeacon: 'BULL' | 'BEAR' | null`; `TfSelectorConfig.requireTfBeacon: boolean`; `TfSelectorRejections.noTfBeacon`; `getTfBeaconsAt(date, atOrBeforeIso?): Promise<Map<string, TfBeacon>>`; `buildRecordedTfContext(date, entries, asOfMinuteIST, beacons)`.

- [ ] **Step 1: Failing tests** — in `scripts/verify-tf-selector.ts`, give the `ok()` context helper `tfBeacon: 'BULL'` and pass `tfBeacon: 'BEAR'` wherever a fixture is a PE (negative %) runner; then add a section:

```ts
  // ── TF beacon must agree with our ORB (operator, 2026-10-08: "both") ──
  {
    const up = race.runners.filter((r) => (r.pctChange ?? 0) > 0).slice(0, 1);
    const sym = up[0]?.symbol ?? '';
    const pick = (b: 'BULL' | 'BEAR' | null) =>
      selectTfCandidates(up, new Map([[sym, ok({ tfBeacon: b })]])).candidates.length;
    check('beacon: a CE needs a BULL beacon — present, it is picked', up.length === 1 && pick('BULL') === 1);
    check('beacon: no beacon rejects (fail closed)', pick(null) === 0);
    check('beacon: a BEAR beacon on a CE rejects', pick('BEAR') === 0);
    const r = selectTfCandidates(up, new Map([[sym, ok({ tfBeacon: null })]])).rejected;
    check('beacon: the rejection is counted by name', r.noTfBeacon === 1);
  }
```

(`race` = an existing `raceAtMinute(...)` result in the file with at least one positive-% runner; reuse the one used by the "frozen R" section.)

- [ ] **Step 2: Run, expect FAIL** — `pnpm exec tsx scripts/verify-tf-selector.ts` → type error / ❌ on the beacon checks.

- [ ] **Step 3: Implement** — `lib/tf-live/selector.ts`:

```ts
// TfSymbolContext, after `breakout`:
  /** TradeFinder's own breakout beacon for this symbol (market_pulse
   *  breakout_beacon), or null when TF has not flagged it. Must agree with the
   *  trade's side (operator, 2026-10-08: our ORB AND TF's beacon). */
  tfBeacon: 'BULL' | 'BEAR' | null;

// TfSelectorConfig:
  /** Require TF's breakout beacon in the trade's direction (BULL for CE, BEAR for PE). */
  requireTfBeacon: boolean;

// TfSelectorRejections + emptyRejections: noTfBeacon: number / noTfBeacon: 0
// DEFAULT_TF_SELECTOR_CONFIG: requireTfBeacon: true,

// after gate ③ (breakout):
    // ③b TF's own breakout beacon must agree. Null = TF has not flagged it = reject.
    if (cfg.requireTfBeacon && ctx.tfBeacon !== (side === 'CE' ? 'BULL' : 'BEAR')) {
      rejected.noTfBeacon++;
      continue;
    }

// candidate reasons, after the ORB line:
      `TF breakout beacon ${ctx.tfBeacon} agrees`,

// describeRejections parts:
    [r.noTfBeacon, 'no TF breakout beacon in that direction'],
```

Create `lib/tf-live/beacon.ts`:

```ts
/**
 * TF breakout beacons for one session, from the stored market_pulse captures.
 * Fail closed: no capture → empty map → every name fails the beacon check.
 */
import { parseBeacons, type TfBeacon } from '@/lib/tf-live/parse';
import { getTfLiveCaptureForDate } from '@/lib/tf-live/store';

/** Beacons from the last market_pulse capture on `date` (IST) at or before `atOrBeforeIso`. */
export async function getTfBeaconsAt(date: string, atOrBeforeIso?: string): Promise<Map<string, TfBeacon>> {
  const capture = await getTfLiveCaptureForDate('market_pulse', date, atOrBeforeIso);
  return capture ? parseBeacons(capture.payload) : new Map();
}
```

`lib/tf-live/context.ts` — add a required 4th parameter `beacons: ReadonlyMap<string, TfBeacon>` to `buildRecordedTfContext`; set `tfBeacon: beacons.get(symbol)?.dir ?? null` in both the `empty` literal and the full literal.

`lib/trade-suggest/engine.ts` — before the context loop: `const beacons = await getTfBeaconsAt(date, race.capturedAt ?? undefined).catch(() => new Map());` and in `context.set(...)`: `tfBeacon: beacons.get(runner.symbol)?.dir ?? null,`.

`scripts/replay-tf-selector.ts` — in its `TfSymbolContext` literal add `tfBeacon: beacons.get(r.symbol)?.dir ?? null` where `beacons = await getTfBeaconsAt(date, new Date(\`${date}T${hh}:${mm}:59+05:30\`).toISOString())` for the replayed minute.

- [ ] **Step 4: Run, expect PASS** — `pnpm exec tsx scripts/verify-tf-selector.ts` → `N passed, 0 failed`; `pnpm typecheck` and `pnpm typecheck:scripts` clean (every context literal now carries `tfBeacon`).

---

### Task 2b: 15-min ORB for the TF selector, 30-min as shadow

**Files:** Modify `lib/signals/session-context.ts`, `lib/tf-live/selector.ts` (context gains `breakout30`), `lib/tf-live/context.ts`, `lib/trade-suggest/engine.ts`, `scripts/replay-tf-selector.ts`. Test: `scripts/verify-tf-selector.ts`.

- [ ] **Failing tests:** bars 09:15–09:40 where 09:15–09:25 range is 100–102 and 09:30–09:40 trades 103 → `deriveSessionContext` gives `openRange15High 102`, `openRange15Complete true` once the 09:25 bar is seen, while `openRangeHigh` (30-min) is 103; before the 09:25 bar `openRange15Complete` is false.
- [ ] **Implement:** in `deriveSessionContext` add `openRange15High`, `openRange15Low`, `openRange15Complete` (bars with 555 ≤ minute < 570; complete when a bar ≥ 565 is seen). `TfSymbolContext.breakout` is computed from the 15-min range; new `breakout30: boolean | null` from the 30-min range, carried into candidate `reasons` (`30-min ORB: cleared / not cleared / not complete`) so trade_suggestions records it for the later comparison. The selector never reads `breakout30`.

### Task 3: Race reads Intraday Boost

**Files:**
- Modify: `lib/tf-live/race.ts` (`getTfBoardsForDate`, `getTfRaceForWindow`, export window start)
- Test: `scripts/verify-tf-selector.ts`

**Interfaces:**
- Consumes: `TF_RACE_ENDPOINTS_SQL`, `parseTfBoard` (Task 1).
- Produces: `raceCaptures(captures)` (exported for the bench); `RACE_WINDOW_START_MIN` (= 09:35).

- [ ] **Step 1: Failing test**:

```ts
  // ── A day with Intraday Boost captures races on those alone ──
  {
    const boost = { endpoint: 'market_pulse', payloadJson: '{"payload":{"data":{"intraday_boost":[]}}}' };
    const full = { endpoint: 'sector_scope', payloadJson: '{}' };
    const oldPulse = { endpoint: 'market_pulse', payloadJson: '{"payload":{"data":{"top_gainers":[]}}}' };
    check('race source: Intraday Boost captures win when present', raceCaptures([full, boost]).every((c) => c.endpoint === 'market_pulse'));
    check('race source: never mixes sources within a day', raceCaptures([full, boost]).length === 1);
    check('race source: no Intraday Boost → the full boards', raceCaptures([full, oldPulse]).every((c) => c.endpoint === 'sector_scope'));
  }
```

- [ ] **Step 2: Run, expect FAIL** (`raceCaptures` not exported).

- [ ] **Step 3: Implement** — in `race.ts`: rename the window constant export `export const RACE_WINDOW_START_MIN = WINDOW_START_MIN;`; import `TF_RACE_ENDPOINTS_SQL` instead of `TF_BOARD_ENDPOINTS_SQL`; switch both capture queries to `endpoint IN (${TF_RACE_ENDPOINTS_SQL})`, and run the fetched rows through:

```ts
/**
 * A day with TF Intraday Boost captures races on those alone (operator,
 * 2026-10-08: "Intraday Boost list is good"); older days fall back to the full
 * boards. Never mixes sources inside one day — the per-minute collapse keeps the
 * first capture of a minute, so mixing would let the source flip minute to minute.
 */
export function raceCaptures<T extends { endpoint: string; payloadJson: string | null }>(captures: T[]): T[] {
  const boost = captures.filter((c) => c.endpoint === 'market_pulse' && c.payloadJson?.includes('"intraday_boost"'));
  return boost.length > 0 ? boost : captures.filter((c) => c.endpoint !== 'market_pulse');
}
```

- [ ] **Step 4: Run, expect PASS**; existing race checks still pass.

---

### Task 4: Pure view helpers — gates, needs, trend, climbing-since, path, dropped, sector

**Files:**
- Create: `lib/tf-live/board-view.ts`
- Test: `scripts/verify-tf-selector.ts`

**Interfaces:**
- Consumes: `TfBoardAt` (race.ts), `TfSelectorConfig`, `TfSymbolContext`, `selectTfCandidates` (Task 2).
- Produces (exact):
  - `type Gate = boolean | null`; `interface GateStrip { climbing; moving; orb; beacon; pool; notExtended: Gate }`; `GATE_ORDER`; `GATE_LABEL`
  - `gateStrip(deltaR, pctChange, ctx | undefined, cfg): GateStrip`; `allPass(g): boolean`; `passedCount(g): number`
  - `firstNeed(g, ctx | undefined, cfg): string | null`
  - `rTrend(boards, symbol, asOfMin, band = 0.02): 'faster' | 'slower' | 'steady' | null`
  - `climbingSince(boards, symbol, asOfMin, minDeltaR, lookbackMin = 30): number | null`
  - `rPath(boards, symbol, fromMin, asOfMin): { minute: number; r: number }[]`
  - `droppedClimbers(boards, opts: { asOfMin; fromMin; topN; minDeltaR; lookbackMin?; onBoardNow: ReadonlySet<string> }): DroppedClimber[]` with `interface DroppedClimber { symbol; from: number; to: number; rankNow: number | null; rNow: number | null; deltaRNow: number | null }`
  - `pickSector(baskets: string[], values: ReadonlyMap<string, number>): { name: string; value: number } | null`

- [ ] **Step 1: Failing tests** (key ones; all go in one `{ }` block in `main()`):

```ts
  {
    const cfg = DEFAULT_TF_SELECTOR_CONFIG;
    // Consistency: all six gates true ⇔ the selector picks the name.
    const ctxs: TfSymbolContext[] = [
      ok(), ok({ breakout: false }), ok({ breakout: null }), ok({ tfBeacon: null }), ok({ tfBeacon: 'BEAR' }),
      ok({ premValueCr: 5 }), ok({ premValueCr: null }), ok({ sinceEntryPct: 3 }), ok({ sinceEntryPct: null }),
    ];
    const runner = { symbol: 'X', rankNow: 3, rankAtBaseline: 9, climb: 6, rFactorNow: 2.5, rFactorAgo: 2.0, deltaR: 0.5, pctChange: 1.2 };
    for (const [i, c] of ctxs.entries()) {
      for (const deltaR of [0.5, 0.01, null]) {
        const r = { ...runner, deltaR };
        const picked = selectTfCandidates([r], new Map([['X', c]]), cfg).candidates.length === 1;
        check(`gates ⇔ selector (#${i}, ΔR ${deltaR})`, allPass(gateStrip(deltaR, r.pctChange, c, cfg)) === picked);
      }
    }
    check('gates: no context is grey, never green', gateStrip(0.5, 1.2, undefined, cfg).orb === null);
    check('needs: names the first missing check', firstNeed(gateStrip(0.5, 1.2, ok({ breakout: false }), cfg), ok({ breakout: false }), cfg) === 'our 15-min opening-range breakout');
    check('needs: null when everything passes', firstNeed(gateStrip(0.5, 1.2, ok(), cfg), ok(), cfg) === null);

    const b = [
      board(600, [['A', 1.0, 1], ['B', 3.0, 1]]), // 10:00
      board(615, [['A', 1.1, 1], ['B', 3.0, 1]]), // 10:15
      board(630, [['A', 1.6, 1], ['B', 3.0, 1]]), // 10:30
    ];
    check('trend: +0.5 in the last 15 vs +0.1 before = faster', rTrend(b, 'A', 630) === 'faster');
    check('trend: flat both halves = steady', rTrend(b, 'B', 630) === 'steady');
    check('trend: not enough history = null', rTrend(b, 'A', 615) === null);
    check('climbing since: first board of the unbroken climb', climbingSince(b, 'A', 630, 0.05) === 630);
    check('climbing since: not climbing now = null', climbingSince(b, 'B', 630, 0.05) === null);
    check('path: one point per board in range', rPath(b, 'A', 600, 630).length === 3);

    const d = [
      board(575, [['A', 1.0, 1], ['Z', 0.5, 1]]),
      board(605, [['A', 1.5, 1], ['Z', 0.5, 1]]), // A climbing at 10:05
      board(640, [['Z', 2.0, 1], ['A', 1.0, 1]]), // A fell behind; topN 1 → A off the board
    ];
    const dropped = droppedClimbers(d, { asOfMin: 640, fromMin: 575, topN: 1, minDeltaR: 0.05, onBoardNow: new Set(['Z']) });
    check('dropped: a climber that left the top N stays listed', dropped.length === 1 && dropped[0].symbol === 'A' && dropped[0].from === 605 && dropped[0].rankNow === 2);
    check('dropped: a name on the board now is not repeated', !dropped.some((x) => x.symbol === 'Z'));

    const vals = new Map([['NIFTY PSU BANK', 3.25], ['NIFTY BANK', 0.04], ['NiFTY 50', -0.06]]);
    check('sector: skips the broad baskets', pickSector(['NiFTY 50', 'NIFTY PSU BANK'], vals)?.name === 'NIFTY PSU BANK');
    check('sector: none with a value = null', pickSector(['OTHERS'], vals) === null);
  }
```

Import `allPass, climbingSince, droppedClimbers, firstNeed, gateStrip, pickSector, rPath, rTrend` from `@/lib/tf-live/board-view`.

- [ ] **Step 2: Run, expect FAIL** (module missing).

- [ ] **Step 3: Implement** `lib/tf-live/board-view.ts` — the code in the "Task 4 code" appendix below.

- [ ] **Step 4: Run, expect PASS.**

---

### Task 5: `/api/tf/race` — the cockpit view, cached per minute

**Files:**
- Modify: `app/api/tf/race/route.ts`

**Interfaces:**
- Consumes: Tasks 1–4; `getTfLiveCaptureForDate`; `parseSectorScope`, `parseTfIndices`; `ENTRY_START_MIN`, `ENTRY_END_MIN` (`lib/auto-trade/config.ts`).
- Produces (response additions): per board row `gates`, `needs`, `trend`, `climbingSince`, `rPath`, `beacon`, `sector`; top level `dropped: DroppedClimber[]`, `windowStartMin`, `windowEndMin`. Removes `screen`.

- [ ] **Step 1:** Replace the `screenDaily` block (no reader) and its import.
- [ ] **Step 2:** In the board block: `beacons = await getTfBeaconsAt(date, boards.at(-1)?.capturedAt)`; pass to `buildRecordedTfContext(date, entries, asOfMinute, beacons)`; read sector capture `getTfLiveCaptureForDate('sector_scope', date, boards.at(-1)?.capturedAt)` → `basketsBySymbol` from `parseSectorScope`, `sectorValues` from `parseTfIndices('sector_scope', …)`; per row add the six fields via Task 4 helpers; `dropped = droppedClimbers(boards, { asOfMin: asOfMinute, fromMin: RACE_WINDOW_START_MIN, topN: TF_RACE_MAX_RANK, minDeltaR: LIVE_TF_SELECTOR_CONFIG.minDeltaR, onBoardNow: new Set(full.runners.map((r) => r.symbol)) })`.
- [ ] **Step 3:** Fallback-date query and capture-status use `TF_RACE_ENDPOINTS_SQL`.
- [ ] **Step 4:** Cache: before any work, `SELECT MAX(capturedAt) FROM tf_live_captures WHERE endpoint IN (${TF_RACE_ENDPOINTS_SQL}) AND status='success' AND <IST date> = ?`; key `${today}|${latest}|${nowMin}`; serve `globalThis.__tfRaceCache.body` on a hit; store only `success: true` bodies.
- [ ] **Step 5: Verify** — `pnpm typecheck`; local API smoke (insert one real market_pulse + sector_scope capture into a DB copy, GET `/api/tf/race`, assert `board[0].gates`, `dropped`, `windowStartMin === 585`; delete rows).

---

### Task 6: The card

**Files:**
- Modify (rewrite): `app/live/_components/tf-race-card.tsx`

- [ ] **Step 1:** Rewrite per spec §Card — header (board time amber past 10 min; "entries open 09:45" / "closes in N min" / "closed"), one-line caution, TAKE rows (side badge, symbol, %, TF R, ↑ΔR/30m + trend, beacon chip, sector chip, six dots with names), WATCH (climbing, not TAKE; sorted by `passedCount` desc then R; dots + `needs:`; tap to expand numbers; chart icon), STALLED (collapsed), DROPPED (collapsed; `SYMBOL · climbing HH:MM–HH:MM · now #N R x.xx` or `left Intraday Boost`). Poll 30 s on weekdays 09:15–15:30 IST, else 5 min. Withheld verdict → existing notice, no TAKE, dots still rendered. Phone width: rows `flex-wrap`, no hover-only information. Remove `RunnerRow`, `ScreenBadge`, `RankSparkline` and the runners fallback.
- [ ] **Step 2: Verify** — `pnpm typecheck`, `pnpm lint`; render `/live` locally against the smoke data from Task 5.

---

### Task 7: Docs

- [ ] `CLAUDE.md` "TF Running Race is THE trade selector": Intraday Boost is the race source; TF beacon is a required gate (both ORB and beacon, operator 2026-10-08) and is measured forward via the `noTfBeacon` rejection count — no history exists to replay it; entries 09:45–11:00, measuring from 09:35.
- [ ] Spec: mark the six-dot strip (ORB and TF beacon are separate gates).

### Task 8: Gate and hand-off

- [ ] Run the full CI set (typecheck, typecheck:scripts, lint, every `verify-*.ts` in the workflow); report; ask the operator before `git add` / commit / deploy.

---

## Appendix — Task 4 code (`lib/tf-live/board-view.ts`)

```ts
/**
 * What the /live TF Climbers cockpit shows per name — pure, so CI can pin it.
 * Spec: docs/superpowers/specs/2026-10-08-tf-climbers-cockpit-design.md.
 *
 * gateStrip() mirrors selectTfCandidates() check for check: all six true ⇔ the
 * selector picks the name (verify-tf-selector.ts proves it), so the card can
 * never disagree with the auto-trader. Missing evidence is null (grey), never true.
 */
import type { TfBoardAt } from '@/lib/tf-live/race';
import type { TfSelectorConfig, TfSymbolContext } from '@/lib/tf-live/selector';

export type Gate = boolean | null;

export interface GateStrip {
  climbing: Gate;
  moving: Gate;
  orb: Gate;
  beacon: Gate;
  pool: Gate;
  notExtended: Gate;
}

/** The selector's own order. */
export const GATE_ORDER = ['climbing', 'moving', 'orb', 'beacon', 'pool', 'notExtended'] as const;

export const GATE_LABEL: Record<keyof GateStrip, string> = {
  climbing: 'climbing',
  moving: 'moving',
  orb: 'our ORB',
  beacon: 'TF beacon',
  pool: 'options pool',
  notExtended: 'not extended',
};

export function gateStrip(
  deltaR: number | null,
  pctChange: number | null,
  ctx: TfSymbolContext | undefined,
  cfg: TfSelectorConfig
): GateStrip {
  const side = pctChange == null ? null : pctChange > 0 ? 'CE' : 'PE';
  return {
    climbing: deltaR == null ? null : deltaR > cfg.minDeltaR,
    moving: pctChange == null ? null : Math.abs(pctChange) >= cfg.minAbsPctChange,
    orb: !cfg.requireBreakout ? true : ctx?.breakout == null ? null : ctx.breakout,
    // TF not flagging a name is an answer ("no beacon"), not missing data.
    beacon: !cfg.requireTfBeacon
      ? true
      : ctx == null || side == null
        ? null
        : ctx.tfBeacon === (side === 'CE' ? 'BULL' : 'BEAR'),
    pool: ctx?.premValueCr == null ? null : ctx.premValueCr >= cfg.minPremValueCr,
    // The selector passes an unrecorded 09:45 bar (selector.ts ⑤) — so does the strip,
    // but only when there is context at all.
    notExtended: ctx == null ? null : ctx.sinceEntryPct == null ? true : ctx.sinceEntryPct < cfg.maxSinceEntryPct,
  };
}

export const allPass = (g: GateStrip): boolean => GATE_ORDER.every((k) => g[k] === true);
export const passedCount = (g: GateStrip): number => GATE_ORDER.filter((k) => g[k] === true).length;

/** Plain English for the first check that is not passed, or null. Read as "needs: …". */
export function firstNeed(g: GateStrip, ctx: TfSymbolContext | undefined, cfg: TfSelectorConfig): string | null {
  for (const k of GATE_ORDER) {
    if (g[k] === true) continue;
    const missing = g[k] == null;
    switch (k) {
      case 'climbing':
        return missing ? 'an earlier board to measure the 30-min rate' : 'R-Factor to resume climbing (flat over 30 min)';
      case 'moving':
        return missing ? 'a % change from TF' : `a move of at least ${cfg.minAbsPctChange}% to set the side`;
      case 'orb':
        return missing ? 'the 15-min opening range (complete at 09:30)' : 'our 15-min opening-range breakout';
      case 'beacon':
        return missing ? 'TF breakout beacon data' : 'TF breakout beacon in the trade direction';
      case 'pool':
        return missing
          ? 'an options premium reading'
          : `options pool of ₹${cfg.minPremValueCr} Cr (has ₹${Math.round(ctx?.premValueCr ?? 0)} Cr)`;
      case 'notExtended':
        return missing
          ? 'recorded price data'
          : `a pullback — ${(ctx?.sinceEntryPct ?? 0).toFixed(1)}% extended since 09:45 (max ${cfg.maxSinceEntryPct}%)`;
    }
  }
  return null;
}

/** TF R-Factor on the last board at or before `minute`; null when none / not listed. */
function rAt(boards: TfBoardAt[], symbol: string, minute: number): number | null {
  for (let i = boards.length - 1; i >= 0; i--) {
    if (boards[i].minuteIST <= minute) return boards[i].rFactor.get(symbol) ?? null;
  }
  return null;
}

/** Is the money arriving faster or slower? Gain over the last 15 min vs the 15 before. */
export function rTrend(
  boards: TfBoardAt[],
  symbol: string,
  asOfMin: number,
  band = 0.02
): 'faster' | 'slower' | 'steady' | null {
  const now = rAt(boards, symbol, asOfMin);
  const m15 = rAt(boards, symbol, asOfMin - 15);
  const m30 = rAt(boards, symbol, asOfMin - 30);
  if (now == null || m15 == null || m30 == null) return null;
  const diff = now - m15 - (m15 - m30);
  return diff > band ? 'faster' : diff < -band ? 'slower' : 'steady';
}

/** First board minute of the CURRENT unbroken run of 30-min gains above `minDeltaR`. */
export function climbingSince(
  boards: TfBoardAt[],
  symbol: string,
  asOfMin: number,
  minDeltaR: number,
  lookbackMin = 30
): number | null {
  const upTo = boards.filter((b) => b.minuteIST <= asOfMin);
  let since: number | null = null;
  for (let i = upTo.length - 1; i >= 0; i--) {
    const r = upTo[i].rFactor.get(symbol);
    const ago = rAt(upTo, symbol, upTo[i].minuteIST - lookbackMin);
    if (r == null || ago == null || r - ago <= minDeltaR) break;
    since = upTo[i].minuteIST;
  }
  return since;
}

/** TF R-Factor at every board in [fromMin, asOfMin] — the card's sparkline. */
export function rPath(boards: TfBoardAt[], symbol: string, fromMin: number, asOfMin: number): { minute: number; r: number }[] {
  const out: { minute: number; r: number }[] = [];
  for (const b of boards) {
    if (b.minuteIST < fromMin || b.minuteIST > asOfMin) continue;
    const r = b.rFactor.get(symbol);
    if (r != null) out.push({ minute: b.minuteIST, r });
  }
  return out;
}

export interface DroppedClimber {
  symbol: string;
  /** First and last board minute it was climbing inside the top N. */
  from: number;
  to: number;
  /** Where it is now; null = no longer on the board at all (left Intraday Boost). */
  rankNow: number | null;
  rNow: number | null;
  deltaRNow: number | null;
}

/** Names that climbed inside the top N earlier today but are off the top N now —
 *  kept visible (operator, 2026-10-08), most recent drop first. */
export function droppedClimbers(
  boards: TfBoardAt[],
  opts: { asOfMin: number; fromMin: number; topN: number; minDeltaR: number; lookbackMin?: number; onBoardNow: ReadonlySet<string> }
): DroppedClimber[] {
  const lookback = opts.lookbackMin ?? 30;
  const inRange = boards.filter((b) => b.minuteIST >= opts.fromMin && b.minuteIST <= opts.asOfMin);
  const spans = new Map<string, { from: number; to: number }>();
  for (const b of inRange) {
    for (const [symbol, rank] of b.rank) {
      if (rank > opts.topN || opts.onBoardNow.has(symbol)) continue;
      const r = b.rFactor.get(symbol);
      const ago = rAt(boards, symbol, b.minuteIST - lookback);
      if (r == null || ago == null || r - ago <= opts.minDeltaR) continue;
      const span = spans.get(symbol);
      spans.set(symbol, span ? { from: span.from, to: b.minuteIST } : { from: b.minuteIST, to: b.minuteIST });
    }
  }
  const now = inRange.at(-1);
  return [...spans]
    .map(([symbol, s]) => {
      const rNow = now?.rFactor.get(symbol) ?? null;
      const ago = rAt(boards, symbol, opts.asOfMin - lookback);
      return {
        symbol,
        from: s.from,
        to: s.to,
        rankNow: now?.rank.get(symbol) ?? null,
        rNow,
        deltaRNow: rNow == null || ago == null ? null : rNow - ago,
      };
    })
    .sort((a, b) => b.to - a.to);
}

/** Broad baskets are not sectors. Compared upper-case: TF writes "NiFTY 50". */
const BROAD_BASKETS = new Set(['NIFTY 50', 'SENSEX', 'NIFTY MID SELECT', 'OTHERS']);

/** The stock's first industry basket (TF's order) that has a TF sector value. */
export function pickSector(baskets: string[], values: ReadonlyMap<string, number>): { name: string; value: number } | null {
  for (const name of baskets) {
    if (BROAD_BASKETS.has(name.toUpperCase())) continue;
    const value = values.get(name);
    if (value != null) return { name, value };
  }
  return null;
}
```
