import { NextResponse } from 'next/server';

import { prisma } from '@/lib/db';
import { adminOnly } from '@/lib/auth/server';
import { isTradingDay, todayIST } from '@/lib/market-data';
import { ENTRY_END_MIN, ENTRY_START_MIN } from '@/lib/auto-trade/config';
import { getAutoTradeSettings } from '@/lib/auto-trade/settings';
import { getTfBeaconsAt } from '@/lib/tf-live/beacon';
import {
  climberIntervals,
  climbingSince,
  droppedClimbers,
  firstNeed,
  gateStrip,
  pickSector,
  rPath,
  rTrend,
  climbedStocks,
  type ClimbedStock,
  type DroppedClimber,
  type GateStrip,
} from '@/lib/tf-live/board-view';
import { TF_RACE_ENDPOINTS_SQL } from '@/lib/tf-live/endpoints';
import { parseSectorScope, parseTfIndices, type TfBeacon } from '@/lib/tf-live/parse';
import {
  boardAtMinute,
  getTfBoardsForDate,
  getTfRaceForWindow,
  istMinutesNow,
  RACE_WINDOW_START_MIN,
  tfCandidatesAtMinute,
} from '@/lib/tf-live/race';
import { getTfEligibleSectors } from '@/lib/trade-suggest/candidates';
import { buildRecordedTfContext } from '@/lib/tf-live/context';
import { getTfLiveCaptureForDate } from '@/lib/tf-live/store';
import { LIVE_TF_SELECTOR_CONFIG, selectTfCandidates } from '@/lib/tf-live/selector';
import type { Stretch } from '@/lib/tf-live/stretch';
import { TF_BOARD_MAX_AGE_MIN, TF_RACE_MAX_RANK } from '@/lib/trade-suggest/config';

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
 * Retention: OFF-HOURS ONLY (weekend/holiday, or before 09:15 IST) today's
 * window is empty, which used to render as "needs at least 2 captures" while
 * every other card on /live still showed the last session's closing snapshot.
 * Same page, two different days — so this falls back to the most recent session
 * that HAS a usable race and reports `date` + `stale` so the card can say which
 * day it is showing. A frozen board must never pass for a live one.
 *
 * ONCE TODAY'S SESSION HAS OPENED (weekday, ≥ 09:15 IST) THE FALLBACK IS OFF.
 * Operator, 2026-08-13: at 09:xx the card was serving 2026-08-12's 14:56 board
 * and rendering HAL/GODREJCP as green "the scanner would take this" — yesterday's
 * accumulation presented as today's answer. TF's R-Factor is a per-session
 * counter that resets each morning (lib/tf-live/race.ts), so a prior session's
 * board says nothing whatsoever about a stock today. During a live session the
 * honest answer to "no board yet" is "no board yet — go check /tf", not a
 * board from another day.
 */
/**
 * Per-minute response cache. The body re-parses every board capture of the day
 * (~11 MB of JSON by the close), and the cockpit card polls every 30 s. Every
 * time-dependent field (board age, verdict, countdown) has minute resolution, so
 * keying on (today, latest board capture, current IST minute) makes a 30-second
 * poll from any number of viewers cost at most one computation per minute.
 */
const cache = globalThis as unknown as {
  __tfRaceCache?: { key: string; body: unknown };
};

