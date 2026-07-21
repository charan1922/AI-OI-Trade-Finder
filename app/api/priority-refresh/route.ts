import { NextResponse } from 'next/server';
import { todayIST } from '@/lib/dhan/market-feed';
import { getPriorityCyclesForDate, type StoredPriorityCycle } from '@/lib/priority-refresh/telemetry-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/priority-refresh — today's priority-refresh SHADOW summary for the
 * operator display on /trade-commentary. Read-only measurement: the latest
 * cycle's membership + the distribution of "how much sooner could we have
 * fired" + how often a suggestion fell outside the proposed cap.
 */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export async function GET() {
  try {
    const date = todayIST();
    const cycles = await getPriorityCyclesForDate(date);
    const latest: StoredPriorityCycle | null = cycles.length > 0 ? cycles[cycles.length - 1] : null;

    const savings = cycles
      .map((c) => c.estimatedSavedMs)
      .filter((v): v is number => v != null)
      .sort((a, b) => a - b);
    const totalSuggestions = cycles.reduce((a, c) => a + c.suggestionCount, 0);
    const totalOutsideCap = cycles.reduce((a, c) => a + c.suggestionsOutsideCap, 0);
    const outsideCapSymbols = [...new Set(cycles.flatMap((c) => c.outsideCapSymbols))];

    return NextResponse.json({
      success: true,
      date,
      cycles: cycles.length,
      latest,
      p50SavedMs: percentile(savings, 50),
      p95SavedMs: percentile(savings, 95),
      measuredCycles: savings.length,
      totalSuggestions,
      totalOutsideCap,
      outsideCapPct: totalSuggestions > 0 ? Math.round((totalOutsideCap / totalSuggestions) * 100) : 0,
      outsideCapSymbols,
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
