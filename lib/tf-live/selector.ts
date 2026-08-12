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
 * Direction therefore comes from TF's own % change and must be CONFIRMED by
 * Supertrend. Measured: adding Supertrend took +0.075R → +0.227R. VWAP was
 * tested and REJECTED — it diluted every variant it was added to
 * (Supertrend alone +0.227R vs Supertrend+VWAP +0.187R).
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

/** Per-symbol evidence the selector needs but cannot derive from the TF board. */
export interface TfSymbolContext {
  /** True when Supertrend(10,3) points the same way as the proposed side.
   *  Null = not yet computable (too few candles) → REJECTED, never assumed. */
  supertrendAligned: boolean | null;
  /** True when price has cleared the opening range in the trade's direction.
   *  Null = opening range not complete yet → REJECTED. */
  breakout: boolean | null;
  /** NSE options premium pool traded today (₹ Cr) — the tradeability read.
   *  Null = the name was not on a /live watchlist, so we have no evidence. */
  premValueCr: number | null;
  /** Direction-aware price change since 09:45 IST (%), positive = moving our
   *  way. Null before 09:45 / when unrecorded. */
  sinceEntryPct: number | null;
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
  supertrendDisagrees: number;
  supertrendUnknown: number;
  noBreakout: number;
  thinPremium: number;
  premiumUnknown: number;
  moveExhausted: number;
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
  supertrendDisagrees: 0,
  supertrendUnknown: 0,
  noBreakout: 0,
  thinPremium: 0,
  premiumUnknown: 0,
  moveExhausted: 0,
});

/**
 * Defaults measured over 2026-08-10..12. TREAT AS FITTED — roughly 100 variants
 * were tried on three sessions, so these thresholds are the least trustworthy
 * part of this module. The DIRECTION of each (higher R, still climbing, trend
 * agreeing, real premium pool) held in every cut; the exact numbers did not get
 * a chance to. `minPremValueCr` sits at the top of the tested ₹6–20 Cr plateau
 * and should be the first constant re-checked as live sessions accumulate.
 */
export const DEFAULT_TF_SELECTOR_CONFIG: TfSelectorConfig = {
  minDeltaR: 0.05,
  minAbsPctChange: 0.3,
  minPremValueCr: 20,
  maxSinceEntryPct: 2,
  requireBreakout: true,
  maxCandidates: 7,
};

/**
 * Filter and rank race runners into tradeable candidates.
 *
 * `runners` must already be ordered by TF R-Factor desc (as `raceAtMinute`
 * returns them); the output preserves that order, so the caller's "take the
 * best N" is TF's own ranking rather than a re-derived one.
 *
 * MISSING EVIDENCE IS ALWAYS A REJECTION. A null Supertrend, a null breakout, a
 * null premium pool — each drops the name. This module never treats "we could
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

    // ③ Trend confirmation.
    if (ctx?.supertrendAligned == null) {
      rejected.supertrendUnknown++;
      continue;
    }
    if (!ctx.supertrendAligned) {
      rejected.supertrendDisagrees++;
      continue;
    }

    // ④ Breakout.
    if (cfg.requireBreakout && ctx.breakout !== true) {
      rejected.noBreakout++;
      continue;
    }

    // ⑤ Tradeability: a real options premium pool to trade against.
    if (ctx.premValueCr == null) {
      rejected.premiumUnknown++;
      continue;
    }
    if (ctx.premValueCr < cfg.minPremValueCr) {
      rejected.thinPremium++;
      continue;
    }

    // ⑥ Do not chase. FORTIS 2026-08-12 is the case: entries at −3.82% and
    //    −4.02% hit target, entries at −4.78% and −5.34% stopped — same name,
    //    same day, same direction. A null reading is NOT a rejection here: it
    //    only means the 09:45 bar was unrecorded, and the other five gates have
    //    already established the setup.
    if (ctx.sinceEntryPct != null && ctx.sinceEntryPct >= cfg.maxSinceEntryPct) {
      rejected.moveExhausted++;
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
        `TF has it ${pct > 0 ? 'up' : 'down'} ${Math.abs(pct).toFixed(2)}% — Supertrend agrees`,
        ctx.breakout === true ? 'cleared its opening range in that direction' : 'no opening-range breakout',
        `options premium pool ₹${Math.round(ctx.premValueCr)} Cr`,
        ctx.sinceEntryPct == null
          ? 'move since 09:45 unrecorded'
          : `${ctx.sinceEntryPct >= 0 ? '+' : ''}${ctx.sinceEntryPct.toFixed(2)}% since 09:45 — not yet extended`,
      ],
    });

    if (candidates.length >= cfg.maxCandidates) break;
  }

  return { candidates, rejected, considered: runners.length };
}

/** One-line summary of why nothing survived — for the UI's empty state. */
export function describeRejections(r: TfSelectorRejections, considered: number): string {
  if (considered === 0) return 'TradeFinder has no runners climbing its board right now.';
  const parts: [number, string][] = [
    [r.frozenR, 'R-Factor stopped climbing'],
    [r.unknownDeltaR, 'no earlier board to measure the rate against'],
    [r.flatPrice, 'not moving enough to call a direction'],
    [r.supertrendDisagrees, 'Supertrend disagrees with the move'],
    [r.supertrendUnknown, 'too few candles for Supertrend'],
    [r.noBreakout, 'has not cleared its opening range'],
    [r.thinPremium, 'options premium pool too thin'],
    [r.premiumUnknown, 'no options premium reading'],
    [r.moveExhausted, 'move already extended past the entry band'],
  ];
  const said = parts
    .filter(([n]) => n > 0)
    .sort((a, b) => b[0] - a[0])
    .map(([n, why]) => `${n} ${why}`);
  return said.length === 0
    ? `All ${considered} runners passed.`
    : `${considered} runners on TF's board, none tradeable: ${said.join('; ')}.`;
}