export async function GET(req: Request) {
  const denied = adminOnly(req);
  if (denied) return denied;
  try {
    const url = new URL(req.url);
    // Climbed Stocks day history: which dates have captures, and one day's climbers.
    if (url.searchParams.get('dates') === 'true') {
      const rows = (await prisma.$queryRawUnsafe(
        `SELECT DISTINCT date(datetime(capturedAt,'+5 hours','+30 minutes')) AS d FROM tf_live_captures
          WHERE endpoint IN (${TF_RACE_ENDPOINTS_SQL}) AND status = 'success'
          ORDER BY d DESC LIMIT 60`
      )) as { d: string }[];
      return NextResponse.json({ success: true, dates: rows.map((r) => r.d) });
    }
    const historyDate = url.searchParams.get('date');
    if (historyDate != null) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(historyDate)) {
        return NextResponse.json({ success: false, error: 'date must be YYYY-MM-DD' }, { status: 400 });
      }
      const boards = await getTfBoardsForDate(historyDate);
      // Today's eligibility list — the lot bands rarely change, and 'avoid' names
      // never appear on /live (operator rule).
      const eligible = new Set((await getTfEligibleSectors()).keys());
      const lastBoardMinute = boards.at(-1)?.minuteIST ?? null;
      return NextResponse.json({
        success: true,
        date: historyDate,
        lastBoardMinute,
        climbed: lastBoardMinute == null ? [] : dayClimbers(boards, lastBoardMinute, eligible),
      });
    }

    const today = todayIST();
    const nowMin = istMinutesNow();
    const latest = (await prisma.$queryRawUnsafe(
      `SELECT MAX(capturedAt) AS t FROM tf_live_captures
        WHERE endpoint IN (${TF_RACE_ENDPOINTS_SQL}) AND status = 'success'
          AND date(datetime(capturedAt,'+5 hours','+30 minutes')) = ?`,
      today
    )) as { t: string | null }[];
    const key = `${today}|${latest[0]?.t ?? ''}|${nowMin}`;
    if (cache.__tfRaceCache?.key === key) return NextResponse.json(cache.__tfRaceCache.body);
    const body = await buildBody(today, nowMin);
    cache.__tfRaceCache = { key, body };
    return NextResponse.json(body);
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}

/** Exit confirmed only after this long out; shorter dips merge into one run. */
const CLIMB_GRACE_MIN = 10;
/** A closed run shorter than this is a blip and is not shown. */
const CLIMB_MIN_STAY_MIN = 5;

/** Every stock that entered TF Climbers on a day, ONCE each, with its runs —
 *  the same "in" test as the cockpit's WATCH/TAKE tiers, steadied for display
 *  (climbedStocks). 2026-10-08: 61 raw entries → 24 stocks. */
function dayClimbers(
  boards: Awaited<ReturnType<typeof getTfBoardsForDate>>,
  asOfMin: number,
  eligible: ReadonlySet<string>
): ClimbedStock[] {
  const raw = climberIntervals(boards, {
    fromMin: RACE_WINDOW_START_MIN,
    asOfMin,
    topN: TF_RACE_MAX_RANK,
    minDeltaR: LIVE_TF_SELECTOR_CONFIG.minDeltaR,
  }).filter((c) => eligible.has(c.symbol));
  return climbedStocks(raw, { asOfMin, graceMin: CLIMB_GRACE_MIN, minStayMin: CLIMB_MIN_STAY_MIN });
}

/**
 * The EFFECTIVE entry window — the runtime settings the risk gates enforce, not
 * the code defaults. 2026-10-08: prod's settings allowed entries until 13:30
 * while the card counted down to the 11:00 default, so it said "closes in 10
 * min" at 10:50 and a paper entry then opened at 11:10.
 */
async function entryWindow(): Promise<{ windowStartMin: number; windowEndMin: number }> {
  try {
    const s = await getAutoTradeSettings();
    return { windowStartMin: s.entryStartMin ?? ENTRY_START_MIN, windowEndMin: s.entryEndMin ?? ENTRY_END_MIN };
  } catch {
    return { windowStartMin: ENTRY_START_MIN, windowEndMin: ENTRY_END_MIN };
  }
}

