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
import type { TfSymbolContext } from '@/lib/tf-live/selector';

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
  asOfMinuteIST: number
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

  for (const { symbol, side } of entries) {
    const empty: TfSymbolContext = {
      supertrendAligned: null,
      breakout: null,
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
    const at945 = usable.find((b) => bucketMinuteIST(b.bucketTs) >= 9 * 60 + 45);
    const rawSince = at945 != null && at945.open > 0 ? ((price - at945.open) / at945.open) * 100 : null;

    out.set(symbol, {
      supertrendAligned: st == null ? null : side === 'CE' ? st.direction === 'up' : st.direction === 'down',
      breakout: !sc.openRangeComplete
        ? null
        : side === 'CE'
          ? sc.openRangeHigh != null && price > sc.openRangeHigh
          : sc.openRangeLow != null && price < sc.openRangeLow,
      premValueCr: premBySymbol.get(symbol) ?? null,
      // Direction-aware: positive means the move has gone OUR way since 09:45.
      sinceEntryPct: rawSince == null ? null : side === 'CE' ? rawSince : -rawSince,
    });
  }

  return out;
}
