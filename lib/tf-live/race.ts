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

const WINDOW_START_MIN = 9 * 60 + 45; // 09:45 IST
const WINDOW_END_MIN = 11 * 60; // 11:00 IST

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
  /** True once at least 2 captures exist inside 09:45–11:00 IST today. */
  hasRace: boolean;
  /** Epoch-ms of every capture used, oldest → newest (the sparkline x-axis). */
  captureTimes: number[];
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
  const empty: TfRaceResult = { date, hasRace: false, captureTimes: [], runners: [], newEntrants: [] };

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

  const inWindow = captures.filter((c) => {
    const min = minutesIST(c.capturedAt);
    return min >= WINDOW_START_MIN && min <= WINDOW_END_MIN;
  });
  if (inWindow.length < 2) return empty;

  // Rank each capture's symbols by R-Factor descending (rank 1 = highest).
  const rankBoards: Map<string, number>[] = [];
  const rFactorNowBySymbol = new Map<string, number>();
  for (const [index, capture] of inWindow.entries()) {
    const board = new Map<string, number>();
    if (capture.payloadJson) {
      try {
        const scored = parseAllSector(JSON.parse(capture.payloadJson))
          .filter((r): r is typeof r & { rFactor: number } => r.rFactor != null)
          .map((r) => ({ symbol: r.symbol, rFactor: r.rFactor }));
        scored.sort((a, b) => b.rFactor - a.rFactor);
        scored.forEach((s, i) => board.set(s.symbol, i + 1));
        if (index === inWindow.length - 1) {
          for (const s of scored) rFactorNowBySymbol.set(s.symbol, s.rFactor);
        }
      } catch {
        /* a malformed capture just contributes an empty board, not a crash */
      }
    }
    rankBoards.push(board);
  }

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
  runners.sort((a, b) => (b.deltaSinceWindowStart ?? 0) - (a.deltaSinceWindowStart ?? 0) || a.rankNow - b.rankNow);
  newEntrants.sort((a, b) => a.rankNow - b.rankNow);

  return {
    date,
    hasRace: true,
    captureTimes: inWindow.map((c) => new Date(c.capturedAt).getTime()),
    runners: runners.slice(0, limit),
    newEntrants: newEntrants.slice(0, limit),
  };
}
