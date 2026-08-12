/**
 * TF Running Race — who TradeFinder itself ranks as gaining fastest in the
 * 09:45–11:00 IST entry window, mirroring lib/signals/rank-tracker.ts's
 * "running race" pattern but sourced from TradeFinder's own R-Factor
 * (captured periodically on /tf) instead of NSE's live pulse feeds.
 *
 * Same discipline as the existing rank-tracker: this is PARTICIPATION
 * evidence — who is climbing TF's own leaderboard — NOT an entry signal on
 * its own. It never selects, approves, or sizes a trade; the existing
 * scanner gates in lib/trade-suggest/ do that. Never fabricated: if fewer
 * than two captures exist inside the window, there is no race to show, and
 * this says so rather than inventing a rank from a single data point.
 */
import { prisma } from '@/lib/db';
import { parseAllSector } from '@/lib/tf-live/parse';

/**
 * 09:35 IST, moved back from 09:45 (operator, 2026-08-11) so accumulation that
 * starts right after the open is visible instead of being cut off. 09:30 was
 * considered and rejected on the real captures: TradeFinder's R-Factor is still
 * bunched that early — on 2026-08-10 only 13 of 210 symbols were above R=1 at
 * 09:30 versus 22 by 09:45 — so ranking there is dominated by hundredths and
 * produces large, meaningless rank swings. See MIN_SPREAD_SYMBOLS.
 */
const WINDOW_START_MIN = 9 * 60 + 35; // 09:35 IST
const WINDOW_END_MIN = 11 * 60; // 11:00 IST

/**
 * A capture may only serve as the RACE BASELINE if at least this many symbols
 * have separated above R=1. Without this guard an early degenerate board
 * silently becomes the yardstick and every climb measured off it is fiction —
 * not hypothetical: the 09:16 capture on 2026-08-10 had ALL 210 R-Factors at
 * exactly 0 (TradeFinder resetting for the new day), which would have ranked
 * symbols in arbitrary object order and reported the entire board as "climbing".
 */
const MIN_SPREAD_SYMBOLS = 8;

export interface TfRaceRunner {
  symbol: string;
  rankNow: number;
  rankAtWindowStart: number | null;
  deltaSinceWindowStart: number | null;
  rFactorNow: number | null;
  isNew: boolean;
  track: (number | null)[];
}

export interface TfRaceResult {
  date: string;
  /** True once at least 2 usable captures exist inside 09:35–11:00 IST today. */
  hasRace: boolean;
  /** Epoch-ms of every capture used, oldest → newest (the sparkline x-axis). */
  captureTimes: number[];
  /** Epoch-ms of the capture the race is measured FROM. Surfaced so the card can
   *  state the real baseline time instead of implying it is always 09:35 — when
   *  early boards fail MIN_SPREAD_SYMBOLS the true baseline is later. */
  baselineAt: number | null;
  /** True when one or more captures at the front of the window were skipped for
   *  failing MIN_SPREAD_SYMBOLS, so the UI can say the baseline slipped. */
  baselineDelayed: boolean;
  runners: TfRaceRunner[];
  newEntrants: TfRaceRunner[];
}

function minutesIST(iso: string): number {
  const parts = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return hour * 60 + minute;
}


/**
 * Ranks every symbol by TF's own R-Factor at each successful `all_sector`
 * capture inside today's 09:45–11:00 IST window, then reports who climbed
 * from the FIRST capture in that window to the LATEST. `maxRank` keeps the
 * race to names actually near the front (mirrors rank-tracker's `maxRank=20`).
 */
