/**
 * Option value at the CHART stop — PURE (no DB, broker or network import) so CI
 * proves it without a populated SQLite file.
 *
 * Why this exists (operator, 2026-10-09). The per-lot risk budget used to be
 * measured at a flat 20% premium stop. That is not where a chart trader is
 * stopped: TradeFinder exits at the previous candle's low (or the one before, or
 * the middle of a big candle, or a support level), and so does our spot plan
 * (buildSpotPlan: last completed candle, floored at MIN_RISK_PCT). Measuring the
 * budget at a premium level the trade normally never reaches refused ADANIENT
 * 2650 PE on 2026-10-08 (₹5,302 "at the 20% stop" vs ₹5,000) — a trade whose
 * chart stop sat about 1% away and risked far less.
 *
 * So the budget is now measured where the trade is actually stopped: the spot
 * stop. The option's implied volatility is solved from the ASK we would pay at
 * the current spot (Black-Scholes; NSE stock options are European-style), then
 * the same contract is priced with the stock AT the stop, at today's square-off
 * (so the hold's within-day time decay is counted). Risk per lot = (ask − that
 * value) × lot size.
 *
 * Deliberately conservative where it can be and fail-closed everywhere else:
 *  - IV is held constant. A falling stock usually lifts PUT IV and dents CALL
 *    IV, so the model is honest-to-pessimistic for calls and slightly
 *    optimistic for puts. The premium BACKSTOP (BACKSTOP_MODEL_MULT × the
 *    modelled drop, never tighter than the operator's optionStopPct) is what
 *    catches a model miss.
 *  - Dividends are ignored (immaterial over the ≤ 1-month contracts we trade).
 *  - Anything unsolvable or on the wrong side returns `{ ok: false, reason }`;
 *    callers REFUSE the entry. A risk gate never reads "cannot calculate" as
 *    "allow".
 */

/** Annual risk-free rate (approx. 91-day T-bill). The result is insensitive to
 *  it over a few weeks: ±1% moves a near-ATM price by well under 0.1%. */
export const RISK_FREE_RATE = 0.065;
/** The premium backstop sits this many times the modelled drop-at-stop below
 *  the fill, so it fires only when the option falls far faster than the chart
 *  stop explains (IV crush, a gap) — not before the chart stop does. */
export const BACKSTOP_MODEL_MULT = 1.5;
/** Hard ceiling on the backstop width (% of fill). Above this the "backstop"
 *  would be the whole premium, i.e. no backstop at all. */
export const BACKSTOP_MAX_PCT = 60;

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const IV_MIN = 0.01;
const IV_MAX = 5;

/** Standard normal CDF (Abramowitz–Stegun 7.1.26, |error| < 7.5e-8). */
export function normCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** Black-Scholes price of a European call/put. T in years. */
export function bsPrice(type: 'CE' | 'PE', S: number, K: number, T: number, r: number, sigma: number): number {
  if (T <= 0 || sigma <= 0) return Math.max(0, type === 'CE' ? S - K : K - S);
  const sq = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / sq;
  const d2 = d1 - sq;
  const df = Math.exp(-r * T);
  return type === 'CE' ? S * normCdf(d1) - K * df * normCdf(d2) : K * df * normCdf(-d2) - S * normCdf(-d1);
}

/**
 * Implied volatility by bisection (price is monotonic in sigma). A price BELOW
 * the IV_MIN model price is treated as IV_MIN — that only happens for deep
 * in-the-money quotes trading at/under intrinsic, and the lowest volatility
 * gives the LOWEST value at the stop, i.e. the larger (conservative) risk.
 * A price above the IV_MAX model price is nonsense → null.
 */
export function impliedVol(
  type: 'CE' | 'PE',
  price: number,
  S: number,
  K: number,
  T: number,
  r: number
): number | null {
  if (!(price > 0) || !(S > 0) || !(K > 0) || !(T > 0)) return null;
  if (price <= bsPrice(type, S, K, T, r, IV_MIN)) return IV_MIN;
  if (price > bsPrice(type, S, K, T, r, IV_MAX)) return null;
  let lo = IV_MIN;
  let hi = IV_MAX;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (bsPrice(type, S, K, T, r, mid) > price) hi = mid;
    else lo = mid;
    if (hi - lo < 1e-6) break;
  }
  return (lo + hi) / 2;
}

/** Epoch ms of an IST wall-clock minute on a YYYY-MM-DD date. */
export function istEpochMs(date: string, minuteOfDay: number): number {
  const hh = String(Math.floor(minuteOfDay / 60)).padStart(2, '0');
  const mm = String(minuteOfDay % 60).padStart(2, '0');
  return Date.parse(`${date}T${hh}:${mm}:00+05:30`);
}

