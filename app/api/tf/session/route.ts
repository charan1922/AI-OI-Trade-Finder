import { NextResponse } from 'next/server';

import { adminOnly } from '@/lib/auth/server';
import {
  assertTfLiveSessionKeyConfigured,
  getLatestTfLiveCaptures,
  getTfLiveCaptureHistory,
  getTfLiveSessionStatus,
  saveTfLiveTokens,
  validateTfLiveTokens,
} from '@/lib/tf-live/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Safe operational status. Never returns the stored lt/at values. */
export async function GET(req: Request) {
  const denied = adminOnly(req);
  if (denied) return denied;
  try {
    const [session, captures, history] = await Promise.all([
      getTfLiveSessionStatus(),
      getLatestTfLiveCaptures(),
      getTfLiveCaptureHistory(),
    ]);
    return NextResponse.json({ success: true, session, captures, history });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}

/**
 * Accept freshly copied `lt` (localStorage) and `at` (sessionStorage) values
 * from a signed-in tradefinder.in tab. Validated with one real data call
 * before storage; encrypted at rest; never logged or returned.
 */
export async function POST(req: Request) {
  const denied = adminOnly(req);
  if (denied) return denied;
  try {
    const body = (await req.json()) as { lt?: unknown; at?: unknown };
    if (typeof body.lt !== 'string' || typeof body.at !== 'string') {
      return NextResponse.json({ success: false, error: 'body must be { lt: string, at: string }' }, { status: 400 });
    }
    const lt = body.lt.trim();
    const at = body.at.trim();
    // Do this before sending either value anywhere, including the validation
    // request, so a misconfigured deployment never accepts them.
    assertTfLiveSessionKeyConfigured();
    const check = await validateTfLiveTokens(lt, at);
    if (!check.valid) {
      return NextResponse.json({ success: false, error: check.error ?? 'TradeFinder rejected lt/at' }, { status: 401 });
    }
    await saveTfLiveTokens(lt, at);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 400 });
  }
}
