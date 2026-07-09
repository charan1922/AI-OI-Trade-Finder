import { NextResponse } from 'next/server';
import { getEodDates, getEodForDate } from '@/lib/signals/live-urgency-eod';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/live/urgency-history — permanent EOD copies of the /live board.
 *
 *   ?dates=true        → { dates: [...] } session dates with a captured board (desc)
 *   ?date=YYYY-MM-DD   → { date, rows } that session's frozen LiveUrgencyRow[]
 *
 * Pure DB read of `live_urgency_eod` — rows were captured once, automatically,
 * the first time a post-market /live poll ran for that session (see
 * app/api/live/_lib/closing-snapshot.ts). Nothing here triggers a new capture.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);

    if (url.searchParams.get('dates') === 'true') {
      const dates = await getEodDates();
      return NextResponse.json({ success: true, dates });
    }

    const dates = await getEodDates();
    if (dates.length === 0) {
      return NextResponse.json(
        { success: false, error: 'No EOD board captured yet — open /live during or right after a session.' },
        { status: 400 },
      );
    }

    const requested = url.searchParams.get('date');
    const date = requested && dates.includes(requested) ? requested : dates[0];
    const rows = await getEodForDate(date);

    return NextResponse.json({ success: true, date, count: rows.length, rows });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
