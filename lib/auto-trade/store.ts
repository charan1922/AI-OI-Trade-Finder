/**
 * Auto-trade persistence — three tables, repo derived-table convention (raw
 * CREATE TABLE IF NOT EXISTS via Prisma, mirrored in schema.prisma so
 * `db push` keeps them):
 *
 *   auto_trades    — one row per position lifecycle (proposal → fill → exit)
 *   auto_orders    — every order sent to any broker, idempotency-keyed
 *   auto_decisions — append-only audit of every AI/guard/approval/system pass
 *
 * All updates go through the allowlisted column patch helpers — no dynamic
 * SQL from caller-supplied keys.
 */

import { prisma } from '@/lib/db';
import type { AutoDecision, AutoOrder, AutoTrade, OrderStatus, ToolTraceEntry, TradeStatus } from './types';

let tablesReady = false;

async function ensureTables(): Promise<void> {
  if (tablesReady) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS auto_trades (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      date             TEXT NOT NULL,
      symbol           TEXT NOT NULL,
      direction        TEXT NOT NULL,
      optionType       TEXT NOT NULL,
      strike           REAL NOT NULL,
      expiryDate       TEXT NOT NULL,
      lotSize          INTEGER NOT NULL,
      lots             INTEGER NOT NULL,
      optSecurityId    TEXT NOT NULL,
      mode             TEXT NOT NULL,
      broker           TEXT NOT NULL,
      status           TEXT NOT NULL,
      entrySpot        REAL NOT NULL,
      slSpot           REAL,
      targetSpot       REAL,
      entryPremium     REAL NOT NULL,
      slPremium        REAL NOT NULL,
      targetPremium    REAL NOT NULL,
      entryFillPremium REAL,
      exitFillPremium  REAL,
      exitReason       TEXT,
      aiReasonEntry    TEXT NOT NULL,
      aiReasonExit     TEXT,
      realizedPnlRupees REAL,
      proposedAt       TEXT NOT NULL,
      openedAt         TEXT,
      closedAt         TEXT,
      updatedAt        TEXT NOT NULL
    )
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_auto_trades_date ON auto_trades(date)`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS auto_orders (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      tradeId       INTEGER NOT NULL,
      idemKey       TEXT NOT NULL UNIQUE,
      broker        TEXT NOT NULL,
      mode          TEXT NOT NULL,
      side          TEXT NOT NULL,
      qtyUnits      INTEGER NOT NULL,
      brokerOrderId TEXT,
      status        TEXT NOT NULL,
      avgFillPrice  REAL,
      error         TEXT,
      createdAt     TEXT NOT NULL,
      updatedAt     TEXT NOT NULL
    )
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_auto_orders_trade ON auto_orders(tradeId)`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS auto_decisions (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      date             TEXT NOT NULL,
      at               TEXT NOT NULL,
      pass             TEXT NOT NULL,
      provider         TEXT,
      model            TEXT,
      summary          TEXT NOT NULL,
      toolTrace        TEXT NOT NULL DEFAULT '[]',
      promptTokens     INTEGER,
      completionTokens INTEGER
    )
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_auto_decisions_date ON auto_decisions(date)`);
  tablesReady = true;
}

// ─── Trades ──────────────────────────────────────────────────────────────────

/** Statuses that consume a slot in the daily/lot/capital caps. rejected /
 *  expired / failed never held a position and never count. */
const COUNTED_STATUSES: TradeStatus[] = ['pending_approval', 'open', 'closed'];

export interface NewTrade {
  date: string;
  symbol: string;
  direction: 'bullish' | 'bearish';
  optionType: 'CE' | 'PE';
  strike: number;
  expiryDate: string;
  lotSize: number;
  lots: number;
  optSecurityId: string;
  mode: AutoTrade['mode'];
  broker: string;
  status: TradeStatus;
  entrySpot: number;
  slSpot: number | null;
  targetSpot: number | null;
  entryPremium: number;
  slPremium: number;
  targetPremium: number;
  aiReasonEntry: string;
}

export async function insertTrade(t: NewTrade): Promise<number> {
  await ensureTables();
  const now = new Date().toISOString();
  await prisma.$executeRawUnsafe(
    `INSERT INTO auto_trades (
       date, symbol, direction, optionType, strike, expiryDate, lotSize, lots,
       optSecurityId, mode, broker, status, entrySpot, slSpot, targetSpot,
       entryPremium, slPremium, targetPremium, aiReasonEntry, proposedAt, updatedAt
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    t.date, t.symbol, t.direction, t.optionType, t.strike, t.expiryDate, t.lotSize, t.lots,
    t.optSecurityId, t.mode, t.broker, t.status, t.entrySpot, t.slSpot, t.targetSpot,
    t.entryPremium, t.slPremium, t.targetPremium, t.aiReasonEntry, now, now,
  );
  const rows = (await prisma.$queryRawUnsafe(`SELECT last_insert_rowid() AS id`)) as { id: number | bigint }[];
  return Number(rows[0]?.id ?? 0);
}

