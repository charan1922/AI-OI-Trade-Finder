/**
 * THE trade selector: TradeFinder's Running Race → ranked, directional candidates.
 *
 * This replaces the App R-Factor sweep as the ONLY candidate source for
 * /trade-suggest and the auto-trader (operator rule, 2026-08-13). App R-Factor
 * still renders on /live as a column; it no longer decides anything.
 *
 * ── WHY (the measurement that forced this) ───────────────────────────────────
 *
 * Pairing every graded suggestion with the TF board captured AT OR BEFORE it
 * (strict no-lookahead) over the three sessions that have TF captures:
 *
 *   TF R-Factor < 1.0  →  −0.317R over n=1603,  t = −11.12
 *
 * That is the only unambiguous statistic in the whole investigation, and 81% of
 * what the old engine considered tradeable sat there. App R-Factor scored those
 * same names 3.65–6.45 — i.e. "strong" — with no discriminating power at all
 * (LUPIN at TF R 0.22, LICI at 0.68, BOSCHLTD at 0.55; all −1R).
 *
 * The race's `maxRank` cap is what removes them: rank ≤ 20 corresponded to
 * TF R ≈ 1.4 on all three sessions, so a sub-1.0 name is structurally
 * unreachable through this path rather than merely discouraged.
 *
 * ── R-FACTOR IS A COUNTER, NOT A GAUGE ──────────────────────────────────────
 *
 * Across 107,726 intraday readings TF's R-Factor decreased 0.47% of the time —
 * it only ratchets up within a session. So the LEVEL is cumulative money in, and
 * the SLOPE is money arriving now. They are different signals:
 *
 *   FORTIS      2026-08-12  R 1.76 → 4.66 as price ran −2.85% → −5.83%   (+2R)
 *   APOLLOHOSP  2026-08-11  R froze at 3.50 from 09:51, rank #1 all day,
 *                           price chopped −0.67%…−2.42%                  (−1R)
 *
 * APOLLOHOSP held the highest R on the board and went nowhere. A snapshot
 * endorses it; the slope rejects it. Hence `minDeltaR` — and hence a null
 * `deltaR` (no earlier board) REJECTS rather than passes: unknown is not flat.
 *
 * ── DIRECTION ───────────────────────────────────────────────────────────────
 *
 * TF's R-Factor is DIRECTIONLESS — it says "big money is here", never "this is
 * going up". CROMPTON topped TF's own board on 2026-08-07 while trading −6.39%.
 * Direction therefore comes from TF's own % change and the required opening-
 * range breakout. Supertrend was removed from this path on 2026-08-14 and brought
 * BACK as a veto on 2026-10-29 (operator: "do as the MiMo said"): check ⑧ rejects
 * a pick whose Supertrend(10,3) points AGAINST the trade. It never admits or ranks.
 * Recorded caveat: on the 47 graded TF-era suggestions (2026-08-13..10-13) the 9
 * Supertrend-disagree picks averaged +0.21R vs 0.00R for the 37 agreeing ones — the
 * local data did not support this veto; MiMo cited 14..28 Oct (not held locally).
 * Re-measure on graded outcomes before keeping or removing it (rejected.supertrendAgainst).
 *
 * ── PURITY ──────────────────────────────────────────────────────────────────
 *
 * No I/O, no clock, no env — same discipline as scoring.ts and grade.ts. The
 * replay harness and the live engine call THIS function with the same shape of
 * input, so a backtest result and a live pick cannot diverge through code drift.
 * Every rejection is counted by name, so /trade-suggest can say WHY a board
 * produced nothing instead of showing an unexplained empty list.
 */

import type { TfRunnerAt } from '@/lib/tf-live/race';
import type { NseListMembership } from '@/lib/nse/live-lists';
import type { Stretch } from '@/lib/tf-live/stretch';
import type { TrendShape } from '@/lib/tf-live/trend-shape';
import { classifyMoveFreshness, type MoveFreshness, type MoveProfile } from '@/lib/trade-suggest/move-freshness';

