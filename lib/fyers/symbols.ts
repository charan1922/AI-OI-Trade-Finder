/**
 * Fyers downloader universe + symbol mapping.
 *
 * Universe = ALL tradeable F&O stocks: every `fno_stocks` row that isn't an
 * index and isn't in the 'avoid' trade band (the bands shown on /fno-lots) —
 * ~167 names. Seeded once per IST day from the DB; symbols recorded earlier
 * today (e.g. explicit enrollments via addToUniverse) are kept on restart.
 * ~167 × 3 calls ≈ 175s per cycle at the 350ms gate — inside the 5-min window
 * and ~38k calls/day against Fyers' 100k cap.
 *
 * Fyers symbol formats: equity "NSE:RELIANCE-EQ"; current-month stock future
 * "NSE:RELIANCE26JULFUT", with the expiry month resolved from master_contracts
 * (nearest non-expired FUTSTK row — same DB-driven approach as
 * app/api/live/quote/route.ts, no last-Thursday math).
 */

import { prisma } from '@/lib/db';
import { getRecordedSymbols } from '@/lib/fyers/candle-store';

const TAG = '[FyersSymbols]';
const MONTH_CODES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** Bump when the seeding source changes — invalidates the day cache across hot reloads. */
const SEED_VERSION = 2;

const g = globalThis as unknown as {
  __fyersUniverse?: { date: string; seedVersion?: number; symbols: Set<string> };
  __fyersFutCache?: { date: string; map: Map<string, string | null> };
};

/** All non-index, non-'avoid' F&O underlyings — the tradeable universe on /fno-lots. */
async function loadFnoUniverseSymbols(): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<{ symbol: string }[]>(
    `SELECT symbol FROM fno_stocks WHERE isIndex = 0 AND tradeBand != 'avoid'`,
  );
  return rows.map((r) => r.symbol).filter(Boolean);
}

/** Day-scoped universe set: all tradeable F&O names + today's recorded extras. */
async function ensureUniverse(today: string): Promise<Set<string>> {
  if (!g.__fyersUniverse || g.__fyersUniverse.date !== today || g.__fyersUniverse.seedVersion !== SEED_VERSION) {
    const [fno, recorded] = [await loadFnoUniverseSymbols(), await getRecordedSymbols(today)];
    g.__fyersUniverse = { date: today, seedVersion: SEED_VERSION, symbols: new Set([...fno, ...recorded]) };
    console.log(`${TAG} Universe seeded: ${fno.length} F&O names + ${recorded.length} recorded today`);
  }
  return g.__fyersUniverse.symbols;
}

/**
 * Enroll extra symbols (e.g. the /live watchlist) into today's download
 * universe — the next 5-min cycle backfills them full-day. Fire-and-forget
 * friendly: never throws.
 */
export async function addToUniverse(symbols: string[], today: string): Promise<void> {
  try {
    const universe = await ensureUniverse(today);
    for (const s of symbols) if (s) universe.add(s.toUpperCase());
  } catch (err) {
    console.warn(`${TAG} addToUniverse failed: ${(err as Error).message}`);
  }
}

/** Today's tracked universe (seeded once per day; grows only via addToUniverse). */
export async function getTrackedUniverse(today: string): Promise<string[]> {
  return [...(await ensureUniverse(today))].sort();
}

/** Current accumulated universe without refreshing it (status page / poller). */
export function peekUniverse(): { date: string; symbols: string[] } | null {
  if (!g.__fyersUniverse) return null;
  return { date: g.__fyersUniverse.date, symbols: [...g.__fyersUniverse.symbols].sort() };
}

/** Fyers equity symbol for an NSE underlying. */
export function toEqSymbol(symbol: string): string {
  return `NSE:${symbol}-EQ`;
}

/**
 * Fyers current-month stock-future symbol, e.g. "NSE:RELIANCE26JULFUT" —
 * nearest non-expired FUTSTK contract from master_contracts. Null when the
 * underlying has no live future (caller skips FUT + OI for it). Resolutions
 * are cached per day (expiries only change at rollover).
 */
export async function resolveFutSymbol(symbol: string, today: string): Promise<string | null> {
  if (!g.__fyersFutCache || g.__fyersFutCache.date !== today) {
    g.__fyersFutCache = { date: today, map: new Map() };
  }
  const cache = g.__fyersFutCache.map;
  if (cache.has(symbol)) return cache.get(symbol) ?? null;

  const row = await prisma.masterContract.findFirst({
    where: {
      underlying: symbol,
      instrument: 'FUTSTK',
      segment: 'NSE_FNO',
      expiryDate: { gte: new Date() },
    },
    orderBy: { expiryDate: 'asc' },
    select: { expiryDate: true },
  });

  let fut: string | null = null;
  if (row?.expiryDate) {
    const exp = row.expiryDate;
    fut = `NSE:${symbol}${String(exp.getFullYear() % 100).padStart(2, '0')}${MONTH_CODES[exp.getMonth()]}FUT`;
  } else {
    console.warn(`${TAG} No live FUTSTK contract for ${symbol} — recording EQ candles only`);
  }
  cache.set(symbol, fut);
  return fut;
}