export async function getTfRaceForWindow(date: string, maxRank = 20, limit = 20): Promise<TfRaceResult> {
  const empty: TfRaceResult = {
    date,
    hasRace: false,
    captureTimes: [],
    baselineAt: null,
    baselineDelayed: false,
    runners: [],
    newEntrants: [],
  };

  const captures = (await prisma.$queryRawUnsafe(
    `
    SELECT id, capturedAt, payloadJson
    FROM tf_live_captures
    WHERE endpoint = 'all_sector' AND status = 'success'
      AND date(datetime(capturedAt, '+5 hours', '+30 minutes')) = ?
    ORDER BY capturedAt ASC
  `,
    date
  )) as { id: number; capturedAt: string; payloadJson: string | null }[];

  const rawWindow = captures.filter((c) => {
    const min = minutesIST(c.capturedAt);
    return min >= WINDOW_START_MIN && min <= WINDOW_END_MIN;
  });
  if (rawWindow.length < 2) return empty;

  // Score every in-window capture ONCE, keeping the ranked board and how many
  // symbols actually separated above R=1 (the spread measure the guard uses).
  const scoredCaptures = rawWindow.map((capture) => {
    let scored: { symbol: string; rFactor: number }[] = [];
    if (capture.payloadJson) {
      try {
        scored = parseAllSector(JSON.parse(capture.payloadJson))
          .filter((r): r is typeof r & { rFactor: number } => r.rFactor != null)
          .map((r) => ({ symbol: r.symbol, rFactor: r.rFactor }))
          .sort((a, b) => b.rFactor - a.rFactor);
      } catch {
        /* a malformed capture just contributes an empty board, not a crash */
      }
    }
    const board = new Map<string, number>();
    scored.forEach((s, i) => board.set(s.symbol, i + 1));
    return {
      capturedAt: capture.capturedAt,
      board,
      scored,
      spread: scored.filter((s) => s.rFactor > 1).length,
    };
  });

  // THE GUARD. Drop degenerate boards from the FRONT only — they are unusable
  // as a baseline but perfectly fine to have happened. Once a capture with real
  // spread appears, everything from there on is kept, including any later thin
  // board, because by then we are measuring against a sound yardstick.
  const firstUsable = scoredCaptures.findIndex((c) => c.spread >= MIN_SPREAD_SYMBOLS);
  if (firstUsable === -1) return empty;
  const inWindow = scoredCaptures.slice(firstUsable);
  if (inWindow.length < 2) return empty;

  const rankBoards = inWindow.map((c) => c.board);
  const rFactorNowBySymbol = new Map<string, number>();
  for (const s of inWindow[inWindow.length - 1].scored) rFactorNowBySymbol.set(s.symbol, s.rFactor);

  const allSymbols = new Set<string>();
  for (const board of rankBoards) for (const symbol of board.keys()) allSymbols.add(symbol);

  const lastIdx = rankBoards.length - 1;
  const runners: TfRaceRunner[] = [];
  const newEntrants: TfRaceRunner[] = [];
  for (const symbol of allSymbols) {
    const rankNow = rankBoards[lastIdx].get(symbol);
    if (rankNow == null || rankNow > maxRank) continue;
    const track = rankBoards.map((board) => board.get(symbol) ?? null);
    const rankAtWindowStart = track[0];
    const rFactorNow = rFactorNowBySymbol.get(symbol) ?? null;
    if (rankAtWindowStart == null) {
      newEntrants.push({ symbol, rankNow, rankAtWindowStart: null, deltaSinceWindowStart: null, rFactorNow, isNew: true, track });
    } else {
      const delta = rankAtWindowStart - rankNow; // positive = climbed toward #1
      if (delta > 0) {
        runners.push({ symbol, rankNow, rankAtWindowStart, deltaSinceWindowStart: delta, rFactorNow, isNew: false, track });
      }
    }
  }
  // Ordered by TF's own R-Factor, strongest first (operator, 2026-08-11). WHO is
  // climbing is still the entry criterion — a name only appears here if it
  // gained ground since the baseline — but among those, the board should read
  // strongest-first, so the biggest R sits at the top rather than whoever
  // happened to travel the most rank places. A name that climbed 190 places into
  // R 1.5 is a smaller fish than one that climbed 30 into R 2.5.
  // Ties fall back to the larger climb, then the better current rank.
  const byRFactor = (a: TfRaceRunner, b: TfRaceRunner): number =>
    (b.rFactorNow ?? Number.NEGATIVE_INFINITY) - (a.rFactorNow ?? Number.NEGATIVE_INFINITY) ||
    (b.deltaSinceWindowStart ?? 0) - (a.deltaSinceWindowStart ?? 0) ||
    a.rankNow - b.rankNow;
  runners.sort(byRFactor);
  newEntrants.sort(byRFactor);

  return {
    date,
    hasRace: true,
    captureTimes: inWindow.map((c) => new Date(c.capturedAt).getTime()),
    baselineAt: new Date(inWindow[0].capturedAt).getTime(),
    baselineDelayed: firstUsable > 0,
    runners: runners.slice(0, limit),
    newEntrants: newEntrants.slice(0, limit),
  };
}
