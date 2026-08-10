/**
 * TradeFinder breakout detector — the orchestrator.
 *
 * deriveBreakoutContext (SLOW): from today's completed 5-min bars + EOD level
 * inputs → morning-test state + the named-level ladders. Cached by the caller
 * (refresh on the 5-min candle grid).
 *
 * evaluateBreakout (FAST): live LTP (+ live R-Factor for the efficiency check)
 * against the cached context → graded BreakoutSignal, every poll (~7s). This
 * is what makes the strategy real-time despite 5-min bars: levels move slowly,
 * price moves fast.
 */

import { deriveMorningTest } from './morning-test';
import { buildLevels, type LevelInputs } from './levels';
import type { SwingBar } from './swings';
import type { BreakoutContext, BreakoutGrade, BreakoutSignal } from './types';
import { rFactorAtRaw } from '@/lib/r-factor/scale';

/** Check 2 pass — R-Factor at/above "moderate" (raw midpoint) on the live 1–10 scale. */
export const EFFICIENCY_MIN_RFACTOR = rFactorAtRaw(0.5); // raw midpoint ("moderate")

/**
 * Morning-break tolerance (%) — a break only counts when price trades this far
 * beyond the morning level, filtering stop-hunt ticks. Backtest over the 320-
 * trade TF book (scripts/backtest-breakout.ts): at 0 the fakeout flag fired on
 * 12 entry-time reads that were ALL TF wins (paisa-deep "breaks"); a small
 * tolerance keeps the genuine TCS-profile warnings without those false alarms.
 */
export const MORNING_BREAK_TOLERANCE_PCT = 0.1;

export interface DetectorOptions {
  /** Override the morning-break tolerance (%); default MORNING_BREAK_TOLERANCE_PCT. */
  breakTolerancePct?: number;
}

/** Build the slow context. Returns null when there are no usable bars yet. */
export function deriveBreakoutContext(bars: SwingBar[], levels: LevelInputs, opts: DetectorOptions = {}): BreakoutContext | null {
  const usable = bars.filter((b) => b.high > 0 && b.low > 0);
  if (usable.length === 0) return null;
  const breakTolerancePct = opts.breakTolerancePct ?? MORNING_BREAK_TOLERANCE_PCT;
  const morning = deriveMorningTest(usable, undefined, breakTolerancePct);
  const { resistances, supports } = buildLevels(usable, levels);
  return { morning, resistances, supports, barsUsed: usable.length, breakTolerancePct };
}

interface SideRead {
  morningTest: 'held' | 'broken' | 'pending';
  cleared: { name: string; price: number }[];
  next: { name: string; price: number } | null;
}

/** Evaluate one side of the ladder against the live price. */
function readSide(ctx: BreakoutContext, ltp: number, side: 'bullish' | 'bearish'): SideRead {
  const m = ctx.morning;
  const tol = ctx.breakTolerancePct / 100;
  let morningTest: SideRead['morningTest'] = 'pending';
  if (m.complete) {
    if (side === 'bullish') {
      // Bar-confirmed break is sticky; a live tick below the morning low counts
      // immediately (don't wait for the 5-min bar to record the failure). The
      // same tolerance the bar test uses applies here.
      const brokenLive = m.morningLow != null && ltp < m.morningLow * (1 - tol);
      morningTest = m.lowBroken || brokenLive ? 'broken' : 'held';
    } else {
      const brokenLive = m.morningHigh != null && ltp > m.morningHigh * (1 + tol);
      morningTest = m.highBroken || brokenLive ? 'broken' : 'held';
    }
  }
  const ladder = side === 'bullish' ? ctx.resistances : ctx.supports;
  const cleared: SideRead['cleared'] = [];
  let next: SideRead['next'] = null;
  for (const l of ladder) {
    const isCleared = side === 'bullish' ? ltp > l.price : ltp < l.price;
    if (isCleared) cleared.push({ name: l.name, price: l.price });
    else if (next === null) next = { name: l.name, price: l.price }; // ladders are sorted nearest-first
  }
  return { morningTest, cleared, next };
}

function gradeSide(read: SideRead, rFactor: number | null): BreakoutGrade {
  const n = read.cleared.length;
  if (read.morningTest === 'pending') return 'none';
  if (read.morningTest === 'broken') return n >= 1 ? 'fakeout-risk' : 'none';
  // Morning test held:
  if (n >= 2 && rFactor != null && rFactor >= EFFICIENCY_MIN_RFACTOR) return 'strong';
  if (n >= 1) return 'confirmed';
  return 'watch';
}

const GRADE_RANK: Record<BreakoutGrade, number> = { strong: 4, confirmed: 3, watch: 2, 'fakeout-risk': 1, none: 0 };

/**
 * Grade the live price against the cached context. Both sides are read; the
 * stronger one wins (tie → the side price has actually moved toward).
 */
export function evaluateBreakout(
  ctx: BreakoutContext | null,
  ltp: number | null,
  rFactor: number | null,
  changePctOpen: number | null,
): BreakoutSignal | null {
  if (ctx == null || ltp == null || ltp <= 0) return null;

  const bull = readSide(ctx, ltp, 'bullish');
  const bear = readSide(ctx, ltp, 'bearish');
  const bullGrade = gradeSide(bull, rFactor);
  const bearGrade = gradeSide(bear, rFactor);

  let side: 'bullish' | 'bearish';
  if (GRADE_RANK[bullGrade] !== GRADE_RANK[bearGrade]) {
    side = GRADE_RANK[bullGrade] > GRADE_RANK[bearGrade] ? 'bullish' : 'bearish';
  } else if (bull.cleared.length !== bear.cleared.length) {
    side = bull.cleared.length > bear.cleared.length ? 'bullish' : 'bearish';
  } else {
    side = (changePctOpen ?? 0) >= 0 ? 'bullish' : 'bearish';
  }

  const read = side === 'bullish' ? bull : bear;
  const grade = side === 'bullish' ? bullGrade : bearGrade;
  const n = read.cleared.length;

  const parts: string[] = [];
  if (read.morningTest === 'pending') {
    parts.push('morning window still forming');
  } else if (side === 'bullish') {
    parts.push(read.morningTest === 'held' ? 'morning low held (buyers absorbing dips)' : 'morning low BROKE — fakeout profile, buyers burned capital early');
  } else {
    parts.push(read.morningTest === 'held' ? 'morning high held (sellers in control)' : 'morning high BROKE — fakeout profile');
  }
  if (n > 0) parts.push(`cleared ${n} level${n > 1 ? 's' : ''}: ${read.cleared.map((c) => c.name).join(', ')}`);
  else parts.push('no level cleared yet');
  if (grade === 'strong') parts.push('R-Factor efficient');
  if (read.next) parts.push(`next: ${read.next.name} ${read.next.price.toFixed(2)}`);

  return {
    direction: grade === 'none' ? null : side,
    grade,
    morningTest: read.morningTest,
    levelsCleared: n,
    clearedNames: read.cleared.map((c) => c.name),
    nextLevel: read.next,
    detail: parts.join(' · '),
  };
}
