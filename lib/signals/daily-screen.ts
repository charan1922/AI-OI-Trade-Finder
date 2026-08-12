/**
 * A Chartink-style daily screen, evaluated on TODAY's forming candle.
 *
 * The operator's own screener (2026-08-11), applied on top of the TF Running
 * Race so a climbing name can also be checked for momentum and liquidity:
 *
 *   Daily Close  > Daily VWAP
 *   Daily Close  > 1 day ago High
 *   Daily Volume > 500000
 *   Daily Close  > 900
 *
 * THE SMA-VOLUME CONDITION IS DELIBERATELY ABSENT. The original screen also had
 * `Daily Volume > SMA(Daily Volume, 20)`, which cannot mean anything inside the
 * race window: by 10:00 a stock has roughly a fifth of a normal day's volume, so
 * comparing that to a FULL-day 20-session average is false for essentially every
 * name until mid-afternoon. Rather than silently reinterpret it (a pace-adjusted
 * version was offered), the operator chose to drop it. Do not add it back on the
 * raw reading — it would empty this list every morning.
 *
 * ENTIRELY DB-BACKED, no broker call: today's 5-minute EQ bars in fyers_candles
 * give cumulative volume and the session VWAP, and bhavcopy_days gives the prior
 * session's high. This matters because the race card is otherwise a cheap DB
 * read, and /api/live/quote's Dhan gate is the one the trading page needs.
 *
 * FAILS CLOSED. A symbol with no candles today, or no prior bhavcopy session,
 * does NOT pass — it reports which checks could not be evaluated. "We could not
 * tell" must never render as "it qualifies".
 */
import { prisma } from '@/lib/db';

/** Absolute floor on today's traded shares. Low enough to clear early in the
 *  session for a liquid F&O name, which is the point — the race runs 09:35–11:00. */
export const MIN_DAILY_VOLUME = 500_000;
/** Price floor, straight from the operator's screener. */
export const MIN_DAILY_CLOSE = 900;

export interface ScreenCheck {
  key: 'vwap' | 'prevHigh' | 'volume' | 'price';
  label: string;
  /** null = could not be evaluated (missing data), which is NOT a pass. */
  pass: boolean | null;
  detail: string;
}

export interface ScreenResult {
  symbol: string;
  /** True only when every check evaluated AND passed. */
  passes: boolean;
  checks: ScreenCheck[];
  /** Today's numbers behind the checks, for the tooltip. */
  close: number | null;
  vwap: number | null;
  volume: number | null;
  priorDayHigh: number | null;
}

const n = (v: unknown): number | null => {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

/**
 * Evaluate the screen for `symbols` on `date` (an IST YYYY-MM-DD).
 * Two batched queries total, regardless of how many symbols are passed.
 */
export async function screenDaily(symbols: string[], date: string): Promise<Map<string, ScreenResult>> {
  const out = new Map<string, ScreenResult>();
  if (symbols.length === 0) return out;
  const placeholders = symbols.map(() => '?').join(',');

  // Today's forming daily candle, aggregated from the 5-minute EQ bars.
  // VWAP uses the typical price ((H+L+C)/3) per bar weighted by that bar's
  // volume — the standard definition. `close` is the LAST bar's close, which is
  // why the aggregate carries maxBucket alongside it.
  const todayRows = (await prisma.$queryRawUnsafe(
    `SELECT symbol,
            SUM(volume)                                   AS vol,
            SUM(((high + low + close) / 3.0) * volume)    AS pv,
            MAX(bucketTs)                                 AS maxBucket
       FROM fyers_candles
      WHERE instrument = 'EQ' AND date = ? AND volume > 0 AND symbol IN (${placeholders})
      GROUP BY symbol`,
    date,
    ...symbols,
  )) as { symbol: string; vol: number; pv: number; maxBucket: number }[];

  const lastCloseRows = (await prisma.$queryRawUnsafe(
    `SELECT c.symbol, c.close
       FROM fyers_candles c
       JOIN (SELECT symbol, MAX(bucketTs) AS mb
               FROM fyers_candles
              WHERE instrument = 'EQ' AND date = ? AND symbol IN (${placeholders})
              GROUP BY symbol) m
         ON m.symbol = c.symbol AND m.mb = c.bucketTs
      WHERE c.instrument = 'EQ' AND c.date = ?`,
    date,
    ...symbols,
    date,
  )) as { symbol: string; close: number }[];

  // Prior SESSION's high — strictly before `date`, so it is yesterday's finished
  // candle and never today's own partial one.
  const prevHighRows = (await prisma.$queryRawUnsafe(
    `SELECT b.symbol, b.eqHigh
       FROM bhavcopy_days b
       JOIN (SELECT symbol, MAX(date) AS d
               FROM bhavcopy_days
              WHERE date < ? AND symbol IN (${placeholders})
              GROUP BY symbol) m
         ON m.symbol = b.symbol AND m.d = b.date`,
    date,
    ...symbols,
  )) as { symbol: string; eqHigh: number }[];

  const agg = new Map(todayRows.map((r) => [r.symbol, r]));
  const closes = new Map(lastCloseRows.map((r) => [r.symbol, n(r.close)]));
  const prevHighs = new Map(prevHighRows.map((r) => [r.symbol, n(r.eqHigh)]));

  for (const symbol of symbols) {
    const a = agg.get(symbol);
    const volume = a ? n(a.vol) : null;
    const pv = a ? n(a.pv) : null;
    const vwap = volume != null && volume > 0 && pv != null ? pv / volume : null;
    const close = closes.get(symbol) ?? null;
    const priorDayHigh = prevHighs.get(symbol) ?? null;

    const checks: ScreenCheck[] = [
      {
        key: 'vwap',
        label: 'Close > VWAP',
        pass: close != null && vwap != null ? close > vwap : null,
        detail:
          close != null && vwap != null
            ? `close ${close.toFixed(2)} vs VWAP ${vwap.toFixed(2)}`
            : 'no intraday equity candles recorded yet today',
      },
      {
        key: 'prevHigh',
        label: "Close > prior day's high",
        pass: close != null && priorDayHigh != null ? close > priorDayHigh : null,
        detail:
          close != null && priorDayHigh != null
            ? `close ${close.toFixed(2)} vs prior high ${priorDayHigh.toFixed(2)}`
            : 'no prior bhavcopy session for this symbol',
      },
      {
        key: 'volume',
        label: `Volume > ${MIN_DAILY_VOLUME.toLocaleString('en-IN')}`,
        pass: volume != null ? volume > MIN_DAILY_VOLUME : null,
        detail: volume != null ? `${Math.round(volume).toLocaleString('en-IN')} shares so far` : 'no volume recorded today',
      },
      {
        key: 'price',
        label: `Close > ${MIN_DAILY_CLOSE}`,
        pass: close != null ? close > MIN_DAILY_CLOSE : null,
        detail: close != null ? `close ${close.toFixed(2)}` : 'no close available',
      },
    ];

    out.set(symbol, {
      symbol,
      // `=== true` on purpose: an unevaluated check (null) is not a pass.
      passes: checks.every((c) => c.pass === true),
      checks,
      close,
      vwap,
      volume,
      priorDayHigh,
    });
  }
  return out;
}