/** Per-symbol evidence the selector needs but cannot derive from the TF board. */
export interface TfSymbolContext {
  /** Supertrend(10,3) on today's completed 5-min bars agrees with the trade side. Check ⑧:
   *  `false` REJECTS (operator 2026-10-29). `null` = not formed yet (supertrend() needs 12
   *  completed 5-min bars, i.e. ~10:15) and PASSES — failing closed would forbid every entry 09:45–10:15, which
   *  was never asked for; the reason line says it was not formed. */
  supertrendAligned: boolean | null;
  /** Direction-aware move from today's 09:15 open (%), positive = our way. With
   *  sinceEntryPct it classifies the move (lib/trade-suggest/move-freshness.ts) for
   *  check ⑨ — quiet vs spent depends on it. REQUIRED so no builder forgets it. */
  dayMovePct: number | null;
  /** True when price has cleared the 30-MIN opening range (09:15–09:45) in the
   *  trade's direction. Back to 30 min on 2026-10-09 (operator: "make ORB 30
   *  mins") after a one-day switch to 15. Null = range not complete → REJECTED. */
  breakout: boolean | null;
  /** The same test against the 15-min range (09:15–09:30). A recorded SHADOW so
   *  15 vs 30 can still be compared on graded trades — the selector never reads it. */
  breakout15: boolean | null;
  /** TradeFinder's own breakout beacon for this symbol (market_pulse
   *  breakout_beacon), or null when TF has not flagged it. Must agree with the
   *  trade's side (operator, 2026-10-08: our ORB AND TF's beacon). */
  tfBeacon: 'BULL' | 'BEAR' | null;
  /** NSE options premium pool traded today (₹ Cr) — the tradeability read.
   *  Null = the name was not on a /live watchlist, so we have no evidence. */
  premValueCr: number | null;
  /** Direction-aware price change since 09:45 IST (%), positive = moving our
   *  way. Null before 09:45 / when unrecorded. */
  sinceEntryPct: number | null;
  /** How stretched the stock already is vs its normal day (lib/tf-live/stretch.ts).
   *  Read by the "don't chase" check ⑥. REQUIRED so no builder can forget it; null
   *  (no ADR baseline) REJECTS — missing evidence never passes. */
  stretch: Stretch | null;
  /** Which of /live's visible NSE lists (F&O OI Build-up, Most Active) the stock is in
   *  (lib/nse/live-lists.ts). Read by check ⑦. REQUIRED so no builder can forget it;
   *  null (lists unavailable or stale) REJECTS as unknown — never as "in neither". */
  nseLists: NseListMembership | null;
  /** ADVISORY "trend day" chart shape (lib/tf-live/trend-shape.ts) — the /live card's 10th
   *  dot. The selector NEVER reads it; optional so the live scanner need not build it. */
  trendShape?: TrendShape | null;
}

export interface TfSelectorConfig {
  /** Reject a runner whose accumulation rate is at or below this (frozen R). */
  minDeltaR: number;
  /** Reject a runner whose |TF % change| is below this — no move, no direction. */
  minAbsPctChange: number;
  /** Reject when the options premium pool is below this (₹ Cr). */
  minPremValueCr: number;
  /** Reject a move already this far extended since 09:45 (%). */
  maxSinceEntryPct: number;
  /** Require an opening-range breakout in the trade's direction. */
  requireBreakout: boolean;
  /** Require TF's breakout beacon in the trade's direction (BULL for CE, BEAR for PE). */
  requireTfBeacon: boolean;
  /** Reject when the 09:15 candle's range is at least this many normal days (ADR). */
  maxFirstCandleAdr: number;
  /** Reject when the move from the previous close (trade direction) is at least this many ADRs. */
  maxFromPrevCloseAdr: number;
  /** Require the stock to be in the visible F&O OI Build-up OR Most Active list on /live. */
  requireNseList: boolean;
  /** Rank cut-off WITHIN each visible list (e.g. 10 = top 10). Null = the whole visible list. */
  maxNseListRank: number | null;
  /** ⑧ Reject when Supertrend(10,3) points against the trade (operator 2026-10-29). */
  rejectSupertrendAgainst: boolean;
  /** ⑨ Move-freshness profiles that REJECT (operator 2026-10-29: 'quiet' = nothing has started
   *  since 09:45, 'fading' = buying into the unwind). 'spent' and 'unknown' stay warnings. */
  rejectMoveProfiles: readonly MoveProfile[];
  /** Cap on returned candidates. */
  maxCandidates: number;
}

