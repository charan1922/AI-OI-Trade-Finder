/** Shared types for Option Chain — safe to import in client components */

export interface StrikeData {
  strike: number;
  ce: OptionSideData | null;
  pe: OptionSideData | null;
}

export interface OptionSideData {
  oi: number;
  oiChange: number;
  previousOi: number;
  volume: number;
  previousVolume: number;
  iv: number;
  lastPrice: number;
  averagePrice: number;
  greeks: {
    delta: number;
    theta: number;
    gamma: number;
    vega: number;
  } | null;
}

export interface OptionChainData {
  underlying: {
    symbol: string;
    lastPrice: number;
    securityId: number;
  };
  expiries: string[];
  selectedExpiry: string;
  strikes: StrikeData[];
  summary: {
    totalCallOi: number;
    totalPutOi: number;
    callOiChange: number;
    putOiChange: number;
    pcr: number;
    atmStrike: number;
  };
  refreshedAt: string;
}

/** Format large OI numbers: 10L, 50L, 1.2Cr */
export function formatOI(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 10000000) return `${(value / 10000000).toFixed(1)}Cr`;
  if (abs >= 100000) return `${(value / 100000).toFixed(0)}L`;
  if (abs >= 1000) return `${(value / 1000).toFixed(0)}K`;
  return value.toLocaleString('en-IN');
}
