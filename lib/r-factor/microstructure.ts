/**
 * R-Factor library — order-book microstructure.
 *
 *  • bidAskSpreadSignal — tightness of the live bid-ask spread (liquidity / quality)
 *
 * A tight spread means the name is liquid and cheap to execute — quality real
 * traders are active. A wide spread is illiquid / low-conviction. This is a
 * non-directional quality factor (vote stays neutral).
 */

import { clamp, isPos, round } from './math';
import type { FactorScore } from './types';

/** Spread at or beyond this % of mid scores 0 (illiquid); 0% scores 1 (perfectly tight). */
const SPREAD_CAP_PCT = 0.3;

/** #6 Bid-ask spread — narrower is better (more liquid, lower execution cost). */
export function bidAskSpreadSignal(bid?: number, ask?: number): FactorScore {
  const base = { key: 'bidAskSpread' as const, label: 'Bid-ask spread (liquidity)' };
  if (!isPos(bid) || !isPos(ask) || ask < bid) {
    return { ...base, score: 0, vote: 'neutral', available: false, detail: 'no valid two-sided quote' };
  }
  const mid = (bid + ask) / 2;
  const spreadPct = ((ask - bid) / mid) * 100;
  const score = clamp(1 - spreadPct / SPREAD_CAP_PCT, 0, 1);
  const liquidity = score > 0.66 ? 'tight / liquid' : score > 0.33 ? 'moderate' : 'wide / illiquid';
  return { ...base, score, vote: 'neutral', available: true, detail: `spread ${round(spreadPct, 3)}% of mid (${liquidity})` };
}
