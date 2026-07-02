import { NextResponse } from 'next/server';
import { todayIST } from '@/lib/dhan/market-feed';
import { getFyersCoverage } from '@/lib/fyers/candle-store';
import { getFyersPollerStatus, runFyersCycle, setFyersPollerPaused, startFyersPoller } from '@/lib/fyers/poller';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/fyers/poller — downloader status (poller state, last cycle summary,
 * accumulated universe, masked token expiry). `?coverage=1` adds per-symbol
 * bar counts for today. Also (re)starts the loop defensively — instrumentation
 * normally already has.
 */
export async function GET(req: Request) {
  startFyersPoller();
  const status = getFyersPollerStatus();
  const withCoverage = new URL(req.url).searchParams.get('coverage') === '1';
  const coverage = withCoverage ? await getFyersCoverage(todayIST()) : undefined;
  return NextResponse.json({ success: true, ...status, coverage });
}

/**
 * POST /api/fyers/poller — control the loop.
 * Body: { action: 'pause' | 'resume' | 'run-once', date?: 'YYYY-MM-DD' }
 * `run-once` runs a full cycle immediately, bypassing the market-hours guard —
 * with `date` it backfills that day's candles (market-closed testing; those
 * rows are pruned by the next regular cycle).
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { action?: string; date?: string };

  switch (body.action) {
    case 'pause':
      setFyersPollerPaused(true);
      return NextResponse.json({ success: true, ...getFyersPollerStatus() });
    case 'resume':
      setFyersPollerPaused(false);
      return NextResponse.json({ success: true, ...getFyersPollerStatus() });
    case 'run-once': {
      if (body.date && !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
        return NextResponse.json({ success: false, error: 'date must be YYYY-MM-DD' }, { status: 400 });
      }
      const summary = await runFyersCycle({ force: true, dateOverride: body.date, trigger: 'manual' });
      return NextResponse.json({ success: true, summary });
    }
    default:
      return NextResponse.json(
        { success: false, error: "action must be 'pause' | 'resume' | 'run-once'" },
        { status: 400 },
      );
  }
}
