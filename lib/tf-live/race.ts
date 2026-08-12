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

/**
 * One ranked TradeFinder board, at one capture time — the unit the point-in-time
 * form below is built from.
 */
export interface TfBoardAt {
  /** Minutes past midnight IST of the capture this board came from. */
  minuteIST: number;
  capturedAt: string;
  /** symbol → 1-based rank by TF R-Factor (1 = highest). */
  rank: Map<string, number>;
  /** symbol → TF R-Factor. */
  rFactor: Map<string, number>;
  /** symbol → TF's own % change on the day (the ONLY direction TF gives us). */
  pctChange: Map<string, number | null>;
  /** How many symbols separated above R = 1 — the MIN_SPREAD_SYMBOLS measure. */
  spread: number;
}

/** A race runner as of a specific minute, carrying the accumulation RATE. */
export interface TfRunnerAt {
  symbol: string;
  rankNow: number;
  rankAtBaseline: number;
  /** Places gained since the baseline board. Always > 0 for a runner. */
  climb: number;
  rFactorNow: number;
  /** TF R-Factor `LOOKBACK_MIN` earlier, or null when no earlier board exists. */
  rFactorAgo: number | null;
  /**
   * Accumulation RATE: rFactorNow − rFactorAgo over the trailing window.
   * Null (not 0) when there is no earlier board — "unknown" and "flat" must not
   * collapse, because the selector REJECTS flat and must also reject unknown.
   */
  deltaR: number | null;
  pctChange: number | null;
}

export interface TfRaceAt {
  /** False when no usable baseline board exists yet — treat as no evidence. */
  available: boolean;
  boardMinuteIST: number | null;
  capturedAt: string | null;
  baselineMinuteIST: number | null;
  /** Ranked by TF R-Factor desc, as the /tf page ranks them. */
  runners: TfRunnerAt[];
}

/** Trailing window for the accumulation rate (minutes). 30 min was measured as
 *  the span over which a frozen board separates from a still-building one — see
 *  the design note in docs/superpowers/specs/2026-08-13-tf-rfactor-selector-design.md. */
export const DELTA_R_LOOKBACK_MIN = 30;

const EMPTY_RACE_AT: TfRaceAt = {
  available: false,
  boardMinuteIST: null,
  capturedAt: null,
  baselineMinuteIST: null,
  runners: [],
};

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
 * Every successful `all_sector` capture for `date`, parsed and ranked, oldest
 * first. One board per CLOCK MINUTE — the collector can write several captures
 * inside one minute and they carry identical values, which would otherwise let
 * a "30 minutes ago" lookup land 30 *captures* back instead.
 *
 * Shared by the display race below and by the point-in-time selector form, so
 * both see byte-identical boards.
 */
export async function getTfBoardsForDate(date: string): Promise<TfBoardAt[]> {
  const captures = (await prisma.$queryRawUnsafe(
    `
    SELECT capturedAt, payloadJson
    FROM tf_live_captures
    WHERE endpoint = 'all_sector' AND status = 'success'
      AND date(datetime(capturedAt, '+5 hours', '+30 minutes')) = ?
    ORDER BY capturedAt ASC
  `,
    date
  )) as { capturedAt: string; payloadJson: string | null }[];

  const boards: TfBoardAt[] = [];
  for (const capture of captures) {
    if (!capture.payloadJson) continue;
    let scored: { symbol: string; rFactor: number; pctChange: number | null }[] = [];
    try {
      scored = parseAllSector(JSON.parse(capture.payloadJson))
        .filter((r): r is typeof r & { rFactor: number } => r.rFactor != null && Number.isFinite(r.rFactor))
        .map((r) => ({ symbol: r.symbol.toUpperCase(), rFactor: r.rFactor, pctChange: r.pctChange }))
        .sort((a, b) => b.rFactor - a.rFactor);
    } catch {
      continue; // a malformed capture contributes nothing, never a crash
    }
    if (scored.length === 0) continue;
    const minuteIST = minutesIST(capture.capturedAt);
    // Collapse same-minute duplicates: keep the FIRST, which is the one whose
    // timestamp the rest of the pipeline reports.
    if (boards.length > 0 && boards[boards.length - 1].minuteIST === minuteIST) continue;
    boards.push({
      minuteIST,
      capturedAt: capture.capturedAt,
      rank: new Map(scored.map((s, i) => [s.symbol, i + 1])),
      rFactor: new Map(scored.map((s) => [s.symbol, s.rFactor])),
      pctChange: new Map(scored.map((s) => [s.symbol, s.pctChange])),
      spread: scored.filter((s) => s.rFactor > 1).length,
    });
  }
  return boards;
}

