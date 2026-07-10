import { NextResponse } from 'next/server';
import { hasMimo } from '@/lib/env';
import { getMimoModel } from '@/lib/ai-commentary/client';
import { runAndStoreCommentary } from '@/lib/ai-commentary/run';
import { getCommentary } from '@/lib/ai-commentary/store';
import { runTradeSuggest } from '@/lib/trade-suggest/engine';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/trade-commentary[?date=YYYY-MM-DD&limit=N] — stored AI narrations of
 * the scan (newest first). These are generated in-process by the poller during
 * market hours, so the page has data even when nobody had the app open.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const date = url.searchParams.get('date') ?? undefined;
    const limitParam = Number(url.searchParams.get('limit'));
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 30;
    const rows = await getCommentary({ date, limit });
    return NextResponse.json({ success: true, configured: hasMimo(), model: getMimoModel(), rows });
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
