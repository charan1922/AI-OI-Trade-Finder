import { NextResponse } from 'next/server';

import { adminOnly } from '@/lib/auth/server';
import { getTfLiveCaptureDates, getTfLiveCaptureForDate } from '@/lib/tf-live/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** TradeFinder's `all_sector` payload is an OBJECT keyed by symbol; `daily-index`'s
 *  is already an array. Normalize both to a flat row list so the page renders
 *  either the same way, showing whatever fields the raw payload actually has
 *  (never a guessed English label standing in for a value that isn't there). */
function toRows(payload: unknown): Record<string, unknown>[] {
  const data = (payload as { payload?: { data?: unknown } } | null)?.payload?.data;
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === 'object') {
    return Object.entries(data as Record<string, unknown>).map(([symbol, value]) => ({
      symbol,
      ...(value && typeof value === 'object' ? (value as Record<string, unknown>) : { value }),
    }));
  }
  return [];
}

/**
 * GET ?dates=true              -> { dates: string[] } (union across both endpoints)
 * GET ?date=YYYY-MM-DD          -> { date, allSector: {capturedAt, rows}, dailyIndex: {capturedAt, rows} }
 */
export async function GET(req: Request) {
  const denied = adminOnly(req);
  if (denied) return denied;
  try {
    const url = new URL(req.url);
    if (url.searchParams.get('dates') === 'true') {
      const [allSectorDates, dailyIndexDates] = await Promise.all([
        getTfLiveCaptureDates('all_sector'),
        getTfLiveCaptureDates('daily-index'),
      ]);
      const dates = [...new Set([...allSectorDates, ...dailyIndexDates])].sort((a, b) => (a < b ? 1 : -1));
      return NextResponse.json({ success: true, dates });
    }

    const date = url.searchParams.get('date');
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ success: false, error: 'pass ?date=YYYY-MM-DD or ?dates=true' }, { status: 400 });
    }
    const [allSector, dailyIndex] = await Promise.all([
      getTfLiveCaptureForDate('all_sector', date),
      getTfLiveCaptureForDate('daily-index', date),
    ]);
    return NextResponse.json({
      success: true,
      date,
      allSector: allSector ? { capturedAt: allSector.capturedAt, rows: toRows(allSector.payload) } : null,
      dailyIndex: dailyIndex ? { capturedAt: dailyIndex.capturedAt, rows: toRows(dailyIndex.payload) } : null,
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
