import { NextResponse } from 'next/server';

import { prisma } from '@/lib/db';
import { dhanMarketFeed, todayIST, type MarketFeedQuote } from '@/lib/dhan/market-feed';
import { dhanRequest } from '@/lib/dhan/rate-limiter';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// TradeFinder's daily-index param_3 is an unsigned activity magnitude with its
// direction applied as the sign. Ground-truth fitting in this repo found its
// dominant relationship to be today's normalized range versus the prior 20
// sessions: R ~= 1.5596 * range ratio. Unlike the app's 1-8 stock score, TF's
// chart value is allowed below 1, so there is deliberately no floor here.
const RANGE_COEFFICIENT = 1.5596;
const BASELINE_WINDOW = 20;
const MIN_BASELINE_SESSIONS = 5;
const BASELINE_CACHE_MS = 6 * 60 * 60_000;
const LIVE_CACHE_MS = 60_000;

// Verified Dhan IDX_I IDs. Dhan has no NIFTY CEMENT instrument, so that one is
// reconstructed from TF's exact four-stock cement basket below.
const DHAN_INDEX_IDS = {
  'NIFTY 50': 13,
  'NIFTY AUTO': 14,
  'NIFTY BANK': 25,
  'NIFTY ENERGY': 42,
  'NIFTY FIN SERVICE': 27,
  'NIFTY FMCG': 28,
  'NIFTY IT': 29,
  'NIFTY METAL': 31,
  'NIFTY MID SELECT': 442,
  'NIFTY PHARMA': 32,
  'NIFTY PSU BANK': 33,
  'NIFTY PVT BANK': 15,
  'NIFTY REALTY': 34,
  SENSEX: 51,
} as const;

const CEMENT_SYMBOLS = ['AMBUJACEM', 'DALBHARAT', 'SHREECEM', 'ULTRACEMCO'] as const;

interface HistoricalResponse {
  high?: number[];
  low?: number[];
  close?: number[];
  timestamp?: number[];
}

interface BaselineState {
  date: string;
  indexRanges: Record<string, number>;
  cement: { securityIds: number[]; range20dAvg: number | null };
}

interface IndexPayload {
  success: true;
  source: 'dhan-index-r-factor';
  asOf: string;
  values: Record<string, number>;
  sourceByName: Record<string, 'dhan-index' | 'dhan-cement-basket'>;
  stale: boolean;
}

let baselineCache: { at: number; state: BaselineState } | null = null;
let baselinePromise: Promise<BaselineState> | null = null;
let liveCache: { at: number; payload: IndexPayload } | null = null;

function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function timestampDateIST(timestamp: number): string {
  return new Date((timestamp + 5.5 * 3600) * 1000).toISOString().slice(0, 10);
}

function mean(values: number[], minimum = MIN_BASELINE_SESSIONS): number | null {
  const valid = values.filter((value) => Number.isFinite(value) && value > 0);
  return valid.length >= minimum
    ? valid.reduce((total, value) => total + value, 0) / valid.length
    : null;
}

async function loadRangeBaseline(
  securityId: number,
  exchangeSegment: 'IDX_I' | 'NSE_EQ',
  instrument: 'INDEX' | 'EQUITY',
  date: string,
): Promise<number | null> {
  const response = await dhanRequest('/v2/charts/historical', {
    securityId: String(securityId),
    exchangeSegment,
    instrument,
    expiryCode: 0,
    oi: false,
    fromDate: shiftDate(date, -55),
    toDate: shiftDate(date, 1),
  }) as HistoricalResponse;

  const count = Math.min(
    response.high?.length ?? 0,
    response.low?.length ?? 0,
    response.close?.length ?? 0,
  );
  const ranges: number[] = [];
  for (let index = 0; index < count; index++) {
    const timestamp = response.timestamp?.[index];
    if (timestamp != null && timestampDateIST(timestamp) >= date) continue;
    const high = Number(response.high?.[index] ?? 0);
    const low = Number(response.low?.[index] ?? 0);
    const close = Number(response.close?.[index] ?? 0);
    if (close > 0 && high >= low && high > 0) ranges.push((high - low) / close);
  }
  return mean(ranges.slice(-BASELINE_WINDOW));
}