export interface TfCandidate {
  symbol: string;
  side: 'CE' | 'PE';
  tfRFactor: number;
  tfRankNow: number;
  tfRankAtBaseline: number;
  tfClimb: number;
  deltaR: number;
  tfPctChange: number;
  premValueCr: number;
  sinceEntryPct: number | null;
  breakout: boolean;
  /** Human-readable evidence, in the order it was checked. */
  reasons: string[];
}

/** Why runners were dropped. Every key is surfaced, so an empty result is
 *  always explainable rather than mysterious. */
export interface TfSelectorRejections {
  noBoard: number;
  frozenR: number;
  unknownDeltaR: number;
  flatPrice: number;
  noBreakout: number;
  /** No price data to test the opening range — kept apart from noBreakout so
   *  missing data is never narrated as a failed range (2026-10-08). */
  breakoutUnknown: number;
  noTfBeacon: number;
  thinPremium: number;
  premiumUnknown: number;
  moveExhausted: number;
  /** No ADR baseline or no 09:15 candle — the chase check could not be made. */
  stretchUnknown: number;
  /** Long opening candle, or already ran 2+ normal days from the previous close. */
  chasing: number;
  /** The NSE lists were unavailable/stale, or one was down and the stock was in none of the others. */
  listsUnknown: number;
  /** Every list was read and the stock is in none of them. */
  notInNseLists: number;
  /** ⑧ Supertrend(10,3) points against the trade. */
  supertrendAgainst: number;
  /** ⑨ Flat since 09:45 with no big day move — nothing has started yet. */
  quietMove: number;
  /** ⑨ Moving AGAINST the trade since 09:45 — buying into the unwind. */
  fadingMove: number;
}

export interface TfSelectorResult {
  candidates: TfCandidate[];
  rejected: TfSelectorRejections;
  /** Runners the race offered before any selector gate ran. */
  considered: number;
}

const emptyRejections = (): TfSelectorRejections => ({
  noBoard: 0,
  frozenR: 0,
  unknownDeltaR: 0,
  flatPrice: 0,
  noBreakout: 0,
  breakoutUnknown: 0,
  noTfBeacon: 0,
  thinPremium: 0,
  premiumUnknown: 0,
  moveExhausted: 0,
  stretchUnknown: 0,
  chasing: 0,
  listsUnknown: 0,
  notInNseLists: 0,
  supertrendAgainst: 0,
  quietMove: 0,
  fadingMove: 0,
});

/**
 * Check ⑨'s classification. Both inputs are already direction-aware (positive =
 * our way), so they are handed to classifyMoveFreshness as a 'bullish' move —
 * the same thresholds the trader's evidence uses, never a second definition.
 */
export function tfMoveFreshness(ctx: Pick<TfSymbolContext, 'sinceEntryPct' | 'dayMovePct'>): MoveFreshness {
  return classifyMoveFreshness({
    sinceEntryPct: ctx.sinceEntryPct,
    changePctOpen: ctx.dayMovePct,
    direction: 'bullish',
  });
}

/**
 * Defaults measured over 2026-08-10..12. TREAT AS FITTED — roughly 100 variants
 * were tried on three sessions, so these thresholds are the least trustworthy
 * part of this module. The DIRECTION of each (higher R, still climbing, real
 * premium pool) held in every cut; the exact numbers did not get
 * a chance to. `minPremValueCr` sits at the top of the tested ₹6–20 Cr plateau
 * and should be the first constant re-checked as live sessions accumulate.
 */