/**
 * The race AS OF one minute of the session — the form the trade selector needs.
 *
 * Differs from `getTfRaceForWindow` in exactly one way that matters: it uses
 * only boards captured at or before `asOfMinuteIST`, so a replay at 10:15
 * cannot see 10:20's board. That is what makes the backtest and the live path
 * comparable; the display function deliberately always reports the latest.
 *
 * Returns `available: false` — never an empty runner list — when no board has
 * yet cleared MIN_SPREAD_SYMBOLS, because "TF has nothing usable" and "TF says
 * nobody is running" are different facts and the caller must not conflate them.
 */
export function raceAtMinute(
  boards: TfBoardAt[],
  asOfMinuteIST: number,
  maxRank = 20,
  lookbackMin = DELTA_R_LOOKBACK_MIN
): TfRaceAt {
  const upTo = boards.filter((b) => b.minuteIST <= asOfMinuteIST);
  if (upTo.length === 0) return EMPTY_RACE_AT;

  // The baseline is the first board in the window with real spread. The guard
  // exists because TradeFinder zeroes the whole board while resetting for the
  // day (2026-08-10 09:16: all 210 R-Factors exactly 0), and anchoring there
  // ranks symbols in arbitrary order and calls the entire board "climbing".
  const baseline = upTo.find((b) => b.minuteIST >= WINDOW_START_MIN && b.spread >= MIN_SPREAD_SYMBOLS);
  if (!baseline) return EMPTY_RACE_AT;

  // Need two DISTINCT points for a trajectory. Compared on minuteIST, not
  // capturedAt: the minute is what identifies a board here (same-minute captures
  // were already collapsed upstream), and a string compare would also make this
  // depend on timestamp formatting rather than on time.
  const now = upTo[upTo.length - 1];
  if (now.minuteIST === baseline.minuteIST) return EMPTY_RACE_AT;

  const ago = [...upTo].reverse().find((b) => b.minuteIST <= asOfMinuteIST - lookbackMin) ?? null;

  const runners: TfRunnerAt[] = [];
  for (const [symbol, rankNow] of now.rank) {
    if (rankNow > maxRank) continue;
    const rankAtBaseline = baseline.rank.get(symbol);
    if (rankAtBaseline == null) continue; // no baseline rank = no measurable climb
    const climb = rankAtBaseline - rankNow;
    if (climb <= 0) continue;
    const rFactorNow = now.rFactor.get(symbol)!;
    const rFactorAgo = ago?.rFactor.get(symbol) ?? null;
    runners.push({
      symbol,
      rankNow,
      rankAtBaseline,
      climb,
      rFactorNow,
      rFactorAgo,
      deltaR: rFactorAgo == null ? null : rFactorNow - rFactorAgo,
      pctChange: now.pctChange.get(symbol) ?? null,
    });
  }
  // Strongest R first — same order the /tf board uses (operator, 2026-08-11):
  // a name that climbed 190 places into R 1.5 is a smaller fish than one that
  // climbed 30 into R 2.5. Ties fall back to the larger climb, then better rank.
  runners.sort(
    (a, b) => b.rFactorNow - a.rFactorNow || b.climb - a.climb || a.rankNow - b.rankNow
  );

  return {
    available: true,
    boardMinuteIST: now.minuteIST,
    capturedAt: now.capturedAt,
    baselineMinuteIST: baseline.minuteIST,
    runners,
  };
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
