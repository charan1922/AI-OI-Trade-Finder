import { NextResponse } from 'next/server';
import { runTradeSuggest } from '@/lib/trade-suggest/engine';
import { computeEodLeaderboard } from '@/lib/trade-suggest/eod-leaderboard';
import { reviewToday } from '@/lib/trade-suggest/review';
import { getProtectionStats, getStats, getSuggestionHistory } from '@/lib/trade-suggest/store';
import { isReadOnlyRequest } from '@/lib/auth/server';
import { tradeSuggestForRole } from '@/lib/auth/trading-privacy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/trade-suggest[?force=1]
 *
 * The /trade-suggest skill's endpoint: scans the live NSE watchlist feeds,
 * gates + scores candidates (R-Factor, OI level/urgency, opening-range
 * breakout, sector breadth, liquidity), and returns up to 3 near-ATM option
 * suggestions (CE for bullish, PE for bearish) with a spot-level plan.
 * Active window 09:40–11:00 IST; `force=1` bypasses the window (testing)
 * but never the market-hours requirement.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    // ?view=leaderboard[&date=YYYY-MM-DD&limit=N] — the EOD TF-style
    // spread-linear leaderboard from bhavcopy (post-market comparator).
    if (url.searchParams.get('view') === 'leaderboard') {
      const limitParam = Number(url.searchParams.get('limit'));
      const board = await computeEodLeaderboard(
        url.searchParams.get('date') ?? undefined,
        Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 15,
      );
      if (!board) return NextResponse.json({ success: false, error: 'No bhavcopy sessions synced' }, { status: 400 });
      return NextResponse.json({ success: true, ...board });
    }
    // ?view=history[&days=N] — the daywise Trade Log: every persisted
    // suggestion grouped by trading day (newest first) with a hit tally.
    if (url.searchParams.get('view') === 'history') {
      const daysParam = Number(url.searchParams.get('days'));
      const days = Number.isFinite(daysParam) && daysParam > 0 ? Math.min(daysParam, 365) : 30;
      const board = await getSuggestionHistory(days);
      // Profit-protection SHADOW calibration over the SAME window (measurement
      // only — never changes a live exit). Surfaced read-only on the Trade Log.
      const protection = await getProtectionStats(days);
      return NextResponse.json({ success: true, days, days_returned: board.length, board, protection });
    }
    const force = url.searchParams.get('force') === '1';
    const result = await runTradeSuggest(url.origin, { force });
    return NextResponse.json(tradeSuggestForRole(result, isReadOnlyRequest(req)));
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}

/**
 * POST /api/trade-suggest
 *
 * body { action: 'review' } — scorecard: fills each of the day's suggestions
 * with the spot move that followed (max favorable/adverse excursion + close +
 * honest path-dependent grade), from fyers_candles. Run after 16:00. fyers_candles
 * retains the newest ~20 sessions (FYERS_CANDLE_RETENTION_SESSIONS), so a retained
 * past session can also be regraded (scripts/regrade-suggestions.ts).
 *
 * body { action: 'stats', days? } — cross-day calibration stats over all
 * reviewed suggestions (hit-rate, avg excursions, by rank / score bucket).
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { action?: string; days?: number };
    switch (body.action) {
      case 'review': {
        const result = await reviewToday();
        return NextResponse.json({ success: true, ...result });
      }
      case 'stats': {
        const stats = await getStats(typeof body.days === 'number' && body.days > 0 ? body.days : 30);
        return NextResponse.json({ success: true, stats });
      }
      default:
        return NextResponse.json({ success: false, error: "action must be 'review' or 'stats'" }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
