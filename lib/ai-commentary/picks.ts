/**
 * Structured pick summary stored WITH each commentary so the page can render the
 * same pill/badge design as /trade-suggest (R-Factor, Supertrend ⚠, VWAP, sector,
 * OI…) alongside MiMo's narration. Mirrors the chip vocabulary of that page's
 * PickCard, kept here so the MiMo feature stays self-contained (no import from
 * the trade-suggest page). Pure data — no React.
 */
import type { SuggestResponse } from '@/lib/trade-suggest/types';
import type { DecisionOpenPosition } from '@/lib/auto-trade/decision/context-policy';
import { rFactorAtRaw } from '@/lib/r-factor/scale';

export type ChipTone = 'good' | 'warn' | 'info';
export interface Chip {
  label: string;
  value: string;
  tone: ChipTone;
}
export interface StoredPick {
  /** Absent on legacy rows; those are scanner candidates. */
  kind?: 'candidate' | 'position';
  symbol: string;
  side: string; // CE / PE
  strike: number | null;
  expiry: string | null;
  lot: number | null;
  direction: 'bullish' | 'bearish';
  score: number;
  changePctOpen: number | null;
  extended: boolean;
  // Plan (spot-level) + premium — the "suggestion" shown under the stock.
  entrySpot: number | null;
  slSpot: number | null;
  targetSpot: number | null;
  slBasis: string;
  premium: number | null;
  perLotCost: number | null;
  chips: Chip[];
}

const fmt = (v: number | null | undefined, d = 2) => (v == null ? '—' : v.toFixed(d));

