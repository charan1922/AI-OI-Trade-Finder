/**
 * Backtest (vectorbt) store — ISOLATED `bt_*` tables.
 *
 * Separate from `backtest_equity/futures/options` and `bhavcopy_days` (which are
 * read-only sources). Holds a frozen, per-trade COPY of everything the vectorbt
 * engine needs, so a run is fully self-contained and reproducible:
 *
 *   bt_run    — one row per backtest run (params used)
 *   bt_trade  — one frozen copy of each TF trade (+ resolved lot, gate decision)
 *   bt_candle — per-trade copy of the traded option's 5-min bars (trade day)
 *   bt_signal — per-trade COMBINED-OI signals (from bhavcopy_days, not per-strike)
 *   bt_result — per-trade backtest outcome (filled in after the Python run)
 *
 * Each run replaces the previous one (single live copy) — see resetBt().
 */

import { prisma } from '@/lib/db';

export async function ensureBtTables(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS bt_run (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      gate TEXT NOT NULL,
      gate_threshold REAL NOT NULL,
      profit_target REAL NOT NULL,
      entry_hhmm TEXT NOT NULL,
      trades INTEGER NOT NULL DEFAULT 0,
      taken INTEGER NOT NULL DEFAULT 0,
      notes TEXT
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS bt_trade (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      date TEXT NOT NULL,
      option_type TEXT NOT NULL,
      strike REAL NOT NULL,
      tf_pnl REAL NOT NULL DEFAULT 0,
      lot_size REAL,
      expiry TEXT,
      entry_bar_index INTEGER,
      has_candles INTEGER NOT NULL DEFAULT 0,
      taken INTEGER NOT NULL DEFAULT 0
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS bt_candle (
      trade_id INTEGER NOT NULL,
      bar_index INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      open REAL, high REAL, low REAL, close REAL, volume REAL, oi REAL,
      PRIMARY KEY (trade_id, bar_index)
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS bt_signal (
      trade_id INTEGER PRIMARY KEY,
      fut_oi_level20 REAL,
      opt_oi_level20 REAL,
      fut_oi_change5 REAL,
      opt_oi_change5 REAL,
      opt_vol_surge REAL,
      turnover_vs_avg REAL,
      score INTEGER,
      sessions INTEGER,
      fut_quadrant TEXT,
      fut_bias TEXT,
      opt_flow TEXT,
      direction_agrees INTEGER
    )
  `);
  // Direction columns were added after the table's first release; ALTER for
  // already-created DBs (resetBt only deletes rows, never drops/recreates).
  // SQLite throws on a duplicate column — swallow that and only that.
  for (const col of [
    'fut_quadrant TEXT',
    'fut_bias TEXT',
    'opt_flow TEXT',
    'direction_agrees INTEGER',
  ]) {
    try {
      await prisma.$executeRawUnsafe(`ALTER TABLE bt_signal ADD COLUMN ${col}`);
    } catch {
      // column already exists — expected on existing databases
    }
  }
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS bt_result (
      trade_id INTEGER PRIMARY KEY,
      taken INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      entry_time TEXT,
      entry_price REAL,
      exit_time TEXT,
      exit_price REAL,
      exit_reason TEXT,
      gross_pnl REAL,
      charges REAL,
      net_pnl REAL
    )
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_bt_trade_run ON bt_trade (run_id)`);
}

/** Wipe every bt_* row — each run keeps a single, fresh per-trade copy. */
export async function resetBt(): Promise<void> {
  await ensureBtTables();
  for (const t of ['bt_result', 'bt_signal', 'bt_candle', 'bt_trade', 'bt_run']) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${t}`);
  }
}

export async function btExecute(sql: string, params: unknown[] = []): Promise<void> {
  await prisma.$executeRawUnsafe(sql, ...params);
}

export async function btQuery<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return prisma.$queryRawUnsafe<T[]>(sql, ...params);
}
