/**
 * Honest, PATH-DEPENDENT spot grading for /trade-suggest calls
 * (backtest-trustworthiness fix, 2026-07-20).
 *
 * The old scorecard scored a "hit" as `maxUpPct >= 1%` over the WHOLE day —
 * path-independent and blind to the plan's stop: a trade that hit its stop and
 * only LATER recovered was scored a WIN (see store.ts isHit before this change).
 * This walks the 5-min bars in TIME and decides which of the plan's stop /
 * target is reached FIRST, so a stop-out stays a stop-out even if the name
 * recovers afterwards.
 *
 * PURE and replayable: no I/O, no clocks; the caller supplies CHRONOLOGICAL
 * bars — the same discipline as scoring.ts / reanchor.ts, so it grades
 * identically live and in replay.
 *
 * Conservative on ambiguity: with only 5-min OHLC we cannot know whether the
 * high or the low printed first inside a candle. When a single candle spans BOTH
 * the stop and the target, it is graded a STOP (the worse outcome) — we never
 * credit a target we cannot prove came first.
 */
import type { StoredFyersBar } from '@/lib/fyers/candle-store';

export type SpotOutcome = 'target' | 'stop' | 'timeout';

export interface SpotGrade {
  /** Which plan level was reached first, or 'timeout' if neither by the last bar. */
  outcome: SpotOutcome;
  /** Realised R against the plan's OWN risk: stop = −1, target = +plannedRR,
   *  timeout = signed (close − entry)/risk (always strictly inside (−1, +RR)). */
  outcomeR: number;
  /** Context (unchanged from the old scorecard): full-day excursions + close,
   *  all in spot % relative to entry. Kept so existing displays still work. */
  maxUpPct: number;
  maxDownPct: number;
  closePct: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const pctOf = (v: number, entry: number) => Math.round(((v - entry) / entry) * 10000) / 100;

export function gradeSpotPath(
  optionType: 'CE' | 'PE',
  entry: number,
  stop: number | null,
  target: number | null,
  bars: Pick<StoredFyersBar, 'high' | 'low' | 'close'>[],
): SpotGrade | null {
  const valid = bars.filter((b) => b.high > 0 && b.low > 0);
  if (valid.length === 0 || !(entry > 0) || stop == null || target == null) return null;

  const bull = optionType === 'CE';
  // The plan must be well-formed for the direction: stop on the risk side and
  // target on the reward side, with real risk. A degenerate plan can't be
  // honestly graded path-dependently → null (caller keeps the excursion-only view).
  const risk = bull ? entry - stop : stop - entry;
  const reward = bull ? target - entry : entry - target;
  if (!(risk > 0) || !(reward > 0)) return null;
  const plannedRR = round2(reward / risk);

  const maxUpPct = pctOf(Math.max(...valid.map((b) => b.high)), entry);
  const maxDownPct = pctOf(Math.min(...valid.map((b) => b.low)), entry);
  const closePct = pctOf(valid[valid.length - 1].close, entry);

  for (const b of valid) {
    const stopHit = bull ? b.low <= stop : b.high >= stop;
    const targetHit = bull ? b.high >= target : b.low <= target;
    // Stop is checked FIRST: a candle that spans both is graded a stop (we can't
    // prove the target printed first) — the honest, conservative call.
    if (stopHit) return { outcome: 'stop', outcomeR: -1, maxUpPct, maxDownPct, closePct };
    if (targetHit) return { outcome: 'target', outcomeR: plannedRR, maxUpPct, maxDownPct, closePct };
  }

  const close = valid[valid.length - 1].close;
  const timeoutR = round2((bull ? close - entry : entry - close) / risk);
  return { outcome: 'timeout', outcomeR: timeoutR, maxUpPct, maxDownPct, closePct };
}