/** Build the pill rows for each suggestion (mirrors trade-suggest PickCard chips). */
export function buildPicks(result: SuggestResponse): StoredPick[] {
  return (result.suggestions ?? []).map((p) => {
    const f = p.factors;
    const bull = p.direction === 'bullish';
    const chips: Chip[] = [
      { label: 'R-Factor', value: p.rFactor.toFixed(2), tone: p.rFactor >= rFactorAtRaw(0.375) ? 'good' : 'warn' },
      { label: 'Fut OI', value: `${fmt(p.oiLevel)}×`, tone: p.oiLevel >= 1.1 ? 'good' : 'info' },
    ];
    if (f?.nseOiPct != null)
      chips.push({ label: 'NSE OI Δ', value: `${f.nseOiPct >= 0 ? '+' : ''}${f.nseOiPct.toFixed(1)}%`, tone: f.nseOiPct >= 5 ? 'good' : 'info' });
    if (f?.combinedOiLevel != null)
      chips.push({ label: 'Comb OI', value: `${f.combinedOiLevel.toFixed(2)}×`, tone: f.combinedOiLevel >= 1.1 ? 'good' : 'info' });
    if (f?.combinedOiSlope30m != null)
      chips.push({
        label: 'OI 30m',
        value: `${f.combinedOiSlope30m >= 0 ? '+' : ''}${f.combinedOiSlope30m.toFixed(1)}`,
        tone: f.combinedOiSlope30m >= 0 ? 'good' : 'warn', // negative = unwinding
      });
    if (f?.eqTurnoverRatio != null)
      chips.push({ label: 'EQ Turn', value: `${f.eqTurnoverRatio.toFixed(1)}×`, tone: f.eqTurnoverRatio >= 3 ? 'good' : 'info' });
    chips.push({ label: 'OR', value: p.orBreakout ? 'breakout' : 'inside', tone: p.orBreakout ? 'good' : 'info' });
    if (p.tfBreakout != null && p.tfBreakout.grade !== 'none') {
      const b = p.tfBreakout;
      // e.g. "strong 2L ↑" / "fakeout? 1L ↓" — the TF 3-check verdict at a glance.
      const label = b.grade === 'fakeout-risk' ? 'fakeout?' : b.grade;
      const arrow = b.direction === 'bullish' ? ' ↑' : b.direction === 'bearish' ? ' ↓' : '';
      chips.push({
        label: 'TF BO',
        value: `${label}${b.levelsCleared > 0 ? ` ${b.levelsCleared}L` : ''}${arrow}`,
        tone: b.grade === 'strong' || b.grade === 'confirmed' ? 'good' : b.grade === 'fakeout-risk' ? 'warn' : 'info',
      });
    }
    if (f?.supertrend != null)
      chips.push({
        label: 'Supertrend',
        value: `${f.supertrend === 'up' ? '↑' : '↓'} ${fmt(f.supertrendLine)}`,
        tone: f.supertrendAligned ? 'good' : 'warn',
      });
    if (f?.vwap != null) chips.push({ label: 'VWAP', value: fmt(f.vwap), tone: f.vwapAligned ? 'good' : 'warn' });
    if (f?.sectorAligned != null && f?.sectorPct != null)
      chips.push({
        label: 'Sector',
        value: `${f.sectorPct >= 0 ? '+' : ''}${f.sectorPct.toFixed(2)}%`,
        tone: f.sectorAligned ? 'good' : 'warn',
      });
    if (f?.atrPct != null) chips.push({ label: 'ATR', value: `${f.atrPct.toFixed(2)}%`, tone: 'info' });
    if (p.spreadPct != null) chips.push({ label: 'Spread', value: `${fmt(p.spreadPct, 3)}%`, tone: p.spreadPct <= 0.15 ? 'good' : 'info' });
    if (p.extended) chips.push({ label: 'Extended', value: `+${bull ? '' : '-'}chase`, tone: 'warn' });
    if (f?.onOiSpurtList) chips.push({ label: 'OI list', value: 'yes', tone: 'good' });

    return {
      kind: 'candidate',
      symbol: p.symbol,
      side: p.option?.optionType ?? (bull ? 'CE' : 'PE'),
      strike: p.option?.strike ?? null,
      expiry: p.option?.expiryDate ?? null,
      lot: p.option?.lotSize ?? null,
      direction: p.direction,
      score: p.score,
      changePctOpen: p.changePctOpen,
      extended: p.extended,
      entrySpot: p.plan.entrySpot,
      slSpot: p.plan.slSpot,
      targetSpot: p.plan.targetSpot,
      slBasis: p.plan.slBasis,
      premium: p.option?.premium?.ltp ?? null,
      perLotCost: p.option?.premium?.perLotCost ?? null,
      chips,
    };
  });
}

/**
 * Management-only audit cards come from the exact openPositions supplied to
 * the model, never from a fresh scanner contract or its original plan.
 */
export function buildOpenPositionPicks(openPositions: readonly DecisionOpenPosition[]): StoredPick[] {
  return openPositions.map((position) => {
    const chips: Chip[] = [];
    if (position.entryFillPremium != null) {
      chips.push({ label: 'Fill', value: `₹${fmt(position.entryFillPremium)}`, tone: 'info' });
    }
    if (position.liveBid != null) chips.push({ label: 'Bid', value: `₹${fmt(position.liveBid)}`, tone: 'info' });
    if (position.liveAsk != null) chips.push({ label: 'Ask', value: `₹${fmt(position.liveAsk)}`, tone: 'info' });
    if (position.liveSpreadPct != null) {
      chips.push({
        label: 'Spread',
        value: `${fmt(position.liveSpreadPct)}%`,
        tone: position.liveSpreadPct <= 3 ? 'good' : 'warn',
      });
    }
    return {
      kind: 'position',
      symbol: position.symbol,
      side: position.optionType,
      strike: position.strike,
      expiry: position.expiryDate,
      lot: position.lotSize,
      direction: position.direction,
      score: 0,
      changePctOpen: null,
      extended: false,
      entrySpot: position.entrySpot,
      slSpot: position.slSpot,
      targetSpot: position.targetSpot,
      slBasis: 'current',
      premium: position.livePremium,
      perLotCost: null,
      chips,
    };
  });
}
