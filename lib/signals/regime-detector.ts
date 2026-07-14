/**
 * Market regime detector — classifies the current market state into
 * volatility, trend, and momentum regimes using indicators we already
 * compute. No external dependencies, no ML, runs in milliseconds.
 *
 * Used by the trade-suggest engine to dynamically adjust confidence
 * thresholds: lower bar in high-conviction regimes, higher bar in
 * uncertain ones.
 *
 * Three dimensions:
 *   1. Volatility: current ATR(14) vs 20-bar ATR average
 *   2. Trend: Supertrend direction + bars since last flip (stability)
 *   3. Momentum: price vs VWAP + ATR expansion (momentum building/fading)
 *
 * Each dimension returns a simple label; the composite regime is the
 * combination. The suggest engine reads regime.confidenceMultiplier to
 * scale the R-Factor confidence threshold.
 */

import { atr, supertrend, sessionVwap, type IndicatorBar } from './indicators';

export type VolatilityRegime = 'high' | 'normal' | 'low';
export type TrendRegime = 'trending' | 'transitional' | 'ranging';
export type MomentumRegime = 'building' | 'fading' | 'neutral';

export interface MarketRegime {
  volatility: VolatilityRegime;
  trend: TrendRegime;
  momentum: MomentumRegime;
  /** Multiplier for the R-Factor confidence threshold.
   *  <1 = relax gates (good regime, catch more setups),
   *  >1 = tighten gates (bad regime, be selective). */
  confidenceMultiplier: number;
  /** Human-readable label for logging/commentary. */
  label: string;
}

/**
 * Detect the current market regime from 5-min bars.
 * Pure function — no I/O, no side effects.
 */
export function detectRegime(bars: IndicatorBar[]): MarketRegime {
  // Default regime when not enough data
  if (bars.length < 30) {
    return {
      volatility: 'normal',
      trend: 'ranging',
      momentum: 'neutral',
      confidenceMultiplier: 1.0,
      label: 'insufficient data — defaulting to neutral',
    };
  }

  // ── Volatility regime ──────────────────────────────────────────────────
  const currentAtr = atr(bars, 14);
  // Compare to a longer ATR window (approx 20 bars back = 100 min)
  const earlyBars = bars.slice(0, Math.max(15, bars.length - 20));
  const baselineAtr = atr(earlyBars, 14);

  let volatility: VolatilityRegime = 'normal';
  if (currentAtr != null && baselineAtr != null && baselineAtr > 0) {
    const ratio = currentAtr / baselineAtr;
    if (ratio > 1.5) volatility = 'high';
    else if (ratio < 0.6) volatility = 'low';
  }

  // ── Trend regime ───────────────────────────────────────────────────────
  const st = supertrend(bars);
  let trend: TrendRegime = 'ranging';
  if (st != null) {
    if (st.barsInTrend >= 10) {
      // Stable trend — Supertrend hasn't flipped for 10+ bars (50 min)
      trend = 'trending';
    } else if (st.barsInTrend >= 4) {
      trend = 'transitional';
    }
    // else: recently flipped = ranging / choppy
  }

  // ── Momentum regime ────────────────────────────────────────────────────
  const vw = sessionVwap(bars);
  const last = bars[bars.length - 1];
  let momentum: MomentumRegime = 'neutral';
  if (vw != null && currentAtr != null) {
    const priceVsVwap = (last.close - vw) / vw;
    // Check ATR expansion: is current ATR growing vs 5 bars ago?
    const recentAtr = atr(bars.slice(-20), 14);
    const earlierAtr = atr(bars.slice(-30, -10), 14);
    const atrExpanding = recentAtr != null && earlierAtr != null && recentAtr > earlierAtr * 1.1;

    if (Math.abs(priceVsVwap) > 0.003 && atrExpanding) {
      // Price away from VWAP + ATR expanding = momentum building
      momentum = 'building';
    } else if (Math.abs(priceVsVwap) < 0.001 && !atrExpanding) {
      // Price near VWAP + ATR contracting = momentum fading
      momentum = 'fading';
    }
  }

  // ── Composite confidence multiplier ────────────────────────────────────
  // Each dimension adjusts the threshold:
  //   High vol + trending + building momentum → 0.7 (relax, good regime)
  //   Low vol + ranging + fading momentum → 1.3 (tighten, bad regime)
  let multiplier = 1.0;

  // Volatility: high vol means bigger moves → slightly relax for opportunities
  if (volatility === 'high') multiplier -= 0.1;
  else if (volatility === 'low') multiplier += 0.1;

  // Trend: trending market is the best environment for momentum entries
  if (trend === 'trending') multiplier -= 0.15;
  else if (trend === 'ranging') multiplier += 0.15;

  // Momentum: building momentum confirms the move
  if (momentum === 'building') multiplier -= 0.1;
  else if (momentum === 'fading') multiplier += 0.1;

  // Clamp to [0.6, 1.4] — never relax more than 40% or tighten more than 40%
  multiplier = Math.max(0.6, Math.min(1.4, multiplier));

  const label = `${volatility} vol, ${trend}, ${momentum} momentum`;

  return { volatility, trend, momentum, confidenceMultiplier: multiplier, label };
}