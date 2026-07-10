import { NextResponse } from 'next/server';
import { tradedStrikeKeys } from '@/lib/backtest/data-downloader';
import { EOD_PUBLISH_HOUR_IST } from '@/lib/dhan/market-feed';
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

/**
 * The most recent trading session whose bhavcopy should exist by now.
 * NSE finalises EOD files OVERNIGHT (post-midnight), not the same evening — so a
 * session's file is only "expected" from EOD_PUBLISH_HOUR_IST on the FOLLOWING
 * day. today's file is never expected same-day; yesterday's becomes expected
 * once we're past that hour. Weekends and rows in market_holidays are skipped.
 * Holiday lookup soft-fails open (treats days as trading days).
 */
async function expectedLatestSession(): Promise<string> {
  const { prisma } = await import('@/lib/db');
  let holidays = new Set<string>();
  try {
    const rows = await prisma.$queryRawUnsafe<{ date: string }[]>(`SELECT date FROM market_holidays`);
    holidays = new Set(rows.map((r) => r.date.slice(0, 10)));
  } catch {
    // table absent — weekday check only
  }
  const ist = new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60_000);
  // IST wall-clock date via LOCAL getters (same convention as todayIST() —
  // toISOString() would read the UTC date, one day behind before 05:30 IST).
  const dateKey = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  // A session publishes overnight, never same-day — step back one day; and before
  // the publish hour, that day's file is still pending too, so step back one more.
  ist.setDate(ist.getDate() - 1);
  if (ist.getHours() < EOD_PUBLISH_HOUR_IST) ist.setDate(ist.getDate() - 1);
  for (let i = 0; i < 10; i++) {
    const dow = ist.getDay();
    const key = dateKey(ist);
    if (dow !== 0 && dow !== 6 && !holidays.has(key)) return key;
    ist.setDate(ist.getDate() - 1);
  }
  return dateKey(ist);
}

/**
 * GET /api/bhavcopy — coverage status of the bhavcopy_days table, plus a
 * staleness verdict (drives the daily sync-reminder banner).
 */
export async function GET() {
  try {
    const status = await getBhavcopyStatus();
    const expectedDate = await expectedLatestSession();
    const stale = (status.latestDate ?? '') < expectedDate;
    return NextResponse.json({ success: true, data: { ...status, expectedDate, stale } });
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
    // Also capture each TF-traded strike's daily close/OI from the same bhavcopy
    // files — this is what powers the data-downloader's option-flow read without a
    // per-trade Dhan download. Cheap (only the ~hundreds of traded strikes).
    const wantedStrikes = await tradedStrikeKeys();
    const result = await syncBhavcopy(days, { wantedStrikes });
    const status = await getBhavcopyStatus();
    return NextResponse.json({ success: true, days, ...result, status });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
