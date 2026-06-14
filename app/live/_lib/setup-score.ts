import type { LiveUrgencyRow } from './types';

export type SetupLevel = 'strong' | 'watch' | 'quiet' | 'illiquid';

export interface SetupVerdict {
  level: SetupLevel;
  bias: 'bullish' | 'bearish' | 'neutral';
  /** Plain-English reasons behind the verdict (shown in the tooltip). */
  reasons: string[];
  /** Higher = more actionable. Used to sort the scanner. */
  rank: number;
  /** Already moved a lot today — late to chase. A caution flag, shown separately. */
  extended: boolean;
}

const SPREAD_TRADEABLE = 0.3; // % — above this the name is too costly to trade
const BID_HEAVY = 0.55;
const ASK_HEAVY = 0.45;
const CONVICTION = 1.25; // OI ÷ 20d avg
const EXTENDED_MOVE = 3; // |Chg% since open| beyond which the move is "already made"

/**
 * Combine the live signals into one at-a-glance verdict, in the same order a
 * trader reads the page: liquidity gate → direction (price + imbalance aligned)
 * → conviction (OI level). Pure + deterministic so it can be sorted and tested.
 *
 *  - illiquid : spread too wide / no book — skip, execution would bleed
 *  - strong   : liquid AND price+book aligned AND heavy positioning
 *  - watch    : liquid AND (aligned OR heavy positioning) — one leg short
 *  - quiet    : liquid but nothing is pulling it
 */
export function setupScore(r: LiveUrgencyRow): SetupVerdict {
  const extended = r.changePctOpen != null && Math.abs(r.changePctOpen) >= EXTENDED_MOVE;

  if (r.spreadPct == null || r.spreadPct > SPREAD_TRADEABLE) {
    return {
      level: 'illiquid',
      bias: 'neutral',
      reasons: [r.spreadPct == null ? 'no order book' : `spread ${r.spreadPct.toFixed(2)}% — too wide to trade cleanly`],
      rank: 0,
      extended,
    };
  }

  const reasons: string[] = [`liquid (spread ${r.spreadPct.toFixed(3)}%)`];

  // Direction: price move since open must agree with the resting-book pressure.
  let bias: SetupVerdict['bias'] = 'neutral';
  let aligned = false;
  const chg = r.changePctOpen;
  const imb = r.imbalance;
  if (chg != null && imb != null) {
    if (chg > 0 && imb > BID_HEAVY) {
      bias = 'bullish';
      aligned = true;
      reasons.push('price up + bid-heavy book (demand)');
    } else if (chg < 0 && imb < ASK_HEAVY) {
      bias = 'bearish';
      aligned = true;
      reasons.push('price down + ask-heavy book (supply)');
    } else {
      reasons.push('price & book not aligned');
    }
  } else {
    reasons.push('direction unavailable');
  }

  const conviction = (r.oiLevel ?? 0) >= CONVICTION;
  reasons.push(
    r.oiLevel == null
      ? 'OI level unknown (no baseline)'
      : conviction
        ? `OI ${r.oiLevel.toFixed(2)}× avg — heavy positioning`
        : `OI ${r.oiLevel.toFixed(2)}× avg — near normal`,
  );

  if (extended) reasons.push(`already moved ${r.changePctOpen! >= 0 ? '+' : ''}${r.changePctOpen!.toFixed(1)}% today — late to chase`);

  let level: SetupLevel;
  if (aligned && conviction) level = 'strong';
  else if (aligned || conviction) level = 'watch';
  else level = 'quiet';

  return { level, bias, reasons, rank: level === 'strong' ? 3 : level === 'watch' ? 2 : 1, extended };
}