export const DEFAULT_TF_SELECTOR_CONFIG: TfSelectorConfig = {
  minDeltaR: 0.05,
  minAbsPctChange: 0.3,
  minPremValueCr: 20,
  maxSinceEntryPct: 2,
  requireBreakout: true,
  // Operator, 2026-10-08: "both" — our ORB AND TF's beacon. Not replayable on
  // history (no stored beacons for a usable session), so it is measured forward
  // through the `noTfBeacon` rejection count.
  requireTfBeacon: true,
  // Operator rule 2026-10-09 ("don't chase"): COLPAL (09:15 candle 1.62×, ran 2.92×) and
  // TCS (1.54×, 2.37×) were bought after the move and lost ₹6,352; every good entry of
  // 2026-10-06/08 sat at ≤ 1.02× and ≤ 1.85×. On 1,458 spot breakouts it blocks 0.8%.
  maxFirstCandleAdr: 1.25,
  maxFromPrevCloseAdr: 2.0,
  // Operator rule 2026-10-12: the stock must be in /live's visible "F&O OI Build-up" or
  // "Most Active" list ("F, M or FM should inside it"). Whole visible list by default; set
  // maxNseListRank to 10 for a strict top 10. 8 historic entries rebuilt from stored NSE OI %:
  // blocks EICHERMOT and TCS (losers) and RELIANCE (a winner), passes the 8-Oct trend trades.
  requireNseList: true,
  maxNseListRank: null,
  // Operator rule 2026-10-29 ("do as the MiMo said"). MiMo's case: 15 Oct M&M, BHARTIARTL, OFSS,
  // NESTLEIND (Supertrend disagreeing, two flat-line, OFSS "buying into the unwind") all missed.
  // Local graded data (2026-08-13..10-13): quiet+fading 3 trades, all lost; Supertrend-disagree
  // 9 trades averaged BETTER than agree. Judge forward via the rejection counts.
  rejectSupertrendAgainst: true,
  rejectMoveProfiles: ['quiet', 'fading'],
  maxCandidates: 7,
};

/** /live uses the same selector thresholds as the money path. */
export const LIVE_TF_SELECTOR_CONFIG: TfSelectorConfig = {
  ...DEFAULT_TF_SELECTOR_CONFIG,
};

/**
 * Filter and rank race runners into tradeable candidates.
 *
 * `runners` must already be ordered by TF R-Factor desc (as `raceAtMinute`
 * returns them); the output preserves that order, so the caller's "take the
 * best N" is TF's own ranking rather than a re-derived one.
 *
 * REQUIRED MISSING EVIDENCE IS A REJECTION. A null breakout or premium pool
 * drops the name. Supertrend (⑧) and freshness (⑨) are VETOES, not requirements: a
 * known disagreement / quiet / fading move rejects, a not-yet-formed reading passes
 * (stated in the reasons). This module never treats "we could
 * not check" as "it passed", which is the same fail-closed rule the risk gates
 * keep.
 */
