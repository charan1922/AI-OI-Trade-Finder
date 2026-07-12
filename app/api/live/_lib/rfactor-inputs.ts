/**
 * Assemble a live RFactorInput for one symbol — the bridge between this app's data
 * (live Dhan quote + bhavcopy baselines + morning candles) and the dependency-free
 * `lib/r-factor` library.
 *
 * The R-Factor here is INTRADAY-LIVE: it recomputes on every quote poll. The EOD
 * baselines (20-day averages, prior-day levels, opening range) are fixed anchors;
 * the live values (OI, LTP, spread, price move) change all day and move the score.
 * That is by design — it's an entry-timing signal, not TradeFinder's static daily R.
 *
 * Which factors run on the live path, and why:
 *   • OI level / intensity / direction — OI is a LEVEL, valid to compare any time.
 *   • Bid-ask spread                   — instantaneous, valid any time.
 *   • Breakout                         — live LTP vs opening-range / prior-day levels.
 *   • Turnover                         — a FLOW; the 20d full-day average is
 *     TIME-ADJUSTED to the fraction of the session elapsed, so a morning reading
 *     isn't biased low. Below ~8 min elapsed it's dropped (divisor too small).
 *   • Volume  — omitted (Dhan reports shares, bhavcopy lots; turnover in ₹ avoids
 *     the unit mismatch and carries the same participation signal).
 *   • Options (call/put OI, PCR) — omitted (no option chain on the live path).
 * Omitted factors report `available:false`; the library renormalizes over the rest.
 */

import type { RFactorInput } from '@/lib/r-factor';
import type { SessionContext } from '@/lib/signals/session-context';
import type { RFactorBaseline } from './rfactor-baselines';

/** NSE cash session: 09:15–15:30 IST = 375 minutes. */
const SESSION_START_MIN = 9 * 60 + 15;
const SESSION_MINUTES = 375;
/** Don't time-adjust turnover until this fraction of the session has elapsed. */
export const MIN_SESSION_FRACTION = 0.02;

/** Fraction of the trading session elapsed at `now`, in [0,1] (IST). */
export function sessionFractionElapsed(now: Date): number {
  const istSec = now.getTime() / 1000 + 5.5 * 3600;
  const minuteOfDay = Math.floor(((istSec % 86400) + 86400) % 86400 / 60);
  return Math.max(0, Math.min(1, (minuteOfDay - SESSION_START_MIN) / SESSION_MINUTES));
}

/** The live quote facts the route already derives for one symbol. */
export interface LiveQuoteFacts {
  symbol: string;
  ltp: number | null;
  changePctOpen: number | null;
  bid: number | null;
  ask: number | null;
  futOi: number | null;
  /** Live futures turnover ≈ VWAP × volume, in ₹. */
  turnover: number | null;
  /** Session high/low so far (equity OHLC), for the range-expansion factor. */
  dayHigh: number | null;
  dayLow: number | null;
}

/**
 * Build the RFactorInput, or null when there's no usable price (no point scoring).
 * Missing baselines / morning context degrade gracefully — the dependent factors
 * just report unavailable.
 */
export function buildLiveRFactorInput(
  q: LiveQuoteFacts,
  baseline: RFactorBaseline | undefined,
  morning: SessionContext | null,
  now: Date,
): RFactorInput | null {
  if (q.ltp == null || !(q.ltp > 0)) return null;

  // Direction basis: vs prior-day close (captures the full move incl. gap) when
  // available, else vs the day's open (what the route already has).
  const priceChangePct =
    baseline?.priorDayClose != null && baseline.priorDayClose > 0
      ? ((q.ltp - baseline.priorDayClose) / baseline.priorDayClose) * 100
      : (q.changePctOpen ?? 0);

  // Time-adjusted turnover baseline: compare live partial-day turnover to the
  // fraction of the 20-day full-day average that should have traded by now.
  const frac = sessionFractionElapsed(now);
  const turnover20dAvgAdj =
    baseline?.futTurnover20dAvg != null && frac > MIN_SESSION_FRACTION ? baseline.futTurnover20dAvg * frac : undefined;

  // Breakout reference: the opening range once it's fully formed (the intraday ORB
  // trigger), else prior-day high/low.
  const useORB = morning?.openRangeComplete === true && morning.openRangeHigh != null && morning.openRangeLow != null;
  const breakoutHigh = useORB ? (morning?.openRangeHigh ?? undefined) : (baseline?.priorDayHigh ?? undefined);
  const breakoutLow = useORB ? (morning?.openRangeLow ?? undefined) : (baseline?.priorDayLow ?? undefined);

  return {
    symbol: q.symbol,
    ltp: q.ltp,
    priceChangePct,
    futOi: q.futOi ?? undefined,
    futOiPrev: baseline?.futOiPrev ?? undefined,
    futOi20dAvg: baseline?.futOi20dAvg ?? undefined,
    // Only pass turnover when we have a time-comparable baseline for it.
    turnover: turnover20dAvgAdj != null ? (q.turnover ?? undefined) : undefined,
    turnover20dAvg: turnover20dAvgAdj,
    bid: q.bid ?? undefined,
    ask: q.ask ?? undefined,
    breakoutHigh,
    breakoutLow,
    dayHigh: q.dayHigh ?? undefined,
    dayLow: q.dayLow ?? undefined,
    rangeSpread20dAvg: baseline?.rangeSpread20dAvg ?? undefined,
    now,
    entryTimeIST: '09:45',
  };
}
