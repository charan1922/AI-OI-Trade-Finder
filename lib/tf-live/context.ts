/**
 * Per-symbol evidence for the TF selector, built from RECORDED data
 * (fyers_candles + oi_intraday) rather than live broker calls.
 *
 * WHY A SECOND BUILDER EXISTS. The scanner assembles the same `TfSymbolContext`
 * from LIVE quote rows, because during market hours that is the freshest truth
 * and it is what the money path must act on. This one reads what was recorded,
 * which is the correct source for two cases the live one cannot serve:
 *
 *  - the /live TF Climbers card off-hours, where the board being shown is a
 *    RETAINED closing snapshot and live quotes describe a different day;
 *  - any point-in-time replay, where "live" does not exist at all.
 *
 * The two are not interchangeable and deliberately not merged: a display card
 * reading a live quote for a previous session's board would silently mix days,
 * which is the exact class of bug the closing-snapshot work exists to prevent.
 *
 * POINT-IN-TIME. Everything is computed from bars STRICTLY BEFORE the bucket
 * containing `asOfMinuteIST`, and from the last oi_intraday row at or before it.
 * A verdict shown against a 10:30 board is therefore the verdict that was
 * available at 10:30 — never one improved by the rest of the day.
 *
 * MISSING EVIDENCE STAYS NULL. Never zero, never false. The selector rejects a
 * missing breakout or premium pool; Supertrend is display-only and ignored.
 * A fabricated 0 would read as "thin" instead of "unknown" and hide the real
 * data-quality failure.
 */

import { prisma } from '@/lib/db';
import { getFyersCandles, type StoredFyersBar } from '@/lib/fyers/candle-store';
import { deriveSessionContext } from '@/lib/signals/session-context';
import { supertrend } from '@/lib/signals/indicators';
import type { TfBeacon } from '@/lib/tf-live/parse';
import type { TfSymbolContext } from '@/lib/tf-live/selector';
import { dayBaseline, measureStretch, type DailyBar, type DayBaseline, type Stretch } from '@/lib/tf-live/stretch';

/** Minimum bars before the entry bucket for Supertrend(10,3) to mean anything. */
const MIN_BARS_FOR_TREND = 10;

/** IST minute-of-day for a 5-min bucket timestamp (seconds). */
function bucketMinuteIST(bucketTs: number): number {
  const parts = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(bucketTs * 1000));
  return (
    Number(parts.find((p) => p.type === 'hour')?.value ?? 0) * 60 +
    Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
  );
}

/**
 * Direction-aware move since 09:45 (%), positive = our way, anchored on the 09:45
 * CANDLE's open — the true price at the entry-window open. Never anchored on a
 * recorded quote: on 2026-10-08 the recorded price sat at 1318.3 from 09:22 to
 * 10:05 (stale), so ADANIGREEN read 3.45% extended and was rejected while the
 * 09:45 candle opened at 1300.8 (1.93%). Null without a 09:45 candle or a price.
 */
export function sinceEntryFromBars(
  bars: { bucketTs: number; open: number }[],
  price: number | null,
  side: 'CE' | 'PE'
): number | null {
  if (price == null || !(price > 0)) return null;
  const at945 = bars.find((b) => b.open > 0 && bucketMinuteIST(b.bucketTs) >= 9 * 60 + 45);
  if (!at945) return null;
  const raw = ((price - at945.open) / at945.open) * 100;
  return side === 'CE' ? raw : -raw;
}

/** Price beyond an opening range in the trade's direction; null until the range is complete. */
export function orbBreak(
  side: 'CE' | 'PE',
  price: number | null,
  complete: boolean,
  high: number | null,
  low: number | null
): boolean | null {
  if (price == null || !complete) return null;
  return side === 'CE' ? high != null && price > high : low != null && price < low;
}

/**
 * Normal daily range + previous close per symbol, from the OFFICIAL NSE daily
 * bars (bhavcopy_days) strictly before `date` — verified 2026-10-09 to match
 * our own 5-min candles' day range exactly on most days, and to be the wider
 * (complete) one where they differ. Missing → absent from the map (never a guess).
 */