async function buildBody(today: string, nowMin: number) {
  // Weekday and past the open — today's session is (or should be) running.
  // Weekday NSE holidays are not excluded here on purpose: the alternative is
  // a holiday-table read that fails OPEN into "show yesterday", which is the
  // exact failure being fixed. A holiday simply shows "no board today", which
  // is true, and nobody trades that session anyway.
  const sessionOpenedToday = isTradingDay();
  let date = today;
  let result = await getTfRaceForWindow(date);
  if (!result.hasRace && !sessionOpenedToday) {
    // Most recent session with successful captures, today excluded (already tried).
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT DISTINCT date(datetime(capturedAt,'+5 hours','+30 minutes')) d
         FROM tf_live_captures
         WHERE endpoint IN (${TF_RACE_ENDPOINTS_SQL}) AND status = 'success'
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
  let dropped: DroppedClimber[] = [];
  let climbed: ClimbedStock[] = [];
  // The clock time the board was captured at. Surfaced because the card's
  // "09:35-11:00 IST" badge is the ENTRY WINDOW, not the age of the data:
  // post-market this serves the day's LAST board (14:56 on 2026-08-12), and
  // showing it under a 09:35-11:00 heading reads as though it were the
  // 11:00 board (operator, 2026-08-13). State the real time instead.
  let boardMinuteIST: number | null = null;
  // Age of the board in minutes, and whether the scanner would act on it at
  // all. `null` age = the board is from another session, i.e. infinitely old.
  let boardAgeMin: number | null = null;
  let verdictsLive = false;
  let verdictNote: string | null = null;
  try {
    const boards = await getTfBoardsForDate(date);
    const asOfMinute = boards.length > 0 ? boards[boards.length - 1].minuteIST : 0;
    // The SAME names the trade engine judges: TF's top 20 minus the 'avoid' lot
    // band (never shown on /live) and names without a live future. Before
    // 2026-10-08 the card judged all of the top 20 while the engine judged only
    // rank-climbers, so the card could say TAKE for a name the engine never saw.
    const eligible = new Set((await getTfEligibleSectors()).keys());
    const full = boardAtMinute(boards, asOfMinute, TF_RACE_MAX_RANK);
    const shown = full.runners.filter((r) => eligible.has(r.symbol));
    const candidates = tfCandidatesAtMinute(boards, asOfMinute, TF_RACE_MAX_RANK, eligible);
    // Only a board that exists has a capture time. Reporting 0 here rendered
    // as "board 00:00", which is a time, not an absence.
    boardMinuteIST = boards.length > 0 ? asOfMinute : null;

    // ── The verdict is only issued off a board the SCANNER would accept ──
    //
    // "Green = the scanner would take it" is a present-tense claim about what
    // the engine would do right now, so it may only be computed from evidence
    // the engine would actually accept: today's board, no older than
    // TF_BOARD_MAX_AGE_MIN. Past that, lib/trade-suggest/engine.ts returns
    // zero picks and says why — so a green row there is the card contradicting
    // the engine it claims to be reporting.
    //
    // This is not only about yesterday. TradeFinder signs this account out
    // roughly daily AND mid-session (263 consecutive failures over 3h20m on
    // 2026-08-10), so "today's board, three hours stale" is the normal case,
    // and it produced the same false green rows.
    boardAgeMin = stale || boardMinuteIST == null ? null : nowMin - boardMinuteIST;
    if (boardMinuteIST == null) {
      // NO BOARD AT ALL. Reached today when TradeFinder has captured nothing
      // (their session is signed out) — observed live at 10:00 IST on
      // 2026-08-13. The earlier cut fell through to `verdictsLive = true`
      // here, asserting the verdicts were current off zero evidence. The card
      // happened to be shielded (it renders the "no board" branch first), but
      // a fail-OPEN default has no business in the module whose entire purpose
      // is refusing to speak without evidence.
      verdictNote = 'No TradeFinder board captured today yet.';
    } else if (stale) {
      verdictNote = `This board is from ${date}, not today. TradeFinder's R-Factor is a per-session counter that restarts each morning, so nothing here is a call for today.`;
    } else if (boardAgeMin != null && boardAgeMin > TF_BOARD_MAX_AGE_MIN) {
      verdictNote = `Board is ${boardAgeMin} min old (the scanner refuses anything over ${TF_BOARD_MAX_AGE_MIN}) — showing the numbers, withholding the verdict. Check /tf is still capturing.`;
    } else {
      verdictsLive = true;
    }

    // Verdict from the SAME rule the auto-trader uses, on point-in-time
    // recorded evidence. Reusing selectTfCandidates is deliberate: a card that
    // re-implemented the gates would drift from the engine and quietly start
    // disagreeing with the trades actually being taken.
    const entries = shown.map((r) => ({
      symbol: r.symbol,
      side: (r.pctChange ?? 0) > 0 ? ('CE' as const) : ('PE' as const),
    }));
    // TF's beacon and sector values from the captures of the SAME moment as the board.
    const boardAt = boards.at(-1)?.capturedAt;
    const beacons = await getTfBeaconsAt(date, boardAt).catch(() => new Map<string, TfBeacon>());
    const context = await buildRecordedTfContext(date, entries, asOfMinute, beacons);
    const basketsBySymbol = new Map<string, string[]>();
    const sectorValues = new Map<string, number>();
    const sectorCapture = await getTfLiveCaptureForDate('sector_scope', date, boardAt).catch(() => null);
    if (sectorCapture) {
      for (const r of parseSectorScope(sectorCapture.payload)) basketsBySymbol.set(r.symbol.toUpperCase(), r.baskets);
      for (const r of parseTfIndices('sector_scope', sectorCapture.payload)) {
        if (r.value != null) sectorValues.set(r.name, r.value);
      }
    }
    const picked = new Set(
      selectTfCandidates(candidates.runners, context, LIVE_TF_SELECTOR_CONFIG).candidates.map((c) => c.symbol)
    );

    board = shown.map((r) => {
      const side: 'CE' | 'PE' = (r.pctChange ?? 0) > 0 ? 'CE' : 'PE';
      const ctx = context.get(r.symbol);
      // Forced false off a board the engine would refuse. Suppressing it HERE
      // rather than in the card means no consumer of this route can render a
      // stale board as actionable.
      const tradeable = verdictsLive && picked.has(r.symbol);
      const gates = gateStrip(r.deltaR, r.pctChange, ctx, LIVE_TF_SELECTOR_CONFIG);
      const needs = firstNeed(gates, ctx, LIVE_TF_SELECTOR_CONFIG);
      return {
        symbol: r.symbol,
        rankNow: r.rankNow,
        rankAtBaseline: r.rankAtBaseline,
        climb: r.climb,
        rFactor: r.rFactorNow,
        deltaR: r.deltaR,
        pctChange: r.pctChange,
        side,
        tradeable,
        // First failing gate, in the order selectTfCandidates checks them, so
        // the card explains the engine instead of guessing alongside it. A name
        // that cleared every gate on a board too old to act on is labelled as
        // exactly that — never left reading as a pass.
        blockedBy: tradeable
          ? null
          : picked.has(r.symbol)
            ? stale
              ? `cleared the gates on ${date}, not today`
              : 'board too old to act on'
            : (needs ?? 'below the pick limit'),
        premValueCr: ctx?.premValueCr ?? null,
        sinceEntryPct: ctx?.sinceEntryPct ?? null,
        stretch: ctx?.stretch ?? null,
        supertrendAligned: ctx?.supertrendAligned ?? null,
        breakout: ctx?.breakout ?? null,
        gates,
        needs,
        trend: rTrend(boards, r.symbol, asOfMinute),
        climbingSince: climbingSince(boards, r.symbol, asOfMinute, LIVE_TF_SELECTOR_CONFIG.minDeltaR),
        rPath: rPath(boards, r.symbol, RACE_WINDOW_START_MIN, asOfMinute),
        beacon: beacons.get(r.symbol) ?? null,
        sector: pickSector(basketsBySymbol.get(r.symbol) ?? [], sectorValues),
      };
    });
    // Climbers that left the top 20 stay visible (operator, 2026-10-08).
    climbed = dayClimbers(boards, asOfMinute, eligible);
    dropped = droppedClimbers(boards, {
      asOfMin: asOfMinute,
      fromMin: RACE_WINDOW_START_MIN,
      topN: TF_RACE_MAX_RANK,
      minDeltaR: LIVE_TF_SELECTOR_CONFIG.minDeltaR,
      onBoardNow: new Set(shown.map((r) => r.symbol)),
    }).filter((d) => eligible.has(d.symbol));
  } catch (error) {
    // The board is an enhancement; its failure must not blank the card.
    console.warn(`[TfRace] full board unavailable: ${(error as Error).message}`);
  }

  return {
    success: true,
    ...result,
    stale,
    date,
    board,
    boardMinuteIST,
    boardAgeMin,
    verdictsLive,
    verdictNote,
    sessionOpenedToday,
    dropped,
    climbed,
    // The ENTRY window (auto-trade config) — not the race's 09:35 measuring start.
    ...(await entryWindow()),
  };
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
  /** Recorded stretch vs the stock's normal day — evidence only, not a gate. */
  stretch: Stretch | null;
  supertrendAligned: boolean | null;
  breakout: boolean | null;
  /** The six selector checks, in its order — all true ⇔ the selector picks it. */
  gates: GateStrip;
  /** Plain English for the first check not passed, or null. */
  needs: string | null;
  trend: 'faster' | 'slower' | 'steady' | null;
  /** IST minute the current unbroken climb began, or null when not climbing. */
  climbingSince: number | null;
  rPath: { minute: number; r: number }[];
  beacon: TfBeacon | null;
  sector: { name: string; value: number } | null;
}
