/**
 * What the /live TF Climbers cockpit shows per name — pure, so CI can pin it.
 * Spec: docs/superpowers/specs/2026-10-08-tf-climbers-cockpit-design.md.
 *
 * gateStrip() mirrors selectTfCandidates() check for check: all six true ⇔ the
 * selector picks the name (verify-tf-selector.ts proves it), so the card can
 * never disagree with the auto-trader. Missing evidence is null (grey), never true.
 */
import type { TfBoardAt } from '@/lib/tf-live/race';
import type { TfSelectorConfig, TfSymbolContext } from '@/lib/tf-live/selector';

export type Gate = boolean | null;

export interface GateStrip {
  climbing: Gate;
  moving: Gate;
  orb: Gate;
  beacon: Gate;
  pool: Gate;
  notExtended: Gate;
}

/** The selector's own order. */
export const GATE_ORDER = ['climbing', 'moving', 'orb', 'beacon', 'pool', 'notExtended'] as const;

export const GATE_LABEL: Record<keyof GateStrip, string> = {
  climbing: 'climbing',
  moving: 'moving',
  orb: 'our ORB',
  beacon: 'TF beacon',
  pool: 'options pool',
  notExtended: 'not extended',
};

export function gateStrip(
  deltaR: number | null,
  pctChange: number | null,
  ctx: TfSymbolContext | undefined,
  cfg: TfSelectorConfig
): GateStrip {
  const side = pctChange == null ? null : pctChange > 0 ? 'CE' : 'PE';
  return {
    climbing: deltaR == null ? null : deltaR > cfg.minDeltaR,
    moving: pctChange == null ? null : Math.abs(pctChange) >= cfg.minAbsPctChange,
    orb: !cfg.requireBreakout ? true : ctx?.breakout == null ? null : ctx.breakout,
    // TF not flagging a name is an answer ("no beacon"), not missing data.
    beacon: !cfg.requireTfBeacon
      ? true
      : ctx == null || side == null
        ? null
        : ctx.tfBeacon === (side === 'CE' ? 'BULL' : 'BEAR'),
    pool: ctx?.premValueCr == null ? null : ctx.premValueCr >= cfg.minPremValueCr,
    // The selector passes an unrecorded 09:45 bar (selector.ts ⑤) — so does the strip,
    // but only when there is context at all.
    notExtended: ctx == null ? null : ctx.sinceEntryPct == null ? true : ctx.sinceEntryPct < cfg.maxSinceEntryPct,
  };
}

export const allPass = (g: GateStrip): boolean => GATE_ORDER.every((k) => g[k] === true);
export const passedCount = (g: GateStrip): number => GATE_ORDER.filter((k) => g[k] === true).length;

/** Plain English for the first check that is not passed, or null. Read as "needs: …". */
export function firstNeed(g: GateStrip, ctx: TfSymbolContext | undefined, cfg: TfSelectorConfig): string | null {
  for (const k of GATE_ORDER) {
    if (g[k] === true) continue;
    const missing = g[k] == null;
    switch (k) {
      case 'climbing':
        return missing
          ? 'an earlier board to measure the 30-min rate'
          : 'R-Factor to resume climbing (flat over 30 min)';
      case 'moving':
        return missing ? 'a % change from TF' : `a move of at least ${cfg.minAbsPctChange}% to set the side`;
      case 'orb':
        return missing ? 'the 15-min opening range (complete at 09:30)' : 'our 15-min opening-range breakout';
      case 'beacon':
        return missing ? 'TF breakout beacon data' : 'TF breakout beacon in the trade direction';
      case 'pool':
        return missing
          ? 'an options premium reading'
          : `options pool of ₹${cfg.minPremValueCr} Cr (has ₹${Math.round(ctx?.premValueCr ?? 0)} Cr)`;
      case 'notExtended':
        return missing
          ? 'recorded price data'
          : `a pullback — ${(ctx?.sinceEntryPct ?? 0).toFixed(1)}% extended since 09:45 (max ${cfg.maxSinceEntryPct}%)`;
    }
  }
  return null;
}

/** TF R-Factor on the last board at or before `minute`; null when none / not listed. */
function rAt(boards: TfBoardAt[], symbol: string, minute: number): number | null {
  for (let i = boards.length - 1; i >= 0; i--) {
    if (boards[i].minuteIST <= minute) return boards[i].rFactor.get(symbol) ?? null;
  }
  return null;
}