/** Allowlisted patchable columns — updateTrade rejects anything else. */
const TRADE_PATCH_COLUMNS = new Set([
  'status', 'slSpot', 'slPremium', 'targetPremium', 'entryFillPremium', 'exitFillPremium',
  'exitReason', 'aiReasonExit', 'realizedPnlRupees', 'openedAt', 'closedAt',
]);

export async function updateTrade(
  id: number,
  patch: Partial<Pick<AutoTrade,
    'status' | 'slSpot' | 'slPremium' | 'targetPremium' | 'entryFillPremium' | 'exitFillPremium' |
    'exitReason' | 'aiReasonExit' | 'realizedPnlRupees' | 'openedAt' | 'closedAt'>>,
): Promise<void> {
  await ensureTables();
  const keys = Object.keys(patch).filter((k) => TRADE_PATCH_COLUMNS.has(k));
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => (patch as Record<string, unknown>)[k] as string | number | null);
  await prisma.$executeRawUnsafe(
    `UPDATE auto_trades SET ${sets}, updatedAt = ? WHERE id = ?`,
    ...values,
    new Date().toISOString(),
    id,
  );
}

function rowToTrade(r: Record<string, unknown>): AutoTrade {
  return {
    ...(r as unknown as AutoTrade),
    id: Number(r.id),
    strike: Number(r.strike),
    lotSize: Number(r.lotSize),
    lots: Number(r.lots),
    entrySpot: Number(r.entrySpot),
    slSpot: r.slSpot == null ? null : Number(r.slSpot),
    targetSpot: r.targetSpot == null ? null : Number(r.targetSpot),
    entryPremium: Number(r.entryPremium),
    slPremium: Number(r.slPremium),
    targetPremium: Number(r.targetPremium),
    entryFillPremium: r.entryFillPremium == null ? null : Number(r.entryFillPremium),
    exitFillPremium: r.exitFillPremium == null ? null : Number(r.exitFillPremium),
    realizedPnlRupees: r.realizedPnlRupees == null ? null : Number(r.realizedPnlRupees),
  };
}

export async function getTrade(id: number): Promise<AutoTrade | null> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(`SELECT * FROM auto_trades WHERE id = ?`, id)) as Record<string, unknown>[];
  return rows.length > 0 ? rowToTrade(rows[0]) : null;
}

export async function getTradesByDate(date: string): Promise<AutoTrade[]> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT * FROM auto_trades WHERE date = ? ORDER BY id DESC`, date,
  )) as Record<string, unknown>[];
  return rows.map(rowToTrade);
}

export async function getOpenTrades(): Promise<AutoTrade[]> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT * FROM auto_trades WHERE status = 'open' ORDER BY id ASC`,
  )) as Record<string, unknown>[];
  return rows.map(rowToTrade);
}

export async function getPendingApprovals(date: string): Promise<AutoTrade[]> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT * FROM auto_trades WHERE date = ? AND status = 'pending_approval' ORDER BY id ASC`, date,
  )) as Record<string, unknown>[];
  return rows.map(rowToTrade);
}

/** Entries that consume the daily cap (pending counts — it reserves a slot). */
export async function countEntriesToday(date: string): Promise<number> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT COUNT(*) AS n FROM auto_trades WHERE date = ? AND status IN ('${COUNTED_STATUSES.join("','")}')`,
    date,
  )) as { n: number | bigint }[];
  return Number(rows[0]?.n ?? 0);
}

/** True when the symbol already consumed a slot today (no re-entry rule). */
export async function symbolTradedToday(date: string, symbol: string): Promise<boolean> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT 1 FROM auto_trades WHERE date = ? AND symbol = ? AND status IN ('${COUNTED_STATUSES.join("','")}') LIMIT 1`,
    date, symbol,
  )) as unknown[];
  return rows.length > 0;
}

/** Lots + premium ₹ currently reserved (open + pending-approval positions). */
export async function getExposure(date: string): Promise<{ openLots: number; deployedRupees: number }> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT
       COALESCE(SUM(lots), 0) AS lots,
       COALESCE(SUM(COALESCE(entryFillPremium, entryPremium) * lotSize * lots), 0) AS rupees
     FROM auto_trades WHERE date = ? AND status IN ('open', 'pending_approval')`,
    date,
  )) as { lots: number | bigint; rupees: number }[];
  return { openLots: Number(rows[0]?.lots ?? 0), deployedRupees: Math.round(Number(rows[0]?.rupees ?? 0)) };
}