/** NSE stock options stop trading at 15:30 IST on the expiry date. */
const EXPIRY_CLOSE_MIN = 15 * 60 + 30;

export interface SpotStopRiskInput {
  optionType: 'CE' | 'PE';
  /** The executable entry price — the ASK a market buy lifts. */
  ask: number;
  /** LIVE underlying price at the same moment as the ask. */
  spot: number;
  /** The plan's spot stop (CE: below spot, PE: above spot). */
  slSpot: number;
  strike: number;
  /** Contract expiry, YYYY-MM-DD. */
  expiryDate: string;
  lotSize: number;
  /** "Now", epoch ms — when the ask and spot were read. */
  nowMs: number;
  /** When the stop value is evaluated, epoch ms — today's square-off, so the
   *  hold's within-day time decay counts against us. Clamped to ≥ nowMs. */
  evalAtMs: number;
}

export type SpotStopRisk =
  | {
      ok: true;
      /** Rupees ONE lot loses if the stock reaches the chart stop. */
      riskPerLot: number;
      /** Modelled option value with the stock at the stop. */
      premiumAtStop: number;
      /** (ask − premiumAtStop) ÷ ask × 100. */
      dropPct: number;
      /** Annualised implied volatility solved from the ask (0.25 = 25%). */
      iv: number;
    }
  | { ok: false; reason: string };

/** What one lot loses if the stock reaches the chart stop — see file header. */
export function spotStopRiskPerLot(x: SpotStopRiskInput): SpotStopRisk {
  const nums: [string, number][] = [
    ['ask', x.ask],
    ['spot', x.spot],
    ['slSpot', x.slSpot],
    ['strike', x.strike],
    ['lotSize', x.lotSize],
    ['nowMs', x.nowMs],
    ['evalAtMs', x.evalAtMs],
  ];
  const bad = nums.filter(([, v]) => !Number.isFinite(v) || v <= 0).map(([k]) => k);
  if (bad.length > 0) return { ok: false, reason: `missing or invalid ${bad.join(', ')}` };
  // A stop already behind the price is not a plan — the position would open
  // stopped out (or the spot read is stale). Refuse rather than guess.
  if (x.optionType === 'CE' ? x.slSpot >= x.spot : x.slSpot <= x.spot) {
    return {
      ok: false,
      reason: `spot stop ${x.slSpot} is not on the losing side of the live spot ${x.spot} for a ${x.optionType}`,
    };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(x.expiryDate)) return { ok: false, reason: `invalid expiry ${x.expiryDate}` };
  const expiryMs = istEpochMs(x.expiryDate, EXPIRY_CLOSE_MIN);
  const tNow = (expiryMs - x.nowMs) / YEAR_MS;
  const tStop = (expiryMs - Math.max(x.nowMs, x.evalAtMs)) / YEAR_MS;
  if (!(tNow > 0) || !(tStop > 0))
    return { ok: false, reason: `contract expires before the hold ends (${x.expiryDate})` };
  const iv = impliedVol(x.optionType, x.ask, x.spot, x.strike, tNow, RISK_FREE_RATE);
  if (iv == null) return { ok: false, reason: `implied volatility unsolvable from the ₹${x.ask} ask` };
  const premiumAtStop = bsPrice(x.optionType, x.slSpot, x.strike, tStop, RISK_FREE_RATE, iv);
  const drop = Math.max(0, x.ask - premiumAtStop);
  return {
    ok: true,
    riskPerLot: Math.round(drop * x.lotSize),
    premiumAtStop: Math.round(premiumAtStop * 100) / 100,
    dropPct: Math.round((drop / x.ask) * 10000) / 100,
    iv: Math.round(iv * 10000) / 10000,
  };
}

/**
 * Width (% of fill) of the premium BACKSTOP for an entry whose chart stop
 * models a `dropPct` fall: never tighter than the operator's `optionStopPct`,
 * otherwise BACKSTOP_MODEL_MULT × the modelled drop (that term capped at
 * BACKSTOP_MAX_PCT — the operator's own setting is never narrowed).
 * The backstop exists for a model miss; it must not fire before the chart stop.
 */
export function backstopStopPct(optionStopPct: number, dropPct: number): number {
  const base = Number.isFinite(optionStopPct) && optionStopPct > 0 && optionStopPct < 100 ? optionStopPct : NaN;
  if (!Number.isFinite(base)) return NaN;
  const modelled = Number.isFinite(dropPct) && dropPct > 0 ? dropPct * BACKSTOP_MODEL_MULT : 0;
  return Math.round(Math.max(base, Math.min(BACKSTOP_MAX_PCT, modelled)) * 100) / 100;
}