/** Is the money arriving faster or slower? Gain over the last 15 min vs the 15 before. */
export function rTrend(
  boards: TfBoardAt[],
  symbol: string,
  asOfMin: number,
  band = 0.02
): 'faster' | 'slower' | 'steady' | null {
  const now = rAt(boards, symbol, asOfMin);
  const m15 = rAt(boards, symbol, asOfMin - 15);
  const m30 = rAt(boards, symbol, asOfMin - 30);
  if (now == null || m15 == null || m30 == null) return null;
  const diff = now - m15 - (m15 - m30);
  return diff > band ? 'faster' : diff < -band ? 'slower' : 'steady';
}

/** First board minute of the CURRENT unbroken run of 30-min gains above `minDeltaR`. */
export function climbingSince(
  boards: TfBoardAt[],
  symbol: string,
  asOfMin: number,
  minDeltaR: number,
  lookbackMin = 30
): number | null {
  const upTo = boards.filter((b) => b.minuteIST <= asOfMin);
  let since: number | null = null;
  for (let i = upTo.length - 1; i >= 0; i--) {
    const r = upTo[i].rFactor.get(symbol);
    const ago = rAt(upTo, symbol, upTo[i].minuteIST - lookbackMin);
    if (r == null || ago == null || r - ago <= minDeltaR) break;
    since = upTo[i].minuteIST;
  }
  return since;
}

/** TF R-Factor at every board in [fromMin, asOfMin] — the card's sparkline. */
export function rPath(
  boards: TfBoardAt[],
  symbol: string,
  fromMin: number,
  asOfMin: number
): { minute: number; r: number }[] {
  const out: { minute: number; r: number }[] = [];
  for (const b of boards) {
    if (b.minuteIST < fromMin || b.minuteIST > asOfMin) continue;
    const r = b.rFactor.get(symbol);
    if (r != null) out.push({ minute: b.minuteIST, r });
  }
  return out;
}

export interface DroppedClimber {
  symbol: string;
  /** First and last board minute it was climbing inside the top N. */
  from: number;
  to: number;
  /** Where it is now; null = no longer on the board at all (left Intraday Boost). */
  rankNow: number | null;
  rNow: number | null;
  deltaRNow: number | null;
}

/** Names that climbed inside the top N earlier today but are off the top N now —
 *  kept visible (operator, 2026-10-08), most recent drop first. */
export function droppedClimbers(
  boards: TfBoardAt[],
  opts: {
    asOfMin: number;
    fromMin: number;
    topN: number;
    minDeltaR: number;
    lookbackMin?: number;
    onBoardNow: ReadonlySet<string>;
  }
): DroppedClimber[] {
  const lookback = opts.lookbackMin ?? 30;
  const inRange = boards.filter((b) => b.minuteIST >= opts.fromMin && b.minuteIST <= opts.asOfMin);
  const spans = new Map<string, { from: number; to: number }>();
  for (const b of inRange) {
    for (const [symbol, rank] of b.rank) {
      if (rank > opts.topN || opts.onBoardNow.has(symbol)) continue;
      const r = b.rFactor.get(symbol);
      const ago = rAt(boards, symbol, b.minuteIST - lookback);
      if (r == null || ago == null || r - ago <= opts.minDeltaR) continue;
      const span = spans.get(symbol);
      spans.set(symbol, span ? { from: span.from, to: b.minuteIST } : { from: b.minuteIST, to: b.minuteIST });
    }
  }
  const now = inRange.at(-1);
  return [...spans]
    .map(([symbol, s]) => {
      const rNow = now?.rFactor.get(symbol) ?? null;
      const ago = rAt(boards, symbol, opts.asOfMin - lookback);
      return {
        symbol,
        from: s.from,
        to: s.to,
        rankNow: now?.rank.get(symbol) ?? null,
        rNow,
        deltaRNow: rNow == null || ago == null ? null : rNow - ago,
      };
    })
    .sort((a, b) => b.to - a.to);
}

/** Broad baskets are not sectors. Compared upper-case: TF writes "NiFTY 50". */
const BROAD_BASKETS = new Set(['NIFTY 50', 'SENSEX', 'NIFTY MID SELECT', 'OTHERS']);

/** The stock's first industry basket (TF's order) that has a TF sector value. */
export function pickSector(
  baskets: string[],
  values: ReadonlyMap<string, number>
): { name: string; value: number } | null {
  for (const name of baskets) {
    if (BROAD_BASKETS.has(name.toUpperCase())) continue;
    const value = values.get(name);
    if (value != null) return { name, value };
  }
  return null;
}
