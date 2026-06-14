/**
 * Dhan Master Contract Lookup — Prisma SQLite backed
 *
 * Downloads Dhan's master CSV once per day, stores in SQLite via Prisma.
 * All lookups hit the DB (indexed) — no 100MB CSV download on every restart.
 */

import fnoUniverse from '@/lib/data/fno_stocks_list.json';
import { prisma } from '@/lib/db';

const MASTER_CSV_URL = 'https://images.dhan.co/api-data/api-scrip-master.csv';

// Only sync instruments needed for R-Factor: equity OHLC + stock/index futures
const KEEP_SEGMENTS = new Set(['NSE_EQ', 'NSE_FNO']);
const KEEP_INSTRUMENTS = new Set(['EQUITY', 'FUTSTK', 'FUTIDX', 'OPTSTK']);

export type SecurityEntry = {
  securityId: string;
  symbol: string;
  exchange: string;
  segment: string;
  name: string;
  instrument: string;
};

export type FuturesEntry = SecurityEntry & {
  expiry: Date;
  underlying: string;
};

export type FuturesRangeEntry = SecurityEntry & {
  expiry: Date;
  underlying: string;
  lotSize: number;
};

// Process-level flag — skip even the DB check once synced
let synced = false;
const FNO_SYMBOLS = new Set<string>(fnoUniverse.stocks);

import { todayIST } from '@/lib/dhan/market-feed';

/**
 * Check if master contracts are synced for today.
 * Does NOT trigger a download — consumers should direct users to the Master Contracts page.
 */
export async function ensureSynced(): Promise<void> {
  if (synced) return;

  const today = todayIST();
  const count = await prisma.masterContract.count({
    where: { syncDate: today },
  });

  if (count > 0) {
    synced = true;
    return;
  }

  throw new MasterContractsNotSyncedError(today);
}

/** Thrown when master contracts haven't been synced today. */
export class MasterContractsNotSyncedError extends Error {
  constructor(date: string) {
    super(`Master contracts not synced for ${date}. Please sync from the Master Contracts page.`);
    this.name = 'MasterContractsNotSyncedError';
  }
}

/**
 * Download CSV from Dhan, parse, and bulk-insert into SQLite.
 */