async function refreshBaselines(): Promise<BaselineState> {
  const date = todayIST();
  if (
    baselineCache &&
    baselineCache.state.date === date &&
    Date.now() - baselineCache.at < BASELINE_CACHE_MS
  ) {
    return baselineCache.state;
  }
  if (baselinePromise) return baselinePromise;

  baselinePromise = (async () => {
    const indexRanges: Record<string, number> = {};
    const indexEntries = Object.entries(DHAN_INDEX_IDS);
    const indexResults = await Promise.all(
      indexEntries.map(async ([name, securityId]) => ({
        name,
        baseline: await loadRangeBaseline(securityId, 'IDX_I', 'INDEX', date).catch(() => null),
      })),
    );
    for (const { name, baseline } of indexResults) {
      if (baseline != null) indexRanges[name] = baseline;
    }

    // Equity security IDs are stable. Read the local master directly so Sector
    // Scope does not trigger or depend on the daily derivatives-master sync.
    const cementEntries = await prisma.masterContract.findMany({
      where: { symbol: { in: [...CEMENT_SYMBOLS] }, exchange: 'NSE', segment: 'NSE_EQ' },
      select: { symbol: true, securityId: true },
    });
    const cementBaselines = await Promise.all(
      cementEntries.map((entry) =>
        loadRangeBaseline(Number(entry.securityId), 'NSE_EQ', 'EQUITY', date).catch(() => null),
      ),
    );
    const state: BaselineState = {
      date,
      indexRanges,
      cement: {
        securityIds: cementEntries.map((entry) => Number(entry.securityId)),
        range20dAvg: mean(
          cementBaselines.filter((value): value is number => value != null),
          CEMENT_SYMBOLS.length,
        ),
      },
    };
    baselineCache = { at: Date.now(), state };
    return state;
  })().finally(() => {
    baselinePromise = null;
  });

  return baselinePromise;
}

function signedRangeFactor(quote: MarketFeedQuote | undefined, baseline: number | null | undefined): number | null {
  const ltp = quote?.last_price ?? 0;
  const high = quote?.ohlc?.high ?? 0;
  const low = quote?.ohlc?.low ?? 0;
  if (!(ltp > 0) || !(high >= low) || !(high > 0) || !(baseline != null && baseline > 0)) return null;

  const magnitude = RANGE_COEFFICIENT * (((high - low) / ltp) / baseline);
  const open = quote?.ohlc?.open ?? 0;
  const priorClose = quote?.ohlc?.close ?? 0;
  const anchor = open > 0 ? open : priorClose;
  const sign = anchor > 0 && ltp < anchor ? -1 : 1;
  return Math.round(sign * magnitude * 100) / 100;
}

function cementRangeFactor(
  quotes: Record<string, MarketFeedQuote>,
  securityIds: number[],
  baseline: number | null,
): number | null {
  if (!(baseline != null && baseline > 0)) return null;
  const ranges: number[] = [];
  const directions: number[] = [];
  for (const securityId of securityIds) {
    const quote = quotes[String(securityId)];
    const ltp = quote?.last_price ?? 0;
    const high = quote?.ohlc?.high ?? 0;
    const low = quote?.ohlc?.low ?? 0;
    const open = quote?.ohlc?.open ?? 0;
    if (ltp > 0 && high >= low && high > 0) ranges.push((high - low) / ltp);
    if (ltp > 0 && open > 0) directions.push((ltp - open) / open);
  }
  const currentRange = mean(ranges, CEMENT_SYMBOLS.length);
  if (currentRange == null) return null;
  const magnitude = RANGE_COEFFICIENT * (currentRange / baseline);
  const direction = directions.reduce((total, value) => total + value, 0);
  return Math.round((direction < 0 ? -magnitude : magnitude) * 100) / 100;
}

export async function GET() {
  if (liveCache && Date.now() - liveCache.at < LIVE_CACHE_MS) {
    return NextResponse.json(liveCache.payload);
  }

  try {
    const baselines = await refreshBaselines();
    const response = await dhanMarketFeed('quote', {
      IDX_I: Object.values(DHAN_INDEX_IDS),
      NSE_EQ: baselines.cement.securityIds,
    });
    const indexQuotes = (response.IDX_I ?? {}) as Record<string, MarketFeedQuote>;
    const cementQuotes = (response.NSE_EQ ?? {}) as Record<string, MarketFeedQuote>;
    const values: Record<string, number> = {};
    const sourceByName: Record<string, 'dhan-index' | 'dhan-cement-basket'> = {};

    for (const [name, securityId] of Object.entries(DHAN_INDEX_IDS)) {
      const factor = signedRangeFactor(indexQuotes[String(securityId)], baselines.indexRanges[name]);
      if (factor == null) continue;
      values[name] = factor;
      sourceByName[name] = 'dhan-index';
    }

    const cement = cementRangeFactor(
      cementQuotes,
      baselines.cement.securityIds,
      baselines.cement.range20dAvg,
    );
    if (cement != null) {
      values['NIFTY CEMENT'] = cement;
      sourceByName['NIFTY CEMENT'] = 'dhan-cement-basket';
    }

    if (Object.keys(values).length === 0) throw new Error('Index R-factor data is unavailable');
    const payload: IndexPayload = {
      success: true,
      source: 'dhan-index-r-factor',
      asOf: new Date().toISOString(),
      values,
      sourceByName,
      stale: false,
    };
    liveCache = { at: Date.now(), payload };
    return NextResponse.json(payload);
  } catch (error) {
    if (liveCache) {
      return NextResponse.json({ ...liveCache.payload, stale: true, staleSince: liveCache.at });
    }
    return NextResponse.json(
      { success: false, error: (error as Error).message, values: {} },
      { status: 502 },
    );
  }
}
