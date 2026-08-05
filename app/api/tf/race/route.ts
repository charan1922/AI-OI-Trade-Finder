import { NextResponse } from 'next/server';

import { adminOnly } from '@/lib/auth/server';
import { todayIST } from '@/lib/dhan/market-feed';
import { getTfRaceForWindow } from '@/lib/tf-live/race';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Today's TF Running Race (09:45-11:00 IST window). Participation evidence
 *  only — see lib/tf-live/race.ts for why this never drives a trade alone. */
export async function GET(req: Request) {
  const denied = adminOnly(req);
  if (denied) return denied;
  try {
    const result = await getTfRaceForWindow(todayIST());
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