async function syncFromDhan(today: string): Promise<void> {
  console.log(`[MasterContracts] Syncing from Dhan CSV for ${today}...`);
  const startMs = Date.now();

  const resp = await fetch(MASTER_CSV_URL);
  if (!resp.ok) throw new Error(`Failed to fetch master CSV: ${resp.status}`);

  const text = await resp.text();
  const lines = text.split('\n');
  if (lines.length < 2) throw new Error('Empty master contract CSV');

  const header = lines[0].split(',').map((h) => h.trim().replace(/"/g, ''));
  const col = (name: string) => header.indexOf(name);

  const idxExch = col('SEM_EXM_EXCH_ID');
  const idxSeg = col('SEM_SEGMENT');
  const idxId = col('SEM_SMST_SECURITY_ID');
  const idxSym = col('SEM_TRADING_SYMBOL');
  const idxName = col('SEM_INSTRUMENT_NAME');
  const idxInstType = col('SEM_EXCH_INSTRUMENT_TYPE');
  const idxExpiry = col('SEM_EXPIRY_DATE');
  const idxLotSize = col('SEM_LOT_UNITS');
  const idxStrikePrice = col('SEM_STRIKE_PRICE');
  const idxOptionType = col('SEM_OPTION_TYPE');

  // Parse all rows
  const entries: {
    securityId: string;
    symbol: string;
    exchange: string;
    segment: string;
    instrument: string;
    name: string;
    underlying: string | null;
    expiryDate: Date | null;
    lotSize: number;
    strikePrice: number | null;
    optionType: string | null;
    syncDate: string;
  }[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = line.split(',').map((c) => c.trim().replace(/"/g, ''));

    const rawExch = cols[idxExch] || '';
    const rawSeg = cols[idxSeg] || '';
    const secId = cols[idxId] || '';
    const symbol = cols[idxSym] || '';
    const name = cols[idxName] || '';
    const instType = cols[idxInstType] || '';
    const expiryStr = cols[idxExpiry] || '';
    const lotSizeStr = cols[idxLotSize] || '1';

    if (!secId || !symbol) continue;

    // Normalize segment
    let segment = rawSeg;
    if (rawExch === 'NSE' && rawSeg === 'E') segment = 'NSE_EQ';
    else if (rawExch === 'BSE' && rawSeg === 'E') segment = 'BSE_EQ';
    else if (rawExch === 'NSE' && rawSeg === 'D') segment = 'NSE_FNO';
    else if (rawExch === 'BSE' && rawSeg === 'D') segment = 'BSE_FNO';
    else if (rawExch === 'NSE' && rawSeg === 'I') segment = 'IDX_I';
    else if (rawExch === 'MCX' && rawSeg === 'M') segment = 'MCX_COMM';

    // Normalize instrument
    let instrument = instType.toUpperCase();
    if (segment.includes('_EQ')) instrument = 'EQUITY';
    if (instrument === 'FUT') instrument = name.toUpperCase(); // FUTSTK, FUTIDX
    if (instrument === 'OP') instrument = name.toUpperCase(); // OPTSTK, OPTIDX

    // Only keep what R-Factor needs: equity + stock/index futures
    if (!KEEP_SEGMENTS.has(segment) || !KEEP_INSTRUMENTS.has(instrument)) continue;

    // Extract underlying for futures/options (e.g. "RELIANCE-Mar2026-FUT" → "RELIANCE").
    // Split at the expiry token (Mon+Year), NOT the first dash — hyphenated
    // underlyings like "BAJAJ-AUTO-Jun2026-FUT" must yield "BAJAJ-AUTO".
    let underlying: string | null = null;
    if (instrument === 'FUTSTK' || instrument === 'OPTSTK') {
      const parts = symbol.split('-');
      const expiryIdx = parts.findIndex((p) => /^[A-Z][a-z]{2}\d{4}$/.test(p));
      if (expiryIdx > 0) underlying = parts.slice(0, expiryIdx).join('-');
      else if (parts.length > 1) underlying = parts[0]; // fallback: previous behavior
    }

    // Parse expiry
    let expiryDate: Date | null = null;
    if (expiryStr) {
      const d = new Date(expiryStr);
      if (!Number.isNaN(d.getTime())) expiryDate = d;
    }

    // Parse strike price and option type for OPTSTK
    const strikePriceRaw = idxStrikePrice >= 0 ? cols[idxStrikePrice] : '';
    const optionTypeRaw = idxOptionType >= 0 ? cols[idxOptionType] : '';
    const strikePrice = instrument === 'OPTSTK' && strikePriceRaw ? Number.parseFloat(strikePriceRaw) || null : null;
    const optionType = instrument === 'OPTSTK' && optionTypeRaw ? optionTypeRaw.toUpperCase() : null;

    entries.push({
      securityId: secId,
      symbol,
      exchange: rawExch,
      segment,
      instrument,
      name,
      underlying,
      expiryDate,
      lotSize: Number.parseFloat(lotSizeStr) || 1,
      strikePrice,
      optionType,
      syncDate: today,
    });
  }

  console.log(`[MasterContracts] Parsed ${entries.length} entries, inserting into DB...`);

  // Clear all rows before re-inserting — ensures syncDate is always today
  await prisma.$executeRawUnsafe('DELETE FROM master_contracts');

  // Bulk insert using raw SQL for speed
  const CHUNK_SIZE = 500;
  for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
    const chunk = entries.slice(i, i + CHUNK_SIZE);
    const values = chunk
      .map((e) => {
        const esc = (s: string) => s.replace(/'/g, "''");
        const exp = e.expiryDate ? `'${e.expiryDate.toISOString()}'` : 'NULL';
        const und = e.underlying ? `'${esc(e.underlying)}'` : 'NULL';
        const sp = e.strikePrice !== null ? `${e.strikePrice}` : 'NULL';
        const ot = e.optionType ? `'${esc(e.optionType)}'` : 'NULL';
        return `(NULL, '${esc(e.securityId)}', '${esc(e.symbol)}', '${esc(e.exchange)}', '${esc(e.segment)}', '${esc(e.instrument)}', '${esc(e.name)}', ${und}, ${exp}, ${e.lotSize}, ${sp}, ${ot}, '${e.syncDate}')`;
      })
      .join(',');

    await prisma.$executeRawUnsafe(
      `INSERT OR IGNORE INTO master_contracts (id, securityId, symbol, exchange, segment, instrument, name, underlying, expiryDate, lotSize, strikePrice, optionType, syncDate) VALUES ${values}`,
    );

    if ((i / CHUNK_SIZE) % 50 === 0 && i > 0) {
      console.log(`[MasterContracts] Inserted ${i}/${entries.length}...`);
    }
  }

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`[MasterContracts] Synced ${entries.length} rows in ${elapsed}s`);
}

/**
 * Force a fresh sync from Dhan CSV (used by the re-sync API).
 * Returns the number of rows inserted.
 */
export async function forceSync(): Promise<{ count: number; elapsed: string }> {
  const today = todayIST();
  const startMs = Date.now();
  await syncFromDhan(today);
  synced = true;
  const count = await prisma.masterContract.count();
  return { count, elapsed: `${((Date.now() - startMs) / 1000).toFixed(1)}s` };
}

/**
 * Resolve equity security entry by symbol.
 */
export async function resolveSymbol(symbol: string, exchange = 'NSE'): Promise<SecurityEntry | null> {
  await ensureSynced();

  const row = await prisma.masterContract.findFirst({
    where: {
      symbol,
      exchange,
      segment: `${exchange}_EQ`,
    },
  });

  if (!row) return null;
  return {
    securityId: row.securityId,
    symbol: row.symbol,
    exchange: row.exchange,
    segment: row.segment,
    name: row.name,
    instrument: row.instrument,
  };
}

/**
 * Resolve near-month stock futures for a single underlying.
 */
export async function resolveFuturesSecurity(underlying: string): Promise<FuturesEntry | null> {
  await ensureSynced();

  const rows = await prisma.masterContract.findMany({
    where: {
      underlying,
      instrument: 'FUTSTK',
      segment: 'NSE_FNO',
      expiryDate: { gte: new Date() },
    },
    orderBy: { expiryDate: 'asc' },
    take: 1,
  });

  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    securityId: row.securityId,
    symbol: row.symbol,
    exchange: row.exchange,
    segment: row.segment,
    name: row.name,
    instrument: row.instrument,
    expiry: row.expiryDate!,
    underlying: row.underlying!,
  };
}

/**
 * Batch-resolve near-month futures security IDs for multiple underlyings.
 * Returns Map<underlying, { securityId, lotSize }>.
 */
export async function batchResolveFutures(
  underlyings: string[],
  tradeDate?: string,
): Promise<Map<string, { securityId: string; lotSize: number; expiryDate: string }>> {
  await ensureSynced();

  const result = new Map<string, { securityId: string; lotSize: number; expiryDate: string }>();
  if (underlyings.length === 0) return result;

  // Use tradeDate for historical resolution (finds contracts active on that date)
  const refDate = tradeDate ? new Date(tradeDate) : new Date();

  const rows = await prisma.masterContract.findMany({
    where: {
      underlying: { in: underlyings },
      instrument: 'FUTSTK',
      segment: 'NSE_FNO',
      expiryDate: { gte: refDate },
    },
    orderBy: { expiryDate: 'asc' },
  });

  // Pick nearest expiry per underlying
  for (const row of rows) {
    if (row.underlying && !result.has(row.underlying)) {
      const expiry = row.expiryDate ? new Date(row.expiryDate).toISOString().split('T')[0] : '';
      result.set(row.underlying, { securityId: row.securityId, lotSize: row.lotSize, expiryDate: expiry });
    }
  }

  return result;
}

/**
 * Search symbols by query string.
 */
export async function searchSymbols(query: string, exchange?: string): Promise<SecurityEntry[]> {
  await ensureSynced();

  const normalizedQuery = query.toUpperCase();

  const rows = await prisma.masterContract.findMany({
    where: {
      symbol: { contains: normalizedQuery },
      ...(exchange ? { exchange } : {}),
      segment: { endsWith: '_EQ' },
    },
    take: 200,
  });

  const rank = (symbol: string): number => {
    if (symbol === normalizedQuery) return 0;
    if (symbol.startsWith(normalizedQuery)) return 10;
    if (symbol.includes(normalizedQuery)) return 20;
    return 30;
  };

  return rows
    .map((r) => ({
      securityId: r.securityId,
      symbol: r.symbol,
      exchange: r.exchange,
      segment: r.segment,
      name: r.name,
      instrument: r.instrument,
    }))
    .sort((left, right) => {
      const rankDiff = rank(left.symbol) - rank(right.symbol);
      if (rankDiff !== 0) return rankDiff;

      const fnoBoostDiff = Number(FNO_SYMBOLS.has(right.symbol)) - Number(FNO_SYMBOLS.has(left.symbol));
      if (fnoBoostDiff !== 0) return fnoBoostDiff;

      const digitPenaltyDiff = Number(/\d/.test(left.symbol)) - Number(/\d/.test(right.symbol));
      if (digitPenaltyDiff !== 0) return digitPenaltyDiff;

      const lengthDiff = left.symbol.length - right.symbol.length;
      if (lengthDiff !== 0) return lengthDiff;

      return left.symbol.localeCompare(right.symbol);
    })
    .slice(0, 20);
}

export async function getFuturesContractsForRange(
  underlying: string,
  fromDate: string,
  toDate: string,
): Promise<FuturesRangeEntry[]> {
  await ensureSynced();

  const start = new Date(fromDate);
  const end = new Date(toDate);

  const rows = await prisma.masterContract.findMany({
    where: {
      underlying,
      instrument: 'FUTSTK',
      segment: 'NSE_FNO',
      expiryDate: { gte: start },
    },
    orderBy: { expiryDate: 'asc' },
  });

  return rows
    .filter((row) => row.expiryDate && row.expiryDate <= new Date(end.getTime() + 120 * 24 * 60 * 60 * 1000))
    .map((row) => ({
      securityId: row.securityId,
      symbol: row.symbol,
      exchange: row.exchange,
      segment: row.segment,
      name: row.name,
      instrument: row.instrument,
      expiry: row.expiryDate!,
      underlying: row.underlying!,
      lotSize: row.lotSize,
    }));
}

/**
 * Resolve a stock option contract by underlying, strike, and type.
 * Returns the nearest monthly expiry with >= minDTE days to expiry.
 */
export async function resolveOptionSecurity(
  underlying: string,
  strikePrice: number,
  optionType: 'CE' | 'PE',
  minDTE = 7,
  tradeDate?: string,
): Promise<{ securityId: string; symbol: string; lotSize: number; expiry: string } | null> {
  await ensureSynced();

  // Use tradeDate for historical resolution (finds contracts active on that date)
  const minExpiry = tradeDate ? new Date(tradeDate) : new Date();
  if (!tradeDate) minExpiry.setDate(minExpiry.getDate() + minDTE);
  const minExpiryStr = minExpiry.toISOString();

  // Use raw SQL to avoid Prisma client cache issues with new columns
  // Cast strikePrice to REAL for SQLite type compatibility
  const rows = await prisma.$queryRawUnsafe<
    { securityId: string; symbol: string; lotSize: number; expiryDate: string }[]
  >(
    `SELECT securityId, symbol, lotSize, expiryDate FROM master_contracts
     WHERE underlying = '${underlying.replace(/'/g, "''")}' AND instrument = 'OPTSTK' AND segment = 'NSE_FNO'
     AND optionType = '${optionType}' AND CAST(strikePrice AS REAL) = ${strikePrice} AND expiryDate >= '${minExpiryStr}'
     ORDER BY expiryDate ASC LIMIT 1`,
  );

  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    securityId: row.securityId,
    symbol: row.symbol,
    lotSize: row.lotSize,
    expiry: row.expiryDate ? new Date(row.expiryDate).toISOString().split('T')[0] : '',
  };
}

/** Strike step sizes for common F&O stocks (from NSE circular) */
const STRIKE_STEPS: Record<string, number> = {
  RELIANCE: 20,
  TCS: 50,
  HDFCBANK: 25,
  INFY: 25,
  SBIN: 5,
  ICICIBANK: 25,
  KOTAKBANK: 25,
  LT: 50,
  HINDUNILVR: 25,
  ITC: 5,
  AXISBANK: 25,
  BAJFINANCE: 25,
  MARUTI: 100,
  WIPRO: 5,
  TATAMOTORS: 10,
  HCLTECH: 25,
  BHARTIARTL: 25,
  TATASTEEL: 5,
  NTPC: 5,
  ONGC: 5,
  POWERGRID: 5,
  SUNPHARMA: 25,
  M_M: 25,
  ADANIENT: 50,
  ADANIPORTS: 25,
  TITAN: 50,
  ULTRACEMCO: 50,
  BAJAJFINSV: 25,
  JSWSTEEL: 25,
  DIVISLAB: 50,
  NESTLEIND: 100,
  APOLLOHOSP: 100,
  CIPLA: 25,
  EICHERMOT: 100,
  GRASIM: 25,
  INDUSINDBK: 25,
  COALINDIA: 5,
  BPCL: 5,
  VEDL: 5,
  HINDALCO: 10,
  DLF: 10,
  GODREJPROP: 25,
  PRESTIGE: 25,
  MCX: 50,
  BSE: 50,
  IREDA: 5,
  NHPC: 5,
  PFC: 5,
  RECLTD: 5,
  SAIL: 5,
};

/** Get the strike step for a stock. Falls back to 25 (most common). */
export function getStrikeStep(symbol: string): number {
  return STRIKE_STEPS[symbol] ?? 25;
}

/** Calculate ATM strike from spot price */
export function nearestStrike(spot: number, strikeStep: number): number {
  return Math.round(spot / strikeStep) * strikeStep;
}
