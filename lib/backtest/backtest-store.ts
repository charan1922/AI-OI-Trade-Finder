/**
 * Backtest Data Storage — SQLite via Prisma raw queries
 *
 * Uses the existing project-r.db SQLite database.
 * (Previously named duckdb-schema.ts — DuckDB was dropped due to module
 * isolation issues with Turbopack; the data now lives in SQLite.)
 */

import { prisma } from '@/lib/db';

// Tables this module is allowed to touch. The `table` argument of the generic
// helpers below is interpolated into SQL (table names can't be bound as
// parameters), so it must be validated against this allowlist — never trusted.
const ALLOWED_TABLES = new Set(['backtest_equity', 'backtest_futures', 'backtest_options', 'trade_contracts']);
function assertTable(table: string): void {
  if (!ALLOWED_TABLES.has(table)) throw new Error(`Unknown backtest table: ${table}`);
}

/** Ensure backtest tables exist in SQLite */
export async function ensureBacktestTables(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS backtest_equity (
      symbol TEXT NOT NULL, date TEXT NOT NULL, timestamp INTEGER NOT NULL,
      open REAL, high REAL, low REAL, close REAL, volume REAL,
      PRIMARY KEY (symbol, timestamp)
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS backtest_futures (
      symbol TEXT NOT NULL, date TEXT NOT NULL, timestamp INTEGER NOT NULL,
      open REAL, high REAL, low REAL, close REAL, volume REAL, oi REAL,
      PRIMARY KEY (symbol, timestamp)
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS backtest_options (
      symbol TEXT NOT NULL, date TEXT NOT NULL, timestamp INTEGER NOT NULL,
      option_type TEXT NOT NULL, strike REAL NOT NULL,
      open REAL, high REAL, low REAL, close REAL,
      volume REAL, oi REAL, iv REAL, spot REAL,
      PRIMARY KEY (symbol, option_type, strike, timestamp)
    )
  `);
  // Resolved Dhan contract IDs per trade — preserved at download time so
  // re-syncs reuse the exact contracts instead of re-resolving from the
  // (mutable, today-only) master, and so the UI can show what backed the data.
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS trade_contracts (
      symbol TEXT NOT NULL, date TEXT NOT NULL,
      option_type TEXT NOT NULL, strike REAL NOT NULL,
      eq_security_id TEXT,
      fut_security_id TEXT, fut_expiry TEXT, fut_lot_size REAL,
      opt_security_id TEXT, opt_via TEXT,
      resolved_at TEXT NOT NULL,
      PRIMARY KEY (symbol, date, option_type, strike)
    )
  `);

  // Indexes for the per-day aggregation queries (getDailyContext / getStrikeLadder):
  // they filter by symbol + group/scan by date, which the (symbol, timestamp)
  // primary key alone doesn't serve. IF NOT EXISTS keeps this idempotent.
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_eq_symbol_date ON backtest_equity (symbol, date)`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_fut_symbol_date ON backtest_futures (symbol, date)`);
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS idx_opt_symbol_date ON backtest_options (symbol, date, option_type, strike)`,
  );
}

/** Get row count for a table */
export async function getRowCount(table: string, symbol?: string): Promise<number> {
  await ensureBacktestTables();
  assertTable(table);
  const rows = symbol
    ? await prisma.$queryRawUnsafe<{ cnt: bigint }[]>(`SELECT COUNT(*) as cnt FROM ${table} WHERE symbol = ?`, symbol)
    : await prisma.$queryRawUnsafe<{ cnt: bigint }[]>(`SELECT COUNT(*) as cnt FROM ${table}`);
  return Number(rows[0]?.cnt ?? 0);
}

/**
 * Query rows from a backtest table. Pass values via `params` (bound as `?`
 * placeholders) rather than interpolating them into `sql` — keeps queries
 * injection-safe.
 */
export async function queryRows(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  await ensureBacktestTables();
  return prisma.$queryRawUnsafe(sql, ...params);
}

/** Execute a statement (INSERT, DELETE, etc.). Use `params` for bound values. */
export async function execute(sql: string, params: unknown[] = []): Promise<void> {
  await ensureBacktestTables();
  await prisma.$executeRawUnsafe(sql, ...params);
}

/** Get row counts per symbol for a table (batch — 1 query instead of N) */
export async function getSymbolCounts(table: string): Promise<Map<string, number>> {
  await ensureBacktestTables();
  assertTable(table);
  const rows = await prisma.$queryRawUnsafe<{ symbol: string; cnt: bigint }[]>(
    `SELECT symbol, COUNT(*) as cnt FROM ${table} GROUP BY symbol`,
  );
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.symbol, Number(r.cnt));
  return map;
}

/** Get (symbol, date) pairs that have data — for per-trade status checks */
export async function getSymbolDatePairs(table: string): Promise<Set<string>> {
  await ensureBacktestTables();
  assertTable(table);
  const rows = await prisma.$queryRawUnsafe<{ symbol: string; date: string }[]>(
    `SELECT DISTINCT symbol, date FROM ${table}`,
  );
  const set = new Set<string>();
  for (const r of rows) set.add(`${r.symbol}|${r.date}`);
  return set;
}

/** Get (symbol, option_type, strike, date) tuples that have option data */
export async function getOptionDatePairs(): Promise<Set<string>> {
  await ensureBacktestTables();
  const rows = await prisma.$queryRawUnsafe<{ symbol: string; option_type: string; strike: number; date: string }[]>(
    `SELECT DISTINCT symbol, option_type, CAST(strike AS INTEGER) as strike, date FROM backtest_options`,
  );
  const set = new Set<string>();
  for (const r of rows) set.add(`${r.symbol}|${r.option_type}|${Number(r.strike)}|${r.date}`);
  return set;
}

/**
 * Get `symbol → set of dates that have data` for a backtest table. Like
 * getSymbolDatePairs but keyed by symbol, so callers can count how many of a
 * trade's window dates are present (window coverage), not just whether the
 * trade day exists.
 */
export async function getSymbolDateMap(table: string): Promise<Map<string, Set<string>>> {
  await ensureBacktestTables();
  assertTable(table);
  const rows = await prisma.$queryRawUnsafe<{ symbol: string; date: string }[]>(
    `SELECT DISTINCT symbol, date FROM ${table}`,
  );
  const map = new Map<string, Set<string>>();
  for (const r of rows) {
    let s = map.get(r.symbol);
    if (!s) {
      s = new Set<string>();
      map.set(r.symbol, s);
    }
    s.add(r.date);
  }
  return map;
}

/** Get `symbol|optionType|strike → set of dates` that have option data. */
export async function getOptionDateMap(): Promise<Map<string, Set<string>>> {
  await ensureBacktestTables();
  const rows = await prisma.$queryRawUnsafe<{ symbol: string; option_type: string; strike: number; date: string }[]>(
    `SELECT DISTINCT symbol, option_type, CAST(strike AS INTEGER) as strike, date FROM backtest_options`,
  );
  const map = new Map<string, Set<string>>();
  for (const r of rows) {
    const k = `${r.symbol}|${r.option_type}|${Number(r.strike)}`;
    let s = map.get(k);
    if (!s) {
      s = new Set<string>();
      map.set(k, s);
    }
    s.add(r.date);
  }
  return map;
}

/**
 * Get `symbol → set of dates` with NSE bhavcopy F&O OI data (futures OR option
 * OI present). This is the source behind the Futures-OI / Total-Option-OI charts,
 * filled by the separate Sync button (NOT the per-trade Dhan Download). Returns
 * an empty map if the bhavcopy table is absent.
 */
export async function getBhavcopyDateMap(): Promise<Map<string, Set<string>>> {
  await ensureBacktestTables();
  const map = new Map<string, Set<string>>();
  try {
    const rows = await prisma.$queryRawUnsafe<{ symbol: string; date: string }[]>(
      `SELECT DISTINCT symbol, date FROM bhavcopy_days WHERE COALESCE(futOi, 0) > 0 OR COALESCE(optOi, 0) > 0`,
    );
    for (const r of rows) {
      let s = map.get(r.symbol);
      if (!s) {
        s = new Set<string>();
        map.set(r.symbol, s);
      }
      s.add(r.date);
    }
  } catch {
    // bhavcopy_days table absent — every bhavcopy leg will read as "needs Sync".
  }
  return map;
}

/** Checkpoint — no-op for SQLite (auto-commits) */
export async function checkpoint(): Promise<void> {
  // SQLite auto-commits, no checkpoint needed
}

// ── Per-trade preserved contract IDs ─────────────────────────────────────────

export interface TradeContractIds {
  eqSecurityId: string | null;
  futSecurityId: string | null;
  futExpiry: string | null;
  futLotSize: number | null;
  optSecurityId: string | null;
  optVia: string | null;
  resolvedAt: string;
}

/** Read the preserved contract IDs for a trade (null if never downloaded). */
export async function getTradeContract(
  symbol: string,
  date: string,
  optionType: string,
  strike: number,
): Promise<TradeContractIds | null> {
  await ensureBacktestTables();
  const rows = await prisma.$queryRawUnsafe<
    {
      eq_security_id: string | null;
      fut_security_id: string | null;
      fut_expiry: string | null;
      fut_lot_size: number | null;
      opt_security_id: string | null;
      opt_via: string | null;
      resolved_at: string;
    }[]
  >(
    `SELECT eq_security_id, fut_security_id, fut_expiry, fut_lot_size, opt_security_id, opt_via, resolved_at
     FROM trade_contracts
     WHERE symbol = ? AND date = ? AND option_type = ? AND CAST(strike AS REAL) = ?`,
    symbol,
    date,
    optionType,
    strike,
  );
  const r = rows[0];
  if (!r) return null;
  return {
    eqSecurityId: r.eq_security_id,
    futSecurityId: r.fut_security_id,
    futExpiry: r.fut_expiry,
    futLotSize: r.fut_lot_size != null ? Number(r.fut_lot_size) : null,
    optSecurityId: r.opt_security_id,
    optVia: r.opt_via,
    resolvedAt: r.resolved_at,
  };
}

/** Upsert preserved contract IDs for a trade. Null fields keep existing values. */
export async function upsertTradeContract(
  symbol: string,
  date: string,
  optionType: string,
  strike: number,
  ids: Partial<Omit<TradeContractIds, 'resolvedAt'>>,
): Promise<void> {
  await ensureBacktestTables();
  const existing = await getTradeContract(symbol, date, optionType, strike);
  const m = { ...existing, ...Object.fromEntries(Object.entries(ids).filter(([, v]) => v != null)) };
  await prisma.$executeRawUnsafe(
    `INSERT OR REPLACE INTO trade_contracts
       (symbol, date, option_type, strike, eq_security_id, fut_security_id, fut_expiry, fut_lot_size, opt_security_id, opt_via, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    symbol,
    date,
    optionType,
    strike,
    m.eqSecurityId ?? null,
    m.futSecurityId ?? null,
    m.futExpiry ?? null,
    m.futLotSize != null ? Number(m.futLotSize) : null,
    m.optSecurityId ?? null,
    m.optVia ?? null,
    new Date().toISOString(),
  );
}
