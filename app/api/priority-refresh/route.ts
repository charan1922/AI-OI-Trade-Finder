import { NextResponse } from 'next/server';
import { todayIST } from '@/lib/dhan/market-feed';
import { getPriorityCyclesForDate, type StoredPriorityCycle } from '@/lib/priority-refresh/telemetry-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/priority-refresh — today's priority-refresh SHADOW summary for the
 * operator display on /trade-commentary. Read-only, MEASUREMENT ONLY: the latest
 * cycle's proposed-plan membership + how often a suggestion fell OUTSIDE the
 * proposed cap (the coverage evidence). No timing figures — this PR does not
 * reorder the download, so it measures no time saving (see the capped-live PR).
 */
export async function GET() {
  try {
    const date = todayIST();
    const cycles = await getPriorityCyclesForDate(date);
    const latest: StoredPriorityCycle | null = cycles.length > 0 ? cycles[cycles.length - 1] : null;

    const totalSuggestions = cycles.reduce((a, c) => a + c.suggestionCount, 0);
    const totalOutsideCap = cycles.reduce((a, c) => a + c.suggestionsOutsideCap, 0);
    const outsideCapSymbols = [...new Set(cycles.flatMap((c) => c.outsideCapSymbols))];

    return NextResponse.json({
      success: true,
      date,
      cycles: cycles.length,
      latest,
      totalSuggestions,
      totalOutsideCap,
      outsideCapPct: totalSuggestions > 0 ? Math.round((totalOutsideCap / totalSuggestions) * 100) : 0,
      outsideCapSymbols,
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
