import { prisma } from '@/lib/db';
import { requestFyersData } from './client';
import { INDEX_SYMBOLS } from './market-feed';

export interface OptionChainGreeksRow {
  strike: number;
  callGamma: number;
  callOi: number;
  putGamma: number;
  putOi: number;
}
export interface OptionChainGreeksSnapshot {
  rows: OptionChainGreeksRow[];
  underlyingLastPrice: number | null;
}
export interface DetailedOptionSide {
  securityId: string | null;
  lastPrice: number;
  averagePrice: number;
  oi: number;
  previousOi: number;
  previousClosePrice: number;
  previousVolume: number;
  volume: number;
  impliedVolatility: number | null;
  topBidPrice: number | null;
  topBidQuantity: number | null;
  topAskPrice: number | null;
  topAskQuantity: number | null;
  greeks: { delta: number; gamma: number; theta: number; vega: number } | null;
}
export interface DetailedOptionStrike { strike: number; ce: DetailedOptionSide | null; pe: DetailedOptionSide | null }
export interface DetailedOptionChain { underlyingLastPrice: number; strikes: DetailedOptionStrike[]; fetchedAt: string }

const number = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const positive = (value: unknown) => number(value) > 0 ? number(value) : null;

async function underlyingSymbol(securityId: number, segment: 'IDX_I' | 'NSE_FNO' = 'NSE_FNO') {
  if (segment === 'IDX_I') return INDEX_SYMBOLS[securityId] ?? null;
  const row = await prisma.masterContract.findFirst({
    where: { securityId: String(securityId), segment: 'NSE_EQ' }, select: { symbol: true },
  });
  return row ? `NSE:${row.symbol}-EQ` : null;
}

async function getChain(symbol: string, expiry?: string) {
  let timestamp: string | undefined;
  const first = await requestFyersData('options-chain-v3', { symbol, strikecount: 50, greeks: 1 });
  const firstData = first.data as Record<string, unknown> | undefined;
  if (expiry) {
    const expiryData = firstData?.expiryData as Record<string, unknown>[] | undefined;
    timestamp = expiryData?.find((item) => String(item.date).split('-').reverse().join('-') === expiry)?.expiry as string | undefined;
    if (!timestamp) return null;
  }
  if (!timestamp) return firstData ?? null;
  const response = await requestFyersData('options-chain-v3', { symbol, strikecount: 50, greeks: 1, timestamp });
  return response.data as Record<string, unknown> | undefined ?? null;
}

export async function fetchOptionExpiries(underlyingSecId: number, segment: 'IDX_I' | 'NSE_FNO') {
  const symbol = await underlyingSymbol(underlyingSecId, segment);
  if (!symbol) return [];
  const data = await getChain(symbol);
  const expiries = data?.expiryData as Record<string, unknown>[] | undefined;
  return (expiries ?? []).map((item) => String(item.date).split('-').reverse().join('-')).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort();
}

function side(row: Record<string, unknown>): DetailedOptionSide {
  const greeks = row.greeks as Record<string, unknown> | undefined;
  return {
    securityId: row.fyToken == null ? null : String(row.fyToken),
    lastPrice: number(row.ltp), averagePrice: number(row.fp), oi: number(row.oi),
    previousOi: number(row.prev_oi), previousClosePrice: number(row.fp), previousVolume: 0,
    volume: number(row.volume), impliedVolatility: positive(greeks?.iv),
    topBidPrice: positive(row.bid), topBidQuantity: null, topAskPrice: positive(row.ask), topAskQuantity: null,
    greeks: greeks ? { delta: number(greeks.delta), gamma: number(greeks.gamma), theta: number(greeks.theta), vega: number(greeks.vega) } : null,
  };
}

async function detailed(underlyingSecId: number, expiry: string, segment: 'IDX_I' | 'NSE_FNO') {
  const symbol = await underlyingSymbol(underlyingSecId, segment);
  if (!symbol) return null;
  const data = await getChain(symbol, expiry);
  const raw = data?.optionsChain as Record<string, unknown>[] | undefined;
  if (!raw) return null;
  const spot = raw.find((row) => String(row.option_type ?? '') === '');
  const underlyingLastPrice = number(spot?.ltp);
  if (!(underlyingLastPrice > 0)) return null;
  const byStrike = new Map<number, DetailedOptionStrike>();
  for (const row of raw) {
    const type = String(row.option_type ?? '');
    const strike = number(row.strike_price);
    if (!['CE', 'PE'].includes(type) || !(strike > 0)) continue;
    const current = byStrike.get(strike) ?? { strike, ce: null, pe: null };
    if (type === 'CE') current.ce = side(row); else current.pe = side(row);
    byStrike.set(strike, current);
  }
  return { underlyingLastPrice, strikes: [...byStrike.values()].sort((a, b) => a.strike - b.strike), fetchedAt: new Date().toISOString() };
}

export async function fetchDetailedOptionChainShadow(underlyingSecId: number, expiry: string): Promise<DetailedOptionChain | null> {
  return detailed(underlyingSecId, expiry, 'NSE_FNO');
}

export async function fetchOptionChainGreeks(underlyingSecId: number, expiry: string): Promise<OptionChainGreeksSnapshot | null> {
  const chain = await detailed(underlyingSecId, expiry, 'IDX_I');
  if (!chain) return null;
  return {
    underlyingLastPrice: chain.underlyingLastPrice,
    rows: chain.strikes.map((row) => ({
      strike: row.strike, callGamma: row.ce?.greeks?.gamma ?? 0, callOi: row.ce?.oi ?? 0,
      putGamma: row.pe?.greeks?.gamma ?? 0, putOi: row.pe?.oi ?? 0,
    })),
  };
}
