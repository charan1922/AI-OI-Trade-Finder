import { NextResponse } from 'next/server';
import { todayIST } from '@/lib/dhan/market-feed';
import { getFyersCoverage } from '@/lib/fyers/candle-store';
import {
  getFyersPollerStatus,
  runFyersCycle,
  runTokenWarmup,
  setFyersPollerPaused,
  startFyersPoller,
} from '@/lib/fyers/poller';
import { adminOnly } from '@/lib/auth/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/fyers/poller — downloader status (poller state, last cycle summary,
 * accumulated universe, masked token expiry). `?coverage=1` adds per-symbol
 * bar counts for today. Also (re)starts the loop defensively — instrumentation
 * normally already has.
 */
export async function GET(req: Request) {
  const denied = adminOnly(req);
  if (denied) return denied;
  startFyersPoller();
  const status = getFyersPollerStatus();
  const withCoverage = new URL(req.url).searchParams.get('coverage') === '1';
  const coverage = withCoverage ? await getFyersCoverage(todayIST()) : undefined;
  return NextResponse.json({ success: true, ...status, coverage });
}

/**
 * POST /api/fyers/poller — control the loop.
 * Body: { action: 'pause' | 'resume' | 'run-once' | 'warm-tokens', date?: 'YYYY-MM-DD' }
 * `run-once` runs a full cycle immediately, bypassing the market-hours guard —
 * with `date` it backfills that day's candles (market-closed testing; those
 * rows are pruned by the next regular cycle). `warm-tokens` runs the pre-open
 * token warm-up immediately (window/day checks bypassed) — the ops/test hook
 * for the 08:40–09:15 IST automatic warm-up.
 */
export async function POST(req: Request) {
  const denied = adminOnly(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    date?: string;
  };

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
      const summary = await runFyersCycle({
        force: true,
        dateOverride: body.date,
        trigger: 'manual',
      });
      return NextResponse.json({ success: true, summary });
    }
    case 'warm-tokens': {
      await runTokenWarmup();
      return NextResponse.json({ success: true, ...getFyersPollerStatus() });
    }
    default:
      return NextResponse.json(
        {
          success: false,
          error: "action must be 'pause' | 'resume' | 'run-once' | 'warm-tokens'",
        },
        { status: 400 }
      );
  }
}
