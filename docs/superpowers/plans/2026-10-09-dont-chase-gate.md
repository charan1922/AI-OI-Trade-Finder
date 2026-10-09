# "Don't chase" gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refuse TF Climbers entries made after the move is already done (09:15 candle ≥ 1.25× ADR, or ≥ 2.0× ADR from the previous close in the trade direction).

**Architecture:** One new check in the pure selector (`selectTfCandidates`), fed by the existing `Stretch` measurement, which every context builder (live engine, /live card, replay) must now supply. The cockpit card's gate strip mirrors it as a 7th dot, and the "card all green ⇔ selector picks" proof is re-run over the new check.

**Tech Stack:** TypeScript, Next.js 16, Prisma raw SQL on SQLite, `tsx` benches (`check(name, ok)`).

## Global Constraints

- Limits: `maxFirstCandleAdr: 1.25`, `maxFromPrevCloseAdr: 2.0`; comparison is `>=` (exactly at the limit rejects).
- Missing evidence REJECTS (no ADR baseline, no 09:15 candle) — counted as `stretchUnknown`, never as `chasing`.
- ADR = 10-session mean (high − low) from `bhavcopy_days`, ≥ 5 sessions, newest ≤ 10 days old (existing `dayBaseline`).
- No new third-party dependency. Scripts load env with `process.loadEnvFile('.env.local')`.
- Gate before push = the full CI job: `pnpm typecheck`, `pnpm typecheck:scripts`, `pnpm lint`, `verify-dependency-hygiene` and every `verify-*.ts` the workflow runs.

---

### Task 1: The check in the selector

**Files:**
- Modify: `lib/tf-live/stretch.ts` (add `fromPrevCloseAdr`)
- Modify: `lib/tf-live/selector.ts` (required `stretch`, config, check ⑥, rejections, reasons, `describeRejections`)
- Test: `scripts/verify-tf-selector.ts`

**Interfaces:**
- Produces: `Stretch.fromPrevCloseAdr: number`; `TfSelectorConfig.maxFirstCandleAdr`, `.maxFromPrevCloseAdr`; `TfSelectorRejections.stretchUnknown`, `.chasing`; `TfSymbolContext.stretch: Stretch | null` (required).

- [ ] **Step 1: Failing tests** — in `verify-tf-selector.ts`, give the `ok()` fixture
  `stretch: { rangeUsed: 1, firstCandle: 0.4, fromPrevClosePct: 1.5, fromPrevCloseAdr: 1 }`, add to section 5's
  rejection cases:

```ts
['no daily baseline', { stretch: null }, 'stretchUnknown'],
['no 09:15 candle', { stretch: { rangeUsed: 1, firstCandle: null, fromPrevClosePct: 1, fromPrevCloseAdr: 1 } }, 'stretchUnknown'],
['long opening candle (COLPAL 1.62)', { stretch: { rangeUsed: 3, firstCandle: 1.62, fromPrevClosePct: 7, fromPrevCloseAdr: 1 } }, 'chasing'],
['already ran (TCS 2.37)', { stretch: { rangeUsed: 2.3, firstCandle: 0.5, fromPrevClosePct: 6, fromPrevCloseAdr: 2.37 } }, 'chasing'],
['opening candle exactly at the limit', { stretch: { rangeUsed: 1, firstCandle: 1.25, fromPrevClosePct: 1, fromPrevCloseAdr: 1 } }, 'chasing'],
['ran exactly the limit', { stretch: { rangeUsed: 1, firstCandle: 0.5, fromPrevClosePct: 1, fromPrevCloseAdr: 2 } }, 'chasing'],
```

  and a real-numbers block: COLPAL (1.62, 2.92) and TCS (1.54, 2.37) rejected as `chasing`; JUBLFOOD (1.02, 1.85),
  ITC (0.78, 1.80), ADANIGREEN (0.70, 1.56), ADANIENT (0.44, 1.34), ADANIPORTS (0.53, 1.33), RELIANCE (0.21, 0.90)
  each picked. Replace the "selector ignores stretch" check with these. Add `fromPrevCloseAdr` to the COLPAL
  `measureStretch` test (`(1859.2 − 1735.7) / 42.1 = 2.93`).
