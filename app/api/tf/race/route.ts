import { NextResponse } from 'next/server';

import { prisma } from '@/lib/db';
import { adminOnly } from '@/lib/auth/server';
import { todayIST } from '@/lib/dhan/market-feed';
import { screenDaily, type ScreenResult } from '@/lib/signals/daily-screen';
import { getTfRaceForWindow } from '@/lib/tf-live/race';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The TF climbers board (09:35-11:00 IST window). Participation evidence only —
 * see lib/tf-live/race.ts for why this never drives a trade alone.
 *
 * DISPLAY ROUTE ONLY. The scanner and the auto-trader call `raceAtMinute` /
 * `getTfRaceForWindow` directly and are unaffected by anything here — in
 * particular the fallback below must never reach the trade path, where a board
 * from a previous session would be exactly the wrong input.
 *
 * Retention: off-hours (and before the first capture of a new day) today's
 * window is empty, which used to render as "needs at least 2 captures" while
 * every other card on /live still showed the last session's closing snapshot.
 * Same page, two different days — so this falls back to the most recent session
 * that HAS a usable race and reports `date` + `stale` so the card can say which
 * day it is showing. A frozen board must never pass for a live one.
 */
export async function GET(req: Request) {
  const denied = adminOnly(req);
  if (denied) return denied;
  try {
    const today = todayIST();
    let date = today;
    let result = await getTfRaceForWindow(date);

    if (!result.hasRace) {
      // Most recent session with successful captures, today excluded (already tried).
      const rows = (await prisma.$queryRawUnsafe(
        `SELECT DISTINCT date(datetime(capturedAt,'+5 hours','+30 minutes')) d
         FROM tf_live_captures
         WHERE endpoint = 'all_sector' AND status = 'success'
           AND date(datetime(capturedAt,'+5 hours','+30 minutes')) < ?
         ORDER BY d DESC LIMIT 5`,
        today
      )) as { d: string }[];
      for (const row of rows) {
        const prior = await getTfRaceForWindow(row.d);
        if (prior.hasRace) {
          date = row.d;
          result = prior;
          break;
        }
      }
    }
    const stale = date !== today;

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

    return NextResponse.json({ success: true, ...result, screen, stale });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
