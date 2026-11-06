import { NextResponse } from 'next/server';
import { getCommentary } from '@/lib/ai-commentary/store';
import { todayIST } from '@/lib/ist';
import { getCycleTimelines } from '@/lib/ops/cycle-timeline';

/**
 * GET /api/ai-analysis-v2/feed?date= — the auto-trader's reads and per-cycle timings for the v2 page, read straight
 * from their stores (v2 never calls v1's /api/trade-commentary). Admin-only (rbac prefix), so no redaction needed.
 */
export async function GET(req: Request) {
  try {
    const date = new URL(req.url).searchParams.get('date') || todayIST();
    const [rows, timelines] = await Promise.all([getCommentary({ date, limit: 40 }), getCycleTimelines(date).catch(() => [])]);
    return NextResponse.json({ success: true, date, rows, timelines });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
