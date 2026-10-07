import { NextResponse } from 'next/server';

import { adminOnly } from '@/lib/auth/server';
import { TF_BOARD_ENDPOINTS, TF_INDEX_ENDPOINTS } from '@/lib/tf-live/endpoints';
import { parseTfBoard, parseTfIndices } from '@/lib/tf-live/parse';
import { getTfLiveCaptureDates, getTfLiveCaptureForDate } from '@/lib/tf-live/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET ?dates=true      -> { dates: string[] } (union across every board/index feed)
 * GET ?date=YYYY-MM-DD -> the LAST successful capture that IST day, parsed.
 *
 * Shapes come from lib/tf-live/parse.ts, which is confirmed against real
 * payloads (param_0=ltp, param_1=prevClose, param_2=%, param_3=R-Factor; the
 * board is basket-keyed, not symbol-keyed). Since 2026-10-08 both the stock
 * board and the sector values come from `sector_scope`; older days from the
 * retired `all_sector` / `rfactor_data` / `daily-index` captures.
 */
export async function GET(req: Request) {
  const denied = adminOnly(req);
  if (denied) return denied;
  try {
    const url = new URL(req.url);
    if (url.searchParams.get('dates') === 'true') {
      const feeds = [...new Set([...TF_BOARD_ENDPOINTS, ...TF_INDEX_ENDPOINTS])];
      const lists = await Promise.all(feeds.map((e) => getTfLiveCaptureDates(e)));
      const dates = [...new Set(lists.flat())].sort((x, y) => (x < y ? 1 : -1));
      return NextResponse.json({ success: true, dates });
    }

    const date = url.searchParams.get('date');
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ success: false, error: 'pass ?date=YYYY-MM-DD or ?dates=true' }, { status: 400 });
    }
    const [board, indices] = await Promise.all([
      latestOf(TF_BOARD_ENDPOINTS, date),
      latestOf(TF_INDEX_ENDPOINTS, date),
    ]);
    return NextResponse.json({
      success: true,
      date,
      allSector: board ? { capturedAt: board.capturedAt, rows: parseTfBoard(board.endpoint, board.payload) } : null,
      dailyIndex: indices
        ? { capturedAt: indices.capturedAt, rows: parseTfIndices(indices.endpoint, indices.payload) }
        : null,
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}

/** The latest successful capture that day across `feeds` — the closing board. */
async function latestOf(feeds: readonly (typeof TF_BOARD_ENDPOINTS[number] | typeof TF_INDEX_ENDPOINTS[number])[], date: string) {
  const found = await Promise.all(
    feeds.map(async (endpoint) => {
      const capture = await getTfLiveCaptureForDate(endpoint, date);
      return capture ? { endpoint, ...capture } : null;
    })
  );
  return found
    .filter((c): c is NonNullable<typeof c> => c != null)
    .sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1))[0] ?? null;
}
