import { NextResponse } from 'next/server';

import { adminOnly } from '@/lib/auth/server';
import { todayIST } from '@/lib/dhan/market-feed';
import { screenDaily, type ScreenResult } from '@/lib/signals/daily-screen';
import { getTfRaceForWindow } from '@/lib/tf-live/race';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Today's TF Running Race (09:35-11:00 IST window). Participation evidence
 *  only — see lib/tf-live/race.ts for why this never drives a trade alone. */
export async function GET(req: Request) {
  const denied = adminOnly(req);
  if (denied) return denied;
  try {
    const date = todayIST();
    const result = await getTfRaceForWindow(date);

    // The operator's daily screen, applied ON TOP of the race so a climbing name
    // can also be checked for momentum and liquidity (lib/signals/daily-screen.ts).
    // Two batched SQLite reads, no broker call — the race card must stay cheap.
    // Runners are NOT filtered out: the race is participation evidence and stays
    // complete; the screen only marks which names also clear it.
    const symbols = [...new Set([...result.runners, ...result.newEntrants].map((r) => r.symbol))];
    let screen: Record<string, ScreenResult> = {};
    try {
      const map = await screenDaily(symbols, date);
      screen = Object.fromEntries(map);
    } catch (error) {
      // A screen failure must never blank the race itself.
      console.warn(`[TfRace] daily screen failed: ${(error as Error).message}`);
    }

    return NextResponse.json({ success: true, ...result, screen });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
