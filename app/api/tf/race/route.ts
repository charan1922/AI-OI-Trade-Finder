import { NextResponse } from 'next/server';

import { prisma } from '@/lib/db';
import { adminOnly } from '@/lib/auth/server';
import { todayIST } from '@/lib/dhan/market-feed';
import { screenDaily, type ScreenResult } from '@/lib/signals/daily-screen';
import { boardAtMinute, getTfBoardsForDate, getTfRaceForWindow } from '@/lib/tf-live/race';
import { buildRecordedTfContext } from '@/lib/tf-live/context';
import { DEFAULT_TF_SELECTOR_CONFIG, selectTfCandidates } from '@/lib/tf-live/selector';
import { TF_RACE_MAX_RANK } from '@/lib/trade-suggest/config';

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

    // ── The FULL board, not just names that climbed ────────────────────────
    //
    // Rank-climb is a poor proxy for "accumulating": rank is relative and
    // capped, so a name already strong at the 09:35 baseline cannot climb and
    // vanished from the card entirely. Measured against the real boards, the
    // climb filter hid 6 of TF's top 20 on 2026-08-11 and 8 on 2026-08-12 —
    // including PNB at TF R 4.33, the SECOND-strongest name on the whole board.
    // It also kept showing names that climbed early then froze, which is the
    // profile that measured -0.286R (n=1160) against +0.474R for surging ones.
    //
    // So the card now shows TF's top N ranked by R-Factor, with the accumulation
    // RATE as the signal and the climb demoted to context. `runners` /
    // `newEntrants` above are left untouched for any existing consumer.
    let board: TfBoardRow[] = [];
    // The clock time the board was captured at. Surfaced because the card's
    // "09:35-11:00 IST" badge is the ENTRY WINDOW, not the age of the data:
    // post-market this serves the day's LAST board (14:56 on 2026-08-12), and
    // showing it under a 09:35-11:00 heading reads as though it were the
    // 11:00 board (operator, 2026-08-13). State the real time instead.
    let boardMinuteIST: number | null = null;
    try {
      const boards = await getTfBoardsForDate(date);
      const asOfMinute = boards.length > 0 ? boards[boards.length - 1].minuteIST : 0;
      const full = boardAtMinute(boards, asOfMinute, TF_RACE_MAX_RANK);
      boardMinuteIST = asOfMinute;

      // Verdict from the SAME rule the auto-trader uses, on point-in-time
      // recorded evidence. Reusing selectTfCandidates is deliberate: a card that
      // re-implemented the gates would drift from the engine and quietly start
      // disagreeing with the trades actually being taken.
      const entries = full.runners.map((r) => ({
        symbol: r.symbol,
        side: (r.pctChange ?? 0) > 0 ? ('CE' as const) : ('PE' as const),
      }));
      const context = await buildRecordedTfContext(date, entries, asOfMinute);
      const picked = new Set(selectTfCandidates(full.runners, context).candidates.map((c) => c.symbol));

      board = full.runners.map((r) => {
        const side: 'CE' | 'PE' = (r.pctChange ?? 0) > 0 ? 'CE' : 'PE';
        const ctx = context.get(r.symbol);
        return {
          symbol: r.symbol,
          rankNow: r.rankNow,
          rankAtBaseline: r.rankAtBaseline,
          climb: r.climb,
          rFactor: r.rFactorNow,
          deltaR: r.deltaR,
          pctChange: r.pctChange,
          side,
          tradeable: picked.has(r.symbol),
          // First failing gate, in the order selectTfCandidates checks them, so
          // the card explains the engine instead of guessing alongside it.
          blockedBy: picked.has(r.symbol) ? null : firstBlock(r.deltaR, r.pctChange, ctx),
          premValueCr: ctx?.premValueCr ?? null,
          sinceEntryPct: ctx?.sinceEntryPct ?? null,
          supertrendAligned: ctx?.supertrendAligned ?? null,
          breakout: ctx?.breakout ?? null,
        };
      });
    } catch (error) {
      // The board is an enhancement; its failure must not blank the card.
      console.warn(`[TfRace] full board unavailable: ${(error as Error).message}`);
    }

    return NextResponse.json({ success: true, ...result, screen, stale, date, board, boardMinuteIST });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}


/** One row of the full TF board, as the /live card renders it. */
interface TfBoardRow {
  symbol: string;
  rankNow: number;
  rankAtBaseline: number;
  climb: number;
  rFactor: number;
  /** TF R-Factor gained over the trailing 30 min. Null = no earlier board. */
  deltaR: number | null;
  pctChange: number | null;
  side: 'CE' | 'PE';
  tradeable: boolean;
  blockedBy: string | null;
  premValueCr: number | null;
  sinceEntryPct: number | null;
  supertrendAligned: boolean | null;
  breakout: boolean | null;
}

/**
 * The FIRST gate a name fails, checked in `selectTfCandidates`'s own order so
 * the reason shown is the reason it was actually dropped — not whichever
 * condition happens to read worst.
 */
function firstBlock(
  deltaR: number | null,
  pctChange: number | null,
  ctx: { supertrendAligned: boolean | null; breakout: boolean | null; premValueCr: number | null; sinceEntryPct: number | null } | undefined
): string {
  const cfg = DEFAULT_TF_SELECTOR_CONFIG;
  if (deltaR == null) return 'no earlier board to measure the rate';
  if (deltaR <= cfg.minDeltaR) return 'R-Factor stopped climbing';
  if (pctChange == null || Math.abs(pctChange) < cfg.minAbsPctChange) return 'not moving enough to call a direction';
  if (ctx == null) return 'no recorded evidence';
  if (ctx.supertrendAligned == null) return 'too few candles for Supertrend';
  if (!ctx.supertrendAligned) return 'Supertrend disagrees';
  if (cfg.requireBreakout && ctx.breakout !== true) return 'no opening-range breakout';
  if (ctx.premValueCr == null) return 'no options premium reading';
  if (ctx.premValueCr < cfg.minPremValueCr) return `options pool only Rs ${Math.round(ctx.premValueCr)} Cr`;
  if (ctx.sinceEntryPct != null && ctx.sinceEntryPct >= cfg.maxSinceEntryPct) return 'move already extended';
  return 'below the pick limit';
}