export function selectTfCandidates(
  runners: TfRunnerAt[],
  context: Map<string, TfSymbolContext>,
  cfg: TfSelectorConfig = DEFAULT_TF_SELECTOR_CONFIG
): TfSelectorResult {
  const rejected = emptyRejections();
  const candidates: TfCandidate[] = [];

  for (const runner of runners) {
    // ① Still accumulating. Unknown is counted separately from frozen so the
    //    operator can tell "TF stalled" from "we have no earlier board yet".
    if (runner.deltaR == null) {
      rejected.unknownDeltaR++;
      continue;
    }
    if (runner.deltaR <= cfg.minDeltaR) {
      rejected.frozenR++;
      continue;
    }

    // ② Direction — TF's own move is the only directional read TF gives us.
    const pct = runner.pctChange;
    if (pct == null || Math.abs(pct) < cfg.minAbsPctChange) {
      rejected.flatPrice++;
      continue;
    }
    const side: 'CE' | 'PE' = pct > 0 ? 'CE' : 'PE';

    const ctx = context.get(runner.symbol);
    if (ctx == null) {
      rejected.noBoard++;
      continue;
    }

    // ③ Breakout. (Supertrend is check ⑧, a veto — see below.)
    if (cfg.requireBreakout && ctx.breakout !== true) {
      if (ctx.breakout == null) rejected.breakoutUnknown++;
      else rejected.noBreakout++;
      continue;
    }

    // ③b TF's own breakout beacon must agree. Null = TF has not flagged it = reject.
    if (cfg.requireTfBeacon && ctx.tfBeacon !== (side === 'CE' ? 'BULL' : 'BEAR')) {
      rejected.noTfBeacon++;
      continue;
    }

    // ④ Tradeability: a real options premium pool to trade against.
    if (ctx.premValueCr == null) {
      rejected.premiumUnknown++;
      continue;
    }
    if (ctx.premValueCr < cfg.minPremValueCr) {
      rejected.thinPremium++;
      continue;
    }

    // ⑤ Do not chase. FORTIS 2026-08-12 is the case: entries at −3.82% and
    //    −4.02% hit target, entries at −4.78% and −5.34% stopped — same name,
    //    same day, same direction. A null reading is NOT a rejection here: it
    //    only means the 09:45 bar was unrecorded, and the other five gates have
    //    already established the setup.
    if (ctx.sinceEntryPct != null && ctx.sinceEntryPct >= cfg.maxSinceEntryPct) {
      rejected.moveExhausted++;
      continue;
    }

    // ⑥ Don't chase (operator rule 2026-10-09). ⑤ only sees the move since 09:45; a
    //    stock that made its whole move between 09:15 and 09:45 (COLPAL: a 09:15 candle
    //    1.62× its normal day) slipped through it. Unknown REJECTS, counted apart.
    if (ctx.stretch == null || ctx.stretch.firstCandle == null) {
      rejected.stretchUnknown++;
      continue;
    }
    if (
      ctx.stretch.firstCandle >= cfg.maxFirstCandleAdr ||
      ctx.stretch.fromPrevCloseAdr >= cfg.maxFromPrevCloseAdr
    ) {
      rejected.chasing++;
      continue;
    }

    // ⑦ Must be in /live's visible F&O OI Build-up or Most Active list (operator rule
    //    2026-10-12). Found in either (or both) = pass. A stock found in NO readable list
    //    is "in neither" only when every list was read; with a feed down it is UNKNOWN.
    if (cfg.requireNseList) {
      const lists = ctx.nseLists;
      if (lists == null) {
        rejected.listsUnknown++;
        continue;
      }
      const within = (rank: number | null) => rank != null && (cfg.maxNseListRank == null || rank <= cfg.maxNseListRank);
      if (!within(lists.oiBuildupRank) && !within(lists.mostActiveRank)) {
        if (lists.complete) rejected.notInNseLists++;
        else rejected.listsUnknown++;
        continue;
      }
    }

    // ⑧ Supertrend veto (operator rule 2026-10-29). Only a KNOWN disagreement rejects;
    //    a not-yet-formed Supertrend (< 12 completed bars, before ~10:15) passes — see TfSymbolContext.
    if (cfg.rejectSupertrendAgainst && ctx.supertrendAligned === false) {
      rejected.supertrendAgainst++;
      continue;
    }

    // ⑨ The move must have STARTED and must not be reversing (operator rule 2026-10-29):
    //    'quiet' = flat since 09:45 with no big day move; 'fading' = against the trade since 09:45.
    const fresh = tfMoveFreshness(ctx);
    if (cfg.rejectMoveProfiles.includes(fresh.profile)) {
      if (fresh.profile === 'fading') rejected.fadingMove++;
      else rejected.quietMove++;
      continue;
    }

    candidates.push({
      symbol: runner.symbol,
      side,
      tfRFactor: runner.rFactorNow,
      tfRankNow: runner.rankNow,
      tfRankAtBaseline: runner.rankAtBaseline,
      tfClimb: runner.climb,
      deltaR: runner.deltaR,
      tfPctChange: pct,
      premValueCr: ctx.premValueCr,
      sinceEntryPct: ctx.sinceEntryPct,
      breakout: ctx.breakout === true,
      reasons: [
        `TF R-Factor ${runner.rFactorNow.toFixed(2)}, rank #${runner.rankNow} (up ${runner.climb} from #${runner.rankAtBaseline})`,
        `still accumulating: TF R +${runner.deltaR.toFixed(2)} over the last 30 min`,
        `TF has it ${pct > 0 ? 'up' : 'down'} ${Math.abs(pct).toFixed(2)}%`,
        ctx.breakout === true ? 'cleared its 30-min opening range in that direction' : 'no opening-range breakout',
        `TF breakout beacon ${ctx.tfBeacon ?? 'none'}${ctx.tfBeacon ? ' agrees' : ''}`,
        `15-min ORB: ${ctx.breakout15 == null ? 'not complete' : ctx.breakout15 ? 'cleared' : 'not cleared'} (shadow, not a gate)`,
        `options premium pool ₹${Math.round(ctx.premValueCr)} Cr`,
        ctx.sinceEntryPct == null
          ? 'move since 09:45 unrecorded'
          : `${ctx.sinceEntryPct >= 0 ? '+' : ''}${ctx.sinceEntryPct.toFixed(2)}% since 09:45 — not yet extended`,
        ctx.nseLists == null
          ? 'NSE lists not checked'
          : `in /live's lists: ${[
              ctx.nseLists.oiBuildupRank != null ? `F&O OI Build-up #${ctx.nseLists.oiBuildupRank}` : null,
              ctx.nseLists.mostActiveRank != null ? `Most Active #${ctx.nseLists.mostActiveRank}` : null,
            ]
              .filter(Boolean)
              .join(' · ') || 'none (check switched off)'}`,
        `not chasing: 09:15 candle ${ctx.stretch.firstCandle.toFixed(2)}× a normal day, ${ctx.stretch.fromPrevCloseAdr.toFixed(2)}× from yesterday's close`,
        ctx.supertrendAligned == null
          ? 'Supertrend(10,3) not formed yet (needs 12 five-min bars, ~10:15) — no veto'
          : 'Supertrend(10,3) agrees with the trade',
        `move ${fresh.profile}: ${fresh.detail}`,
      ],
    });

    if (candidates.length >= cfg.maxCandidates) break;
  }

  return { candidates, rejected, considered: runners.length };
}

