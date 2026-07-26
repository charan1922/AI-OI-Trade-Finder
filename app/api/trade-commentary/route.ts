import { NextResponse } from 'next/server';
import { hasMimo } from '@/lib/env';
import { isMarketHours, todayIST } from '@/lib/dhan/market-feed';
import { getMimoModel } from '@/lib/ai-commentary/client';
import { runAndStoreCommentary } from '@/lib/ai-commentary/run';
import { getCommentary, getLatestCommentaryDate } from '@/lib/ai-commentary/store';
import { getCycleTimelines } from '@/lib/ops/cycle-timeline';
import { runTradeSuggest } from '@/lib/trade-suggest/engine';
import { getAutoTradeSettings } from '@/lib/auto-trade/settings';
import { isReadOnlyRequest } from '@/lib/auth/server';
import { commentaryForRole, timelinesForRole } from '@/lib/auth/trading-privacy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/trade-commentary[?date=YYYY-MM-DD&limit=N] — stored AI narrations of
 * the scan (newest first). These are generated in-process by the poller during
 * market hours, so the page has data even when nobody had the app open.
 *
 * With no `date`, scopes to a SINGLE session (never a cross-day mix): today once
 * the market is open (the day's running thread, even before its first read),
 * else the latest session that has commentary. Mirrors how /live freezes to the
 * last session off-hours.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const explicit = url.searchParams.get('date') ?? undefined;
    const date = explicit ?? (isMarketHours() ? todayIST() : ((await getLatestCommentaryDate()) ?? todayIST()));
    const limitParam = Number(url.searchParams.get('limit'));
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 30;
    const [rows, settings] = await Promise.all([getCommentary({ date, limit }), getAutoTradeSettings()]);
    // Per-cycle step timings for the same session — the page pairs each read
    // with its cycle (timeline.commentaryId) and lists no-read cycles too.
    const timelines = await getCycleTimelines(date).catch(() => []);
    const readOnly = isReadOnlyRequest(req);
    return NextResponse.json({
      success: true,
      configured: hasMimo(),
      model: getMimoModel(settings.mimoModel),
      modelConfigurationError: settings.mimoModelConfigurationError,
      decisionProvider: settings.aiProvider,
      date,
      rows: commentaryForRole(rows, readOnly),
      // Guard/reconcile step details name the held contract and its premiums —
      // redact them for viewers or the commentary redaction above is pointless.
      timelines: timelinesForRole(timelines, readOnly),
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}

/**
 * POST /api/trade-commentary — run a scan now and narrate it (the page's
 * "Generate now" button). body { force?: boolean } bypasses the window like the
 * scan's force flag. Returns the fresh commentary (also persisted).
 */
export async function POST(req: Request) {
  try {
    if (!hasMimo()) {
      return NextResponse.json(
        { success: false, error: 'MiMo is not configured (set MIMO_API_KEY + MIMO_BASE_URL).' },
        { status: 400 },
      );
    }
    const body = (await req.json().catch(() => ({}))) as { force?: boolean };
    const url = new URL(req.url);
    const result = await runTradeSuggest(url.origin, { force: Boolean(body.force) });
    const outcome = await runAndStoreCommentary(result);
    return NextResponse.json({ success: true, ...outcome, scanned: result.scanned });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
