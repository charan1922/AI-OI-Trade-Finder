/**
 * R-Factor library — majority direction vote.
 *
 *  • majoritySignal — net buy/sell read across the directional factors.
 *
 * Each voting factor counts by its blend weight × its strength, so a strong,
 * heavily-weighted factor outweighs a weak one. Neutral / unavailable factors are
 * ignored. Confidence is the margin of victory, in [0,1].
 */

import type { FactorScore, RFactorWeights, Vote } from './types';

export interface MajorityResult {
  bias: Vote;
  /** Margin of the winning side over the total directional weight, [0,1]. */
  confidence: number;
  buyWeight: number;
  sellWeight: number;
}

/** #8 Majority indicators — weighted buy-vs-sell vote across the factors. */
export function majoritySignal(factors: FactorScore[], weights: RFactorWeights): MajorityResult {
  let buyWeight = 0;
  let sellWeight = 0;
  for (const f of factors) {
    if (!f.available || f.vote === 'neutral') continue;
    const w = (weights[f.key] ?? 0) * f.score;
    if (f.vote === 'buy') buyWeight += w;
    else sellWeight += w;
  }
  const total = buyWeight + sellWeight;
  if (total <= 0) return { bias: 'neutral', confidence: 0, buyWeight, sellWeight };
  const bias: Vote = buyWeight > sellWeight ? 'buy' : sellWeight > buyWeight ? 'sell' : 'neutral';
  return { bias, confidence: Math.abs(buyWeight - sellWeight) / total, buyWeight, sellWeight };
}