/** Realized P&L booked today (closed trades with both fills known). */
export async function dailyRealizedPnl(date: string): Promise<number> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT COALESCE(SUM(realizedPnlRupees), 0) AS pnl FROM auto_trades
      WHERE date = ? AND status = 'closed' AND realizedPnlRupees IS NOT NULL`,
    date,
  )) as { pnl: number }[];
  return Math.round(Number(rows[0]?.pnl ?? 0));
}

// ─── Orders ──────────────────────────────────────────────────────────────────

export async function insertOrder(o: {
  tradeId: number;
  idemKey: string;
  broker: string;
  mode: AutoTrade['mode'];
  side: AutoOrder['side'];
  qtyUnits: number;
  brokerOrderId: string | null;
  status: OrderStatus;
  avgFillPrice: number | null;
  error: string | null;
}): Promise<number> {
  await ensureTables();
  const now = new Date().toISOString();
  await prisma.$executeRawUnsafe(
    `INSERT INTO auto_orders (tradeId, idemKey, broker, mode, side, qtyUnits, brokerOrderId, status, avgFillPrice, error, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    o.tradeId, o.idemKey, o.broker, o.mode, o.side, o.qtyUnits, o.brokerOrderId, o.status, o.avgFillPrice, o.error, now, now,
  );
  const rows = (await prisma.$queryRawUnsafe(`SELECT last_insert_rowid() AS id`)) as { id: number | bigint }[];
  return Number(rows[0]?.id ?? 0);
}

export async function updateOrder(
  id: number,
  patch: { brokerOrderId?: string | null; status?: OrderStatus; avgFillPrice?: number | null; error?: string | null },
): Promise<void> {
  await ensureTables();
  const allowed = new Set(['brokerOrderId', 'status', 'avgFillPrice', 'error']);
  const keys = Object.keys(patch).filter((k) => allowed.has(k));
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => (patch as Record<string, unknown>)[k] as string | number | null);
  await prisma.$executeRawUnsafe(
    `UPDATE auto_orders SET ${sets}, updatedAt = ? WHERE id = ?`,
    ...values,
    new Date().toISOString(),
    id,
  );
}

/** True when an order for this idempotency key already exists and is not in a
 *  terminal-failure state — the caller must NOT place again. */
export async function orderExistsForKey(idemKey: string): Promise<boolean> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT 1 FROM auto_orders WHERE idemKey = ? AND status NOT IN ('rejected', 'cancelled') LIMIT 1`,
    idemKey,
  )) as unknown[];
  return rows.length > 0;
}

/** Orders sent to a live broker whose fill state is still unresolved. */
export async function getUnresolvedOrders(): Promise<AutoOrder[]> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT * FROM auto_orders WHERE status IN ('sent', 'unknown') ORDER BY id ASC`,
  )) as Record<string, unknown>[];
  return rows.map((r) => ({
    ...(r as unknown as AutoOrder),
    id: Number(r.id),
    tradeId: Number(r.tradeId),
    qtyUnits: Number(r.qtyUnits),
    avgFillPrice: r.avgFillPrice == null ? null : Number(r.avgFillPrice),
  }));
}

export async function getOrdersForTrade(tradeId: number): Promise<AutoOrder[]> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT * FROM auto_orders WHERE tradeId = ? ORDER BY id ASC`, tradeId,
  )) as Record<string, unknown>[];
  return rows.map((r) => ({
    ...(r as unknown as AutoOrder),
    id: Number(r.id),
    tradeId: Number(r.tradeId),
    qtyUnits: Number(r.qtyUnits),
    avgFillPrice: r.avgFillPrice == null ? null : Number(r.avgFillPrice),
  }));
}

// ─── Decisions (append-only audit) ───────────────────────────────────────────

export async function insertDecision(d: {
  date: string;
  pass: AutoDecision['pass'];
  provider: string | null;
  model: string | null;
  summary: string;
  toolTrace: ToolTraceEntry[];
  promptTokens: number | null;
  completionTokens: number | null;
}): Promise<void> {
  await ensureTables();
  await prisma.$executeRawUnsafe(
    `INSERT INTO auto_decisions (date, at, pass, provider, model, summary, toolTrace, promptTokens, completionTokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    d.date, new Date().toISOString(), d.pass, d.provider, d.model,
    d.summary, JSON.stringify(d.toolTrace), d.promptTokens, d.completionTokens,
  );
}

export async function getDecisions(date: string, limit = 30): Promise<AutoDecision[]> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT * FROM auto_decisions WHERE date = ? ORDER BY id DESC LIMIT ?`, date, limit,
  )) as Record<string, unknown>[];
  return rows.map((r) => ({
    ...(r as unknown as AutoDecision),
    id: Number(r.id),
    promptTokens: r.promptTokens == null ? null : Number(r.promptTokens),
    completionTokens: r.completionTokens == null ? null : Number(r.completionTokens),
  }));
}
