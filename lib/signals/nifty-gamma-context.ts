import { prisma } from '@/lib/db';
import { fetchOptionChainGreeks, fetchOptionExpiries, isMarketHours, todayIST } from '@/lib/dhan/market-feed';
import { computeGex, type GexResult } from '@/lib/signals/gex';

export interface NiftyGammaContext {
  expiry: string;
  spot: number;
  lotSize: number;
  proxy: GexResult;
  capturedAt: string;
}

const host = globalThis as unknown as {
  __niftyGammaContext?: NiftyGammaContext | null;
  __niftyGammaRefresh?: Promise<NiftyGammaContext | null>;
};

/** Cache-only read for /live. Page traffic never starts a Dhan request and
 * therefore cannot delay a scan, order quote, or the fast position guard. */
export function getCachedNiftyGammaContext(): NiftyGammaContext | null {
  return host.__niftyGammaContext ?? null;
}

/** Low-priority display refresh. The poller calls this only after it owned and
 * completed the decision path and only when no order/position bears risk. */
export function refreshNiftyGammaContext(date = todayIST()): Promise<NiftyGammaContext | null> {
  if (host.__niftyGammaRefresh) return host.__niftyGammaRefresh;
  host.__niftyGammaRefresh = refreshNiftyGammaContextInner(date).finally(() => {
    host.__niftyGammaRefresh = undefined;
  });
  return host.__niftyGammaRefresh;
}

async function refreshNiftyGammaContextInner(date: string): Promise<NiftyGammaContext | null> {
  if (!isMarketHours()) return null;
  const expiries = await fetchOptionExpiries(13, 'IDX_I');
  const expiry = expiries.find((value) => value >= date);
  if (!expiry) return null;
  const reference = (
    await prisma.$queryRawUnsafe<{ lotSize: number }[]>(
      `SELECT lotSize FROM master_contracts
       WHERE instrument = 'OPTIDX' AND segment = 'NSE_FNO'
         AND symbol LIKE 'NIFTY-%' AND expiryDate = ?
       LIMIT 1`,
      expiry
    )
  )[0];
  const lotSize = Number(reference?.lotSize);
  if (!Number.isFinite(lotSize) || lotSize <= 0) return null;

  const chain = await fetchOptionChainGreeks(13, expiry);
  if (chain == null || chain.rows.length === 0 || (chain.underlyingLastPrice ?? 0) <= 0) return null;

  const context = {
    expiry,
    spot: chain.underlyingLastPrice!,
    lotSize,
    proxy: computeGex(chain.rows, chain.underlyingLastPrice!, lotSize),
    capturedAt: new Date().toISOString(),
  };
  host.__niftyGammaContext = context;
  return context;
}
