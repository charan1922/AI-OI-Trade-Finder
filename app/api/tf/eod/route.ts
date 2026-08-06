import { NextResponse } from 'next/server';

import { adminOnly } from '@/lib/auth/server';
import { parseAllSector, parseDailyIndex } from '@/lib/tf-live/parse';
import { getTfLiveCaptureDates, getTfLiveCaptureForDate } from '@/lib/tf-live/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET ?dates=true      -> { dates: string[] } (union across both endpoints)
 * GET ?date=YYYY-MM-DD -> the LAST successful capture that IST day, parsed.
 *
 * Shapes come from lib/tf-live/parse.ts, which is confirmed against a real
 * payload (param_0=ltp, param_1=prevClose, param_2=%, param_3=R-Factor; and
 * all_sector is basket-keyed, not symbol-keyed).
 */
export async function GET(req: Request) {
  const denied = adminOnly(req);
  if (denied) return denied;
  try {
    const url = new URL(req.url);
    if (url.searchParams.get('dates') === 'true') {
      const [a, d] = await Promise.all([
        getTfLiveCaptureDates('all_sector'),
        getTfLiveCaptureDates('daily-index'),
      ]);
      const dates = [...new Set([...a, ...d])].sort((x, y) => (x < y ? 1 : -1));
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
      allSector: allSector ? { capturedAt: allSector.capturedAt, rows: parseAllSector(allSector.payload) } : null,
      dailyIndex: dailyIndex ? { capturedAt: dailyIndex.capturedAt, rows: parseDailyIndex(dailyIndex.payload) } : null,
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
