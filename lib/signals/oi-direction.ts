/**
 * Price + Open-Interest direction classification.
 *
 * Open interest alone is NOT directional — every contract is one long and one
 * short, so a rise in OI only says fresh positions were opened, never which side
 * is right. Direction comes from reading PRICE alongside OI (the four-quadrant
 * framework). Likewise, for an option, rising OI can be fresh buying OR fresh
 * writing — the option's PREMIUM direction separates the two.
 *
 * These are pure, I/O-free functions (trivially unit-testable) shared by the
 * data-downloader rationale, the backtest gate, and the live-urgency page.
 */

export type FuturesQuadrant = 'long-buildup' | 'short-buildup' | 'short-covering' | 'long-unwinding' | 'flat';
export type DirectionBias = 'bullish' | 'bearish' | 'neutral';

export interface FuturesOIClassification {
  quadrant: FuturesQuadrant;
  bias: DirectionBias;
  /** Buildups are conviction-strong; covering/unwinding are exits (weaker). */
  strength: 'strong' | 'weak' | 'none';
  /** Plain-English read, e.g. "long buildup (fresh longs, bullish)". */
  label: string;
}

const QUADRANT_LABEL: Record<FuturesQuadrant, string> = {
  'long-buildup': 'long buildup (fresh longs, bullish)',
  'short-buildup': 'short buildup (fresh shorts, bearish)',
  'short-covering': 'short covering (shorts exiting, bullish but weak)',
  'long-unwinding': 'long unwinding (longs exiting, bearish but weak)',
  flat: 'flat (no meaningful price/OI move)',
};

/**
 * Classify a futures price + OI move into one of the four quadrants.
 *
 * @param priceChangePct  signed % change in (futures or underlying) price
 * @param oiChangePct     signed % change in open interest
 * @param eps             dead-band in % below which a move counts as flat (default 0.1)
 */
export function classifyFuturesOI(params: {
  priceChangePct: number | null;
  oiChangePct: number | null;
  eps?: number;
}): FuturesOIClassification {
  const { priceChangePct, oiChangePct } = params;
  const eps = params.eps ?? 0.1;

  if (priceChangePct == null || oiChangePct == null) {
    return { quadrant: 'flat', bias: 'neutral', strength: 'none', label: 'insufficient data' };
  }

  const priceUp = priceChangePct > eps;
  const priceDown = priceChangePct < -eps;
  const oiUp = oiChangePct > eps;
  const oiDown = oiChangePct < -eps;

  let quadrant: FuturesQuadrant;
  let bias: DirectionBias;
  let strength: 'strong' | 'weak' | 'none';

  if (priceUp && oiUp) {
    quadrant = 'long-buildup';
    bias = 'bullish';
    strength = 'strong';
  } else if (priceDown && oiUp) {
    quadrant = 'short-buildup';
    bias = 'bearish';
    strength = 'strong';
  } else if (priceUp && oiDown) {
    quadrant = 'short-covering';
    bias = 'bullish';
    strength = 'weak';
  } else if (priceDown && oiDown) {
    quadrant = 'long-unwinding';
    bias = 'bearish';
    strength = 'weak';
  } else {
    quadrant = 'flat';
    bias = 'neutral';
    strength = 'none';
  }

  return { quadrant, bias, strength, label: QUADRANT_LABEL[quadrant] };
}

export type OptionFlow = 'fresh-buying' | 'fresh-writing' | 'writers-covering' | 'buyers-exiting' | 'flat';
/** 'demand' = buyers paying up (directional); 'supply' = writers (cap/floor). */
export type OptionSide = 'demand' | 'supply' | 'neutral';

export interface OptionFlowClassification {
  flow: OptionFlow;
  side: OptionSide;
  label: string;
}

/**
 * Separate fresh option BUYING from fresh option WRITING using OI + premium.
 *
 * Rising OI alone is ambiguous: it can be buyers opening longs (demand) or
 * writers opening shorts (supply). Premium direction breaks the tie — fresh
 * positions where premium RISES are demand-led (buyers paying up); where premium
 * FALLS they are supply-led (writers pressing). For a CE, heavy writing marks
 * RESISTANCE; for a PE, heavy writing marks SUPPORT.
 *
 * @param optionType  'CE' | 'PE' — only used to phrase the resistance/support label
 */
export function classifyOptionFlow(params: {
  premiumChangePct: number | null;
  oiChangePct: number | null;
  optionType: 'CE' | 'PE';
  eps?: number;
}): OptionFlowClassification {
  const { premiumChangePct, oiChangePct, optionType } = params;
  const eps = params.eps ?? 0.1;

  if (premiumChangePct == null || oiChangePct == null) {
    return { flow: 'flat', side: 'neutral', label: 'insufficient data' };
  }

  const premUp = premiumChangePct > eps;
  const premDown = premiumChangePct < -eps;
  const oiUp = oiChangePct > eps;
  const oiDown = oiChangePct < -eps;

  // Where heavy writing sits: a written CE caps upside (resistance); a written
  // PE props up downside (support).
  const writeLevel = optionType === 'CE' ? 'resistance' : 'support';

  if (oiUp && premUp) {
    return { flow: 'fresh-buying', side: 'demand', label: 'fresh buying (premium bid up — demand)' };
  }
  if (oiUp && premDown) {
    return { flow: 'fresh-writing', side: 'supply', label: `fresh writing (premium sold down — ${writeLevel})` };
  }
  if (oiDown && premUp) {
    return { flow: 'writers-covering', side: 'neutral', label: 'writers covering (OI falling, premium up)' };
  }
  if (oiDown && premDown) {
    return { flow: 'buyers-exiting', side: 'neutral', label: 'buyers exiting (OI and premium falling)' };
  }
  return { flow: 'flat', side: 'neutral', label: 'flat (no meaningful OI/premium move)' };
}

/**
 * Reconcile a data-derived futures bias with the direction implied by the trade's
 * option type (CE = bullish bet, PE = bearish bet). Surfaces a conflict when the
 * positioning data points the opposite way to the trade that was actually taken.
 */
export function reconcileWithLabel(
  futBias: DirectionBias,
  optionType: 'CE' | 'PE',
): { agree: boolean; note: string } {
  if (futBias === 'neutral') {
    return { agree: true, note: 'futures positioning is flat — neither confirms nor contradicts' };
  }
  const labelBias: DirectionBias = optionType === 'CE' ? 'bullish' : 'bearish';
  if (futBias === labelBias) {
    return { agree: true, note: `futures positioning (${futBias}) agrees with the ${optionType} direction` };
  }
  return {
    agree: false,
    note: `futures positioning is ${futBias}, opposite the ${optionType} (${labelBias}) trade`,
  };
}