- [ ] **Step 2: Run** `pnpm exec tsx scripts/verify-tf-selector.ts` — expect failures (type errors / missing keys).
- [ ] **Step 3: Implement** — `stretch.ts`: `fromPrevCloseAdr: round2((side === 'CE' ? raw : -raw) * base.prevClose / 100 / base.adr)`
  (i.e. `(price − prevClose) × sign ÷ ADR`). `selector.ts`, after check ⑤:

```ts
if (ctx.stretch == null || ctx.stretch.firstCandle == null) { rejected.stretchUnknown++; continue; }
if (ctx.stretch.firstCandle >= cfg.maxFirstCandleAdr || ctx.stretch.fromPrevCloseAdr >= cfg.maxFromPrevCloseAdr) {
  rejected.chasing++;
  continue;
}
```

  plus a reasons line `not chasing: 09:15 candle 0.44× a normal day, 1.34× from yesterday's close` and two
  `describeRejections` entries: `'no daily range or opening candle to check for chasing'`, `'move already made (long opening candle or 2+ normal days from yesterday's close)'`.
- [ ] **Step 4: Run** the bench — all pass.

### Task 2: The 7th dot on the card

**Files:**
- Modify: `lib/tf-live/board-view.ts` (`GateStrip.notChasing`, `GATE_ORDER`, `GATE_LABEL`, `gateStrip`, `firstNeed`)
- Test: `scripts/verify-tf-selector.ts` section 15

**Interfaces:**
- Consumes: Task 1's `stretch`, config keys.
- Produces: `GateStrip.notChasing: boolean | null`.

- [ ] **Step 1: Failing test** — add to section 15's context list: `ok({ stretch: null })`,
  `ok({ stretch: { rangeUsed: 3, firstCandle: 1.62, fromPrevClosePct: 7, fromPrevCloseAdr: 2.9 } })`,
  `ok({ stretch: { rangeUsed: 2, firstCandle: 0.5, fromPrevClosePct: 6, fromPrevCloseAdr: 2.4 } })`; rename the check
  to "all seven dots"; assert `firstNeed` names the opening candle with its number.
- [ ] **Step 2: Implement** — `notChasing: ctx == null || ctx.stretch == null || ctx.stretch.firstCandle == null ? null : ctx.stretch.firstCandle < cfg.maxFirstCandleAdr && ctx.stretch.fromPrevCloseAdr < cfg.maxFromPrevCloseAdr`; label `'not chasing'`; needs text: missing → `'a normal-day range and the 09:15 candle (daily data)'`; candle → ``a calmer open — the 09:15 candle was ${x}× a normal day (max ${cfg.maxFirstCandleAdr}×)``; ran → ``room left — already ${x}× a normal day from yesterday's close (max ${cfg.maxFromPrevCloseAdr}×)``.
- [ ] **Step 3: Run** the bench — all pass.

### Task 3: Every builder supplies it; storage; docs; ship

**Files:**
- Modify: `lib/trade-suggest/engine.ts` (live context), `lib/tf-live/context.ts` (already measures — keep), `scripts/replay-tf-selector.ts`
- Modify: `lib/auto-trade/store.ts`, `lib/auto-trade/types.ts`, `prisma/schema.prisma`, `lib/auto-trade/tools/execute.ts` (`entryFromPrevCloseAdr`)
- Modify: `scripts/measure-stretch.ts` (bucket by `fromPrevCloseAdr`), `CLAUDE.md`, `app/live/_components/tf-race-card.tsx` (type only)

- [ ] **Step 1:** Engine — before the runner loop: `const baselines = await loadDayBaselines(race.runners.map((r) => r.symbol), date);` and in each context `stretch: measureStretch(bars, ltp, side, baselines.get(runner.symbol) ?? null)`.
- [ ] **Step 2:** Replay — same with `prior` bars and `entry`; the empty-context branch gets `stretch: null`.
- [ ] **Step 3:** Storage — column `entryFromPrevCloseAdr REAL`, insert/read/type/schema, set from `stretch?.fromPrevCloseAdr`.
- [ ] **Step 4:** Docs — CLAUDE.md: stretch bullet now says the two limits ARE a gate (operator rule 2026-10-09) with the table; "six dots" → "seven".
- [ ] **Step 5:** Full CI gate, replay 2026-10-06/08 to confirm the old picks still pick, commit, tag `v1.63.0`, release to `prod`, confirm on the box.