/** One-line summary of the selection — what was picked, and why the rest were not. */
export function describeRejections(r: TfSelectorRejections, considered: number, picked = 0): string {
  if (considered === 0) return 'TradeFinder has no runners climbing its board right now.';
  const parts: [number, string][] = [
    [r.noBoard, 'missing quote/candle context'],
    [r.frozenR, 'R-Factor stopped climbing'],
    [r.unknownDeltaR, 'no earlier board to measure the rate against'],
    [r.flatPrice, 'not moving enough to call a direction'],
    [r.noBreakout, 'has not cleared its opening range'],
    [r.breakoutUnknown, 'no price data to check the opening range'],
    [r.noTfBeacon, 'no TF breakout beacon in that direction'],
    [r.thinPremium, 'options premium pool too thin'],
    [r.premiumUnknown, 'no options premium reading'],
    [r.moveExhausted, 'move already extended past the entry band'],
    [r.stretchUnknown, 'no daily range or opening candle to check for chasing'],
    [r.chasing, "move already made (long opening candle or 2+ normal days from yesterday's close)"],
    [r.notInNseLists, "not in /live's F&O OI Build-up or Most Active list"],
    [r.listsUnknown, "NSE's OI Build-up / Most Active lists unavailable or stale"],
    [r.supertrendAgainst, 'Supertrend(10,3) points against the trade'],
    [r.quietMove, 'flat since 09:45 — nothing has started yet'],
    [r.fadingMove, 'reversing against the trade since 09:45 (buying into the unwind)'],
  ];
  const said = parts
    .filter(([n]) => n > 0)
    .sort((a, b) => b[0] - a[0])
    .map(([n, why]) => `${n} ${why}`);
  if (said.length === 0) return `All ${considered} runners passed.`;
  // Never "none tradeable" when something WAS picked — this line feeds the
  // commentary, which would then contradict its own picks (2026-10-08 replay).
  return picked > 0
    ? `${considered} runners on TF's board, ${picked} picked; the rest: ${said.join('; ')}.`
    : `${considered} runners on TF's board, none tradeable: ${said.join('; ')}.`;
}
