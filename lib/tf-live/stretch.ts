/**
 * How STRETCHED a stock already is when we consider an entry — measured against
 * its own normal day. PURE (no DB, no clock) so CI pins it.
 *
 * RECORDED, NOT A GATE (operator, 2026-10-09). The question came from three
 * paper entries that day, all calls bought after the stock had already run:
 *   COLPAL  first candle 1.62× a normal day, range used 2.99×, +7.1% vs prev close
 *   TCS     first candle 1.54×,              range used 2.32×, +5.8%
 *   EICHER  first candle 0.34×,              range used 1.55×, +3.6%
 * All three stocks then went sideways and every OPTION bled 4–10% — paying an
 * inflated premium after the move. But a gate could not be justified yet:
 *  - on 1,458 historical 30-min ORB breakouts (spot only), entries at ≥ 2.5×
 *    range used won 3 of 4, and no ADR measure separated winners cleanly;
 *  - 2026-10-08's good trend trades (ADANIENT — the trade TradeFinder took —
 *    and JUBLFOOD, +2R) were themselves at 1.41–1.73×, so a tight cutoff kills
 *    exactly the days TF does best on.
 * The missing evidence is OPTION P&L by stretch, which only forward paper trades
 * can supply. So every trade stores these numbers and
 * scripts/measure-stretch.ts reports option results by bucket. Promote to a gate
 * only from that report. Deliberately NOT shown to the AI: an untested number in
 * its prompt would act as an unmeasured gate and starve the measurement.
 */

/** Sessions averaged for the normal daily range. */
export const ADR_SESSIONS = 10;
/** Fewer usable sessions than this → no baseline (null, never a guess). */
export const ADR_MIN_SESSIONS = 5;
/** The newest daily bar must be at most this many calendar days old. */
export const ADR_MAX_STALE_DAYS = 10;

export interface DailyBar {
  date: string; // YYYY-MM-DD
  high: number;
  low: number;
  close: number;
}

export interface DayBaseline {
  /** Average (high − low) of the last ADR_SESSIONS sessions before the trade date. */
  adr: number;
  /** Previous session's official close. */
  prevClose: number;
}

export interface Stretch {
  /** Today's range so far (incl. the current price) ÷ the normal daily range. */
  rangeUsed: number;
  /** The 09:15 candle's range ÷ the normal daily range. Null without that candle. */
  firstCandle: number | null;
  /** Move from the previous close in the TRADE's direction, % (positive = already ran our way). */
  fromPrevClosePct: number;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Normal daily range + previous close from daily bars strictly BEFORE `tradeDate`. */
export function dayBaseline(days: DailyBar[], tradeDate: string): DayBaseline | null {
  const usable = days
    .filter(
      (d) =>
        d.date < tradeDate &&
        Number.isFinite(d.high) &&
        Number.isFinite(d.low) &&
        Number.isFinite(d.close) &&
        d.low > 0 &&
        d.high >= d.low &&
        d.close > 0
    )
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, ADR_SESSIONS);
  if (usable.length < ADR_MIN_SESSIONS) return null;
  const ageDays = (Date.parse(`${tradeDate}T00:00:00Z`) - Date.parse(`${usable[0].date}T00:00:00Z`)) / 86_400_000;
  if (!(ageDays > 0) || ageDays > ADR_MAX_STALE_DAYS) return null;
  const adr = usable.reduce((sum, d) => sum + (d.high - d.low), 0) / usable.length;
  if (!(adr > 0)) return null;
  return { adr, prevClose: usable[0].close };
}

/** IST minute-of-day of a bar-start epoch (seconds). IST has no DST. */
const istMinute = (bucketTs: number) => Math.floor(((bucketTs + 19_800) % 86_400) / 60);

/**
 * Stretch at a decision. `bars` = today's 5-min candles COMPLETED before the
 * decision; `price` = the price the decision is taken at. Null when the
 * baseline or the price is missing — never a fabricated number.
 */
export function measureStretch(
  bars: { bucketTs: number; high: number; low: number }[],
  price: number | null,
  side: 'CE' | 'PE',
  base: DayBaseline | null
): Stretch | null {
  if (base == null || price == null || !(price > 0)) return null;
  const valid = bars.filter((b) => b.high > 0 && b.low > 0 && b.high >= b.low);
  const hi = Math.max(price, ...valid.map((b) => b.high));
  const lo = Math.min(price, ...valid.map((b) => b.low));
  const first = valid.find((b) => istMinute(b.bucketTs) === 9 * 60 + 15);
  const raw = ((price - base.prevClose) / base.prevClose) * 100;
  return {
    rangeUsed: round2((hi - lo) / base.adr),
    firstCandle: first ? round2((first.high - first.low) / base.adr) : null,
    fromPrevClosePct: round2(side === 'CE' ? raw : -raw),
  };
}