export async function loadDayBaselines(symbols: string[], date: string): Promise<Map<string, DayBaseline>> {
  const out = new Map<string, DayBaseline>();
  const unique = [...new Set(symbols)];
  if (unique.length === 0) return out;
  const since = new Date(Date.parse(`${date}T00:00:00Z`) - 30 * 86_400_000).toISOString().slice(0, 10);
  try {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT symbol, date, eqHigh AS high, eqLow AS low, eqClose AS close FROM bhavcopy_days
        WHERE date < ? AND date >= ? AND symbol IN (${unique.map(() => '?').join(',')})`,
      date,
      since,
      ...unique
    )) as ({ symbol: string } & DailyBar)[];
    const bySymbol = new Map<string, DailyBar[]>();
    for (const r of rows) {
      const list = bySymbol.get(r.symbol) ?? [];
      list.push({ date: String(r.date), high: Number(r.high), low: Number(r.low), close: Number(r.close) });
      bySymbol.set(r.symbol, list);
    }
    for (const [symbol, days] of bySymbol) {
      const base = dayBaseline(days, date);
      if (base) out.set(symbol, base);
    }
  } catch (error) {
    console.warn(`[TfContext] bhavcopy_days unreadable for ${date}: ${(error as Error).message}`);
  }
  return out;
}

export interface TfContextRequest {
  symbol: string;
  /** Direction under consideration — breakout and display-only Supertrend are direction-aware. */
  side: 'CE' | 'PE';
}

/**
 * Build `TfSymbolContext` for each requested symbol as of `asOfMinuteIST`.
 *
 * One batched oi_intraday query for the whole set plus one candle read per
 * symbol (local SQLite, the same read the scanner already does per candidate).
 * Never throws: a per-symbol failure yields an all-null context, which the
 * selector rejects — a display card must not 500 because one symbol is missing.
 */
export async function buildRecordedTfContext(
  date: string,
  entries: TfContextRequest[],
  asOfMinuteIST: number,
  /** TF breakout beacons as of the same moment (getTfBeaconsAt). Required, so no
   *  caller can forget it: a missing beacon rejects, it never passes. */
  beacons: ReadonlyMap<string, TfBeacon>
): Promise<Map<string, TfSymbolContext>> {
  const out = new Map<string, TfSymbolContext>();
  if (entries.length === 0) return out;

  // Options premium pool, per symbol, last reading at or before the cutoff.
  const premBySymbol = new Map<string, number>();
  try {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT symbol, bucketTs, premValueCr FROM oi_intraday WHERE date = ? ORDER BY symbol, bucketTs ASC`,
      date
    )) as { symbol: string; bucketTs: number | bigint; premValueCr: number | null }[];
    for (const row of rows) {
      const ts = Number(row.bucketTs);
      if (bucketMinuteIST(ts) > asOfMinuteIST) continue;
      if (row.premValueCr == null) continue;
      premBySymbol.set(row.symbol, Number(row.premValueCr)); // ascending → last wins
    }
  } catch (error) {
    // No premium readings at all: every symbol gets null and is rejected for
    // missing evidence. Loud in the log, silent-but-safe in the result.
    console.warn(`[TfContext] oi_intraday unreadable for ${date}: ${(error as Error).message}`);
  }

  const baselines = await loadDayBaselines(
    entries.map((e) => e.symbol),
    date
  );

  for (const { symbol, side } of entries) {
    const empty: TfSymbolContext = {
      supertrendAligned: null,
      breakout: null,
      breakout15: null,
      tfBeacon: beacons.get(symbol)?.dir ?? null,
      premValueCr: premBySymbol.get(symbol) ?? null,
      sinceEntryPct: null,
    };
    let bars: StoredFyersBar[] = [];
    try {
      bars = await getFyersCandles(symbol, date, 'EQ');
    } catch {
      out.set(symbol, empty);
      continue;
    }
    const usable = bars.filter((b) => b.high > 0).sort((a, b) => a.bucketTs - b.bucketTs);
    // The bar the decision would have been taken on, and everything before it.
    const atBar = usable.find((b) => bucketMinuteIST(b.bucketTs) >= asOfMinuteIST) ?? usable[usable.length - 1];
    if (atBar == null) {
      out.set(symbol, empty);
      continue;
    }
    const prior = usable.filter((b) => b.bucketTs < atBar.bucketTs);
    const price = atBar.open > 0 ? atBar.open : atBar.close;
    if (!(price > 0)) {
      out.set(symbol, empty);
      continue;
    }

    const sc = deriveSessionContext(prior);
    const st = prior.length >= MIN_BARS_FOR_TREND ? supertrend(prior) : null;

    out.set(symbol, {
      supertrendAligned: st == null ? null : side === 'CE' ? st.direction === 'up' : st.direction === 'down',
      // The GATE is the 30-min range (operator, 2026-10-09); 15-min is a recorded shadow.
      breakout: orbBreak(side, price, sc.openRangeComplete, sc.openRangeHigh, sc.openRangeLow),
      breakout15: orbBreak(side, price, sc.openRange15Complete, sc.openRange15High, sc.openRange15Low),
      tfBeacon: beacons.get(symbol)?.dir ?? null,
      premValueCr: premBySymbol.get(symbol) ?? null,
      // Direction-aware: positive means the move has gone OUR way since 09:45.
      sinceEntryPct: sinceEntryFromBars(usable, price, side),
      // Recorded evidence only — the selector never reads it (lib/tf-live/stretch.ts).
      stretch: measureStretch(prior, price, side, baselines.get(symbol) ?? null),
    });
  }

  return out;
}

/**
 * Stretch at an auto-trade ENTRY, stored on the trade so option P&L can later be
 * read by how stretched the entry was (scripts/measure-stretch.ts). Bars are
 * today's candles that STARTED before the current 5-min bucket — the forming bar
 * is excluded, the price taken is the decision price. Never throws and never
 * blocks: a measurement failure stores nulls, the entry is unaffected.
 */
export async function measureEntryStretch(
  symbol: string,
  date: string,
  price: number | null,
  side: 'CE' | 'PE',
  nowMs: number = Date.now()
): Promise<Stretch | null> {
  try {
    const [baselines, bars] = await Promise.all([
      loadDayBaselines([symbol], date),
      getFyersCandles(symbol, date, 'EQ'),
    ]);
    const currentBucket = Math.floor(nowMs / 1000 / 300) * 300;
    return measureStretch(
      bars.filter((b) => b.bucketTs < currentBucket),
      price,
      side,
      baselines.get(symbol) ?? null
    );
  } catch (error) {
    console.warn(`[TfContext] entry stretch unavailable for ${symbol}: ${(error as Error).message}`);
    return null;
  }
}
