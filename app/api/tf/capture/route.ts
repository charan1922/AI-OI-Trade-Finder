import { NextResponse } from 'next/server';

import { adminOnly } from '@/lib/auth/server';
import { captureTfLive } from '@/lib/tf-live/collector';
import { getLatestTfLiveCaptures, getTfLiveSessionStatus } from '@/lib/tf-live/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Manual "Capture now" — bypasses the autonomous/market-hours gates (like the
 *  /dhan test-call) so an operator can prove the stored lt/at still work,
 *  any time. Real Trade-Suggest/auto-trade paths never call this directly;
 *  only the scheduled collector and this button ever hit TradeFinder. */
export async function POST(req: Request) {
  const denied = adminOnly(req);
  if (denied) return denied;
  try {
    await captureTfLive({ force: true });
    const [session, captures] = await Promise.all([getTfLiveSessionStatus(), getLatestTfLiveCaptures()]);
    return NextResponse.json({ success: true, session, captures });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
