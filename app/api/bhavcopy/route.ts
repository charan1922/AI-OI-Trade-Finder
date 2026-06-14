import { NextResponse } from 'next/server';
import { getBhavcopyStatus, syncBhavcopy } from '@/lib/historify/bhavcopy-service';

export const dynamic = 'force-dynamic';

const DEFAULT_DAYS = 25;

const MAX_DAYS = 300; // safety cap (~14 months) so a stray old row can't trigger a runaway sync

/**
 * Weekdays from the earliest *trade-scoped* downloaded date through today — so a
 * sync covers every loaded trade's window, not just the last 25 days.
 *
 * Anchored on backtest_futures/options ONLY, never backtest_equity: equity is
 * pre-downloaded over a wide range (back to 2024) for backtesting, whereas
 * futures/options are fetched per-trade (~45 days before each trade). Using the
 * equity min would overshoot by a year+ and sync irrelevant history. syncBhavcopy
 * only fetches dates it doesn't already have, so a correct wide window is cheap.
 */
async function autoDaysToCoverBacktest(): Promise<number> {
  const { queryRows } = await import('@/lib/backtest/backtest-store');
  const rows = (await queryRows(`
    SELECT MIN(d) AS earliest FROM (
      SELECT MIN(date) AS d FROM backtest_futures
      UNION ALL SELECT MIN(date) AS d FROM backtest_options
    ) WHERE d IS NOT NULL
  `)) as { earliest: string | null }[];
  const earliest = rows[0]?.earliest;
  if (!earliest) return DEFAULT_DAYS;
  let weekdays = 0;
  const cur = new Date(`${earliest}T00:00:00Z`);
  const today = new Date();
  while (cur <= today) {
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) weekdays++;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return Math.min(MAX_DAYS, Math.max(DEFAULT_DAYS, weekdays + 5)); // buffer + hard cap
}

/** GET /api/bhavcopy — coverage status of the bhavcopy_days table. */
export async function GET() {
  try {
    const status = await getBhavcopyStatus();
    return NextResponse.json({ success: true, data: status });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}

/**
 * POST /api/bhavcopy — sync missing trading days from NSE (user-triggered).
 * Body: { days?: number } — explicit lookback window of weekdays. When omitted,
 * the window auto-covers every downloaded trade (earliest backtest date → today).
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const days = typeof body.days === 'number' ? body.days : await autoDaysToCoverBacktest();
    const result = await syncBhavcopy(days);
    const status = await getBhavcopyStatus();
    return NextResponse.json({ success: true, days, ...result, status });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
