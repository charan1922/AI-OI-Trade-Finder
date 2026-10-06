import { prisma } from '@/lib/db';
import { requestFyersData } from './client';
import type { MarketFeedQuote, MarketFeedResponse } from '@/lib/market-data/common';

/** Legacy index keys are internal identifiers, not tokens sent to Fyers. */
export const INDEX_SYMBOLS: Record<number, string> = {
  13: 'NSE:NIFTY50-INDEX', 25: 'NSE:NIFTYBANK-INDEX', 27: 'NSE:FINNIFTY-INDEX',
  29: 'NSE:NIFTYIT-INDEX', 14: 'NSE:NIFTYAUTO-INDEX', 32: 'NSE:NIFTYPHARMA-INDEX',
  28: 'NSE:NIFTYFMCG-INDEX', 31: 'NSE:NIFTYMETAL-INDEX', 42: 'NSE:NIFTYENERGY-INDEX',
  34: 'NSE:NIFTYREALTY-INDEX', 15: 'NSE:NIFTYPVTBANK-INDEX', 33: 'NSE:NIFTYPSUBANK-INDEX',
};

const finite = (value: unknown): number | undefined =>
  value == null || value === '' || !Number.isFinite(Number(value)) ? undefined : Number(value);

/** Missing OI and book sizes stay missing, never masquerade as measured zeroes. */
export function normalizeFyersDepth(v: Record<string, unknown>): MarketFeedQuote {
  const lastPrice = finite(v.ltp);
  if (lastPrice == null || lastPrice < 0) throw new Error('Fyers depth is missing a valid LTP');
  const levels = (value: unknown) => !Array.isArray(value) ? undefined : value.flatMap((level) => {
    if (!level || typeof level !== 'object') return [];
    const price = finite(level.price);
    const quantity = finite(level.volume ?? level.qty);
    const orders = finite(level.ord ?? level.orders) ?? 0;
    return price == null || quantity == null || price < 0 || quantity < 0 ? [] : [{ price, quantity, orders }];
  });
  return {
    last_price: lastPrice,
    ohlc: { open: finite(v.o) ?? 0, high: finite(v.h) ?? 0, low: finite(v.l) ?? 0, close: finite(v.c) ?? 0 },
    volume: finite(v.v), oi: finite(v.oi), average_price: finite(v.atp),
    net_change: finite(v.ch), buy_quantity: finite(v.totalbuyqty), sell_quantity: finite(v.totalsellqty),
    depth: { buy: levels(v.bids), sell: levels(v.ask ?? v.asks) },
  };
}

export async function resolveFeedSymbols(securities: Record<string, number[]>) {
  const wanted = Object.entries(securities).flatMap(([segment, ids]) =>
    [...new Set(ids)].map((id) => ({ segment, id: String(id) })));
  const rows = await prisma.masterContract.findMany({
    where: { OR: wanted.filter((w) => w.segment !== 'IDX_I').map((w) => ({ segment: w.segment, securityId: w.id })) },
    select: { securityId: true, segment: true, symbol: true },
  });
  const map = new Map(rows.map((row) => [`${row.segment}:${row.securityId}`, row]));
  return wanted.map(({ segment, id }) => {
    const row = map.get(`${segment}:${id}`);
    // Derivative symbols MUST come from the Fyers master; no guessed expiry codes.
    const symbol = segment === 'IDX_I' ? INDEX_SYMBOLS[Number(id)] : row?.symbol.startsWith('NSE:')
      ? row.symbol : segment === 'NSE_EQ' && row ? `NSE:${row.symbol}-EQ` : undefined;
    if (!symbol) throw new Error(`Fyers instrument unavailable for ${segment}/${id}; sync the Fyers master`);
    return { segment, id, symbol };
  });
}

const host = globalThis as unknown as { __fyersDepthRequests?: Map<string, Promise<MarketFeedQuote>> };
host.__fyersDepthRequests ??= new Map();

export async function fetchFyersDepth(symbol: string, deadline = Date.now() + 8_000): Promise<MarketFeedQuote> {
  const running = host.__fyersDepthRequests!.get(symbol);
  if (running) return running;
  const request = (async () => {
    const response = await requestFyersData('depth', { symbol, ohlcv_flag: 1 }, deadline);
    const values = response.d as Record<string, Record<string, unknown>> | undefined;
    if (!values?.[symbol]) throw new Error(`Fyers depth missing requested symbol ${symbol}`);
    return normalizeFyersDepth(values[symbol]);
  })();
  host.__fyersDepthRequests!.set(symbol, request);
  try { return await request; } finally { host.__fyersDepthRequests!.delete(symbol); }
}

/** Full depth/OI requires one request per instrument on Fyers, not Dhan-sized batches. */
export async function marketFeed(endpoint: 'quote' | 'ohlc', securities: Record<string, number[]>): Promise<MarketFeedResponse> {
  const contracts = await resolveFeedSymbols(securities);
  const out: MarketFeedResponse = {};
  const deadline = Date.now() + 8_000;
  if (endpoint === 'ohlc' || contracts.every((c) => c.segment === 'IDX_I')) {
    for (let i = 0; i < contracts.length; i += 50) {
      const batch = contracts.slice(i, i + 50);
      const response = await requestFyersData('quotes', { symbols: batch.map((c) => c.symbol).join(',') }, deadline);
      const data = response.d as { n: string; s: string; v: Record<string, unknown> }[];
      if (!Array.isArray(data)) throw new Error('Invalid Fyers quotes response');
      for (const contract of batch) {
        const v = data.find((entry) => entry.n === contract.symbol && entry.s === 'ok')?.v;
        if (!v) throw new Error(`Fyers quote unavailable for ${contract.symbol}`);
        (out[contract.segment] ??= {})[contract.id] = normalizeFyersDepth({
          ltp: v.lp, o: v.open_price, h: v.high_price, l: v.low_price, c: v.prev_close_price,
          ch: v.ch, v: v.volume, atp: v.atp,
        });
      }
    }
  } else {
    // A bounded worker pool avoids enqueuing the whole universe ahead of position quotes.
    let cursor = 0;
    let failed = false;
    const worker = async () => {
      while (!failed && cursor < contracts.length) {
        const contract = contracts[cursor++];
        try {
          const quote = await fetchFyersDepth(contract.symbol, deadline);
          (out[contract.segment] ??= {})[contract.id] = quote;
        } catch (error) { failed = true; throw error; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, contracts.length) }, worker));
  }
  return out;
}
