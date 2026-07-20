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
import { correlationIdForOrder } from './brokers/adapter';
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
  // Would-have (shadow) figures for failed entries — backfilled from real
  // candles, display-only (see types.ts AutoTrade).
  const tradeColumns = (await prisma.$queryRawUnsafe(`PRAGMA table_info(auto_trades)`)) as { name: string }[];
  const existingTradeColumns = new Set(tradeColumns.map((c) => c.name));
  for (const col of [
    'shadowEntryPremium REAL',
    'shadowExitPremium REAL',
    'shadowExitReason TEXT',
    'shadowPnlRupees REAL',
    // Quant SHADOW metrics — recorded on real trades to MEASURE the entry/exit
    // quality the doc calls out (late-chase, giveback, weak sector). Pure
    // observation: nothing here gates or changes a live entry/exit. Calibrate
    // thresholds from these on recorded days before any of them becomes a gate.
    'entryFreshSpot REAL', // underlying spot at the placement moment
    'entryChangePctOpen REAL', // how far the stock had run from the day's open at entry (late-chase signal)
    'entryProgressR REAL', // (freshSpot − plannedEntry)/plannedRisk, signed for direction (intra-cycle drift)
    'entryRemainingRewardR REAL', // (plannedTarget − freshSpot)/plannedRisk, signed (forward reward left at real entry)
    'entrySectorRank INTEGER', // pick's sector rank by OI activity among all scanned sectors (1 = most active)
    'entrySectorCount INTEGER', // how many sectors were ranked this scan
    'shadowMfeR REAL', // max FAVORABLE spot excursion in R over the hold (giveback measurement)
    'shadowMaeR REAL', // max ADVERSE spot excursion in R over the hold
    // Re-anchor-at-placement shadow (lib/auto-trade/quant/reanchor.ts): what a
    // plan rebuilt from fresh candles at the fill moment WOULD look like, and the
    // forward reward:risk to the STORED target at the fresh entry (doc §7/§14).
    'entryForwardRR REAL', // (storedTarget − freshSpot)/(freshSpot − storedStop): <1 = late chase
    'entryFreshSlSpot REAL', // stop a rebuild at placement would set (vs stored slSpot → drift)
    'entryFreshTargetSpot REAL', // target a rebuild at placement would set
  ]) {
    if (!existingTradeColumns.has(col.split(' ')[0]))
      await prisma.$executeRawUnsafe(`ALTER TABLE auto_trades ADD COLUMN ${col}`);
  }
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS auto_orders (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      tradeId       INTEGER NOT NULL,
      idemKey       TEXT NOT NULL UNIQUE,
      broker        TEXT NOT NULL,
      mode          TEXT NOT NULL,
      side          TEXT NOT NULL,
      qtyUnits      INTEGER NOT NULL,
      correlationId TEXT,
      brokerOrderId TEXT,
      status        TEXT NOT NULL,
      avgFillPrice  REAL,
      error         TEXT,
      reconcileAttempts INTEGER NOT NULL DEFAULT 0,
      lastReconciledAt TEXT,
      createdAt     TEXT NOT NULL,
      updatedAt     TEXT NOT NULL
    )
  `);
  const orderColumns = (await prisma.$queryRawUnsafe(`PRAGMA table_info(auto_orders)`)) as { name: string }[];
  const existingOrderColumns = new Set(orderColumns.map((c) => c.name));
  if (!existingOrderColumns.has('correlationId'))
    await prisma.$executeRawUnsafe(`ALTER TABLE auto_orders ADD COLUMN correlationId TEXT`);
  if (!existingOrderColumns.has('reconcileAttempts'))
    await prisma.$executeRawUnsafe(`ALTER TABLE auto_orders ADD COLUMN reconcileAttempts INTEGER NOT NULL DEFAULT 0`);
  if (!existingOrderColumns.has('lastReconciledAt'))
    await prisma.$executeRawUnsafe(`ALTER TABLE auto_orders ADD COLUMN lastReconciledAt TEXT`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_auto_orders_trade ON auto_orders(tradeId)`);
  await prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_auto_orders_broker_correlation
       ON auto_orders(broker, correlationId) WHERE correlationId IS NOT NULL`
  );
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
const COUNTED_STATUSES: TradeStatus[] = ['pending_approval', 'placing', 'open', 'closed'];

/** Statuses that block a SECOND entry attempt for the same symbol today.
 *  Terminal rejected / expired / failed attempts do not burn the daily cap,
 *  but still enforce the one-shot-per-symbol rule and prevent retry storms. */
const SYMBOL_LOCK_STATUSES: TradeStatus[] = [...COUNTED_STATUSES, 'rejected', 'expired', 'failed'];

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

export async function insertTrade(t: NewTrade): Promise<number | null> {
  await ensureTables();
  const now = new Date().toISOString();
  const rows = (await prisma.$queryRawUnsafe(
    `INSERT INTO auto_trades (
       date, symbol, direction, optionType, strike, expiryDate, lotSize, lots,
       optSecurityId, mode, broker, status, entrySpot, slSpot, targetSpot,
       entryPremium, slPremium, targetPremium, aiReasonEntry, proposedAt, updatedAt
     )
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM auto_trades
        WHERE date = ? AND symbol = ?
          AND status IN ('${SYMBOL_LOCK_STATUSES.join("','")}')
     )
     RETURNING id`,
    t.date,
    t.symbol,
    t.direction,
    t.optionType,
    t.strike,
    t.expiryDate,
    t.lotSize,
    t.lots,
    t.optSecurityId,
    t.mode,
    t.broker,
    t.status,
    t.entrySpot,
    t.slSpot,
    t.targetSpot,
    t.entryPremium,
    t.slPremium,
    t.targetPremium,
    t.aiReasonEntry,
    now,
    now,
    t.date,
    t.symbol
  )) as { id: number | bigint }[];
  return rows[0] == null ? null : Number(rows[0].id);
}

/** Allowlisted patchable columns — updateTrade rejects anything else. */
const TRADE_PATCH_COLUMNS = new Set([
  'status',
  'slSpot',
  'slPremium',
  'targetPremium',
  'entryFillPremium',
  'exitFillPremium',
  'exitReason',
  'aiReasonExit',
  'realizedPnlRupees',
  'openedAt',
  'closedAt',
]);

export async function updateTrade(
  id: number,
  patch: Partial<
    Pick<
      AutoTrade,
      | 'status'
      | 'slSpot'
      | 'slPremium'
      | 'targetPremium'
      | 'entryFillPremium'
      | 'exitFillPremium'
      | 'exitReason'
      | 'aiReasonExit'
      | 'realizedPnlRupees'
      | 'openedAt'
      | 'closedAt'
    >
  >
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
    id
  );
}

/** Entry-time quant SHADOW snapshot (allowlisted columns). Written best-effort
 *  right after a trade is inserted; a failure here must never affect the trade.
 *  Pure measurement — none of these fields gates or alters a live entry. */
const ENTRY_QUANT_COLUMNS = new Set([
  'entryFreshSpot',
  'entryChangePctOpen',
  'entryProgressR',
  'entryRemainingRewardR',
  'entrySectorRank',
  'entrySectorCount',
  'entryForwardRR',
  'entryFreshSlSpot',
  'entryFreshTargetSpot',
]);

export async function recordEntryQuant(
  id: number,
  metrics: Partial<
    Pick<
      AutoTrade,
      | 'entryFreshSpot'
      | 'entryChangePctOpen'
      | 'entryProgressR'
      | 'entryRemainingRewardR'
      | 'entrySectorRank'
      | 'entrySectorCount'
      | 'entryForwardRR'
      | 'entryFreshSlSpot'
      | 'entryFreshTargetSpot'
    >
  >
): Promise<void> {
  await ensureTables();
  const keys = Object.keys(metrics).filter(
    (k) => ENTRY_QUANT_COLUMNS.has(k) && (metrics as Record<string, unknown>)[k] != null
  );
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => (metrics as Record<string, unknown>)[k] as number);
  await prisma.$executeRawUnsafe(`UPDATE auto_trades SET ${sets} WHERE id = ?`, ...values, id);
}

/** Update the running max favorable / adverse excursion (in spot-R) for an open
 *  trade. Monotonic: mfeR only rises, maeR only falls. Guard-driven SHADOW
 *  measurement of giveback — never triggers an exit or moves a stop. */
export async function updateShadowExcursion(id: number, mfeR: number | null, maeR: number | null): Promise<void> {
  await ensureTables();
  if (mfeR == null && maeR == null) return;
  const parts: string[] = [];
  const values: number[] = [];
  if (mfeR != null) {
    parts.push('shadowMfeR = MAX(COALESCE(shadowMfeR, -1e9), ?)');
    values.push(mfeR);
  }
  if (maeR != null) {
    parts.push('shadowMaeR = MIN(COALESCE(shadowMaeR, 1e9), ?)');
    values.push(maeR);
  }
  await prisma.$executeRawUnsafe(`UPDATE auto_trades SET ${parts.join(', ')} WHERE id = ?`, ...values, id);
}

/** Atomic lifecycle transition. Exactly one concurrent caller can own a
 * pending approval or other state hand-off. */
export async function transitionTradeStatus(
  id: number,
  expected: TradeStatus,
  next: TradeStatus,
  exitReason: string | null = null
): Promise<boolean> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(
    `UPDATE auto_trades
       SET status = ?, exitReason = COALESCE(?, exitReason), updatedAt = ?
     WHERE id = ? AND status = ?
     RETURNING id`,
    next,
    exitReason,
    new Date().toISOString(),
    id,
    expected
  )) as { id: number | bigint }[];
  return rows.length === 1;
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
    shadowEntryPremium: r.shadowEntryPremium == null ? null : Number(r.shadowEntryPremium),
    shadowExitPremium: r.shadowExitPremium == null ? null : Number(r.shadowExitPremium),
    shadowExitReason: r.shadowExitReason == null ? null : String(r.shadowExitReason),
    shadowPnlRupees: r.shadowPnlRupees == null ? null : Number(r.shadowPnlRupees),
    entryFreshSpot: r.entryFreshSpot == null ? null : Number(r.entryFreshSpot),
    entryChangePctOpen: r.entryChangePctOpen == null ? null : Number(r.entryChangePctOpen),
    entryProgressR: r.entryProgressR == null ? null : Number(r.entryProgressR),
    entryRemainingRewardR: r.entryRemainingRewardR == null ? null : Number(r.entryRemainingRewardR),
    entrySectorRank: r.entrySectorRank == null ? null : Number(r.entrySectorRank),
    entrySectorCount: r.entrySectorCount == null ? null : Number(r.entrySectorCount),
    shadowMfeR: r.shadowMfeR == null ? null : Number(r.shadowMfeR),
    shadowMaeR: r.shadowMaeR == null ? null : Number(r.shadowMaeR),
    entryForwardRR: r.entryForwardRR == null ? null : Number(r.entryForwardRR),
    entryFreshSlSpot: r.entryFreshSlSpot == null ? null : Number(r.entryFreshSlSpot),
    entryFreshTargetSpot: r.entryFreshTargetSpot == null ? null : Number(r.entryFreshTargetSpot),
  };
}

export async function getTrade(id: number): Promise<AutoTrade | null> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(`SELECT * FROM auto_trades WHERE id = ?`, id)) as Record<
    string,
    unknown
  >[];
  return rows.length > 0 ? rowToTrade(rows[0]) : null;
}

export async function getTradesByDate(date: string): Promise<AutoTrade[]> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT * FROM auto_trades WHERE date = ? ORDER BY id DESC`,
    date
  )) as Record<string, unknown>[];
  return rows.map(rowToTrade);
}

/** Distinct dates that have at least one auto-trade, newest first — the date
 *  dropdown for the EOD history page. Read-only. */
export async function getAutoTradeDates(): Promise<string[]> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT DISTINCT date FROM auto_trades ORDER BY date DESC`
  )) as { date: string }[];
  return rows.map((r) => r.date);
}

export async function getOpenTrades(): Promise<AutoTrade[]> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT * FROM auto_trades WHERE status = 'open' ORDER BY id ASC`
  )) as Record<string, unknown>[];
  return rows.map(rowToTrade);
}

/** Positions plus entries whose broker state is unresolved. Used for priority
 * candles and operational visibility; only `open` rows may be sold. */
export async function getRiskBearingTrades(): Promise<AutoTrade[]> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT * FROM auto_trades WHERE status IN ('placing', 'open') ORDER BY id ASC`
  )) as Record<string, unknown>[];
  return rows.map(rowToTrade);
}

export async function getPendingApprovals(date: string): Promise<AutoTrade[]> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT * FROM auto_trades WHERE date = ? AND status = 'pending_approval' ORDER BY id ASC`,
    date
  )) as Record<string, unknown>[];
  return rows.map(rowToTrade);
}

/** Entries that consume the daily cap (pending counts — it reserves a slot). */
export async function countEntriesToday(date: string): Promise<number> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT COUNT(*) AS n FROM auto_trades WHERE date = ? AND status IN ('${COUNTED_STATUSES.join("','")}')`,
    date
  )) as { n: number | bigint }[];
  return Number(rows[0]?.n ?? 0);
}

/** True when the symbol already consumed a slot today (no re-entry rule). */
export async function symbolTradedToday(date: string, symbol: string): Promise<boolean> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT 1 FROM auto_trades WHERE date = ? AND symbol = ? AND status IN ('${SYMBOL_LOCK_STATUSES.join("','")}') LIMIT 1`,
    date,
    symbol
  )) as unknown[];
  return rows.length > 0;
}

/** Lots + premium ₹ reserved by pending, placing, and filled positions. */
export async function getExposure(date: string): Promise<{ openLots: number; deployedRupees: number }> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT
       COALESCE(SUM(lots), 0) AS lots,
       COALESCE(SUM(COALESCE(entryFillPremium, entryPremium) * lotSize * lots), 0) AS rupees
     FROM auto_trades WHERE date = ? AND status IN ('open', 'placing', 'pending_approval')`,
    date
  )) as { lots: number | bigint; rupees: number }[];
  return {
    openLots: Number(rows[0]?.lots ?? 0),
    deployedRupees: Math.round(Number(rows[0]?.rupees ?? 0)),
  };
}

/** Realized P&L booked today (closed trades with both fills known). */
export async function dailyRealizedPnl(date: string): Promise<number> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT COALESCE(SUM(realizedPnlRupees), 0) AS pnl FROM auto_trades
      WHERE date = ? AND status = 'closed' AND realizedPnlRupees IS NOT NULL`,
    date
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
  correlationId: string | null;
  brokerOrderId: string | null;
  status: OrderStatus;
  avgFillPrice: number | null;
  error: string | null;
}): Promise<number> {
  await ensureTables();
  const now = new Date().toISOString();
  await prisma.$executeRawUnsafe(
    `INSERT INTO auto_orders (tradeId, idemKey, broker, mode, side, qtyUnits, correlationId, brokerOrderId, status, avgFillPrice, error, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    o.tradeId,
    o.idemKey,
    o.broker,
    o.mode,
    o.side,
    o.qtyUnits,
    o.correlationId,
    o.brokerOrderId,
    o.status,
    o.avgFillPrice,
    o.error,
    now,
    now
  );
  const rows = (await prisma.$queryRawUnsafe(`SELECT last_insert_rowid() AS id`)) as { id: number | bigint }[];
  return Number(rows[0]?.id ?? 0);
}

/** Atomically claim a BUY order. A duplicate idemKey or broker correlation ID
 * returns null and never reaches the broker. */
export async function claimEntryOrder(o: Parameters<typeof insertOrder>[0]): Promise<number | null> {
  await ensureTables();
  const now = new Date().toISOString();
  const rows = (await prisma.$queryRawUnsafe(
    `INSERT INTO auto_orders
       (tradeId, idemKey, broker, mode, side, qtyUnits, correlationId,
        brokerOrderId, status, avgFillPrice, error, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    o.tradeId,
    o.idemKey,
    o.broker,
    o.mode,
    o.side,
    o.qtyUnits,
    o.correlationId,
    o.brokerOrderId,
    o.status,
    o.avgFillPrice,
    o.error,
    now,
    now
  )) as { id: number | bigint }[];
  return rows[0] == null ? null : Number(rows[0].id);
}

/**
 * Atomically claim the next SELL attempt for a trade.
 *
 * Exit retries need a new idempotency key after a rejected/cancelled order,
 * while concurrent guard/AI callers must never both reach the broker.
 *
 * The correlationId MUST be persisted inside the claim INSERT itself: a crash
 * between the claim and the broker POST used to leave a `sent` order with no
 * tag — unrecoverable from the order book and permanently blocking every
 * future exit attempt. The attempt number is read first so the idemKey (and
 * its derived correlationId) is known before the insert; a concurrent claim
 * that lands in between produces the same numbered key and loses on the
 * UNIQUE constraint (ON CONFLICT DO NOTHING), so at most one caller gets a row.
 */
export async function claimExitOrder(o: {
  tradeId: number;
  idemKeyBase: string;
  broker: string;
  mode: AutoTrade['mode'];
  qtyUnits: number;
}): Promise<{ id: number; idemKey: string; correlationId: string } | null> {
  await ensureTables();
  const now = new Date().toISOString();
  const countRows = (await prisma.$queryRawUnsafe(
    `SELECT COUNT(*) AS n FROM auto_orders WHERE tradeId = ? AND side = 'SELL'`,
    o.tradeId
  )) as { n: number | bigint }[];
  const idemKey = `${o.idemKeyBase}:attempt:${Number(countRows[0]?.n ?? 0) + 1}`;
  const correlationId = correlationIdForOrder(idemKey);
  const rows = (await prisma.$queryRawUnsafe(
    `INSERT INTO auto_orders
       (tradeId, idemKey, broker, mode, side, qtyUnits, correlationId, brokerOrderId, status, avgFillPrice, error, createdAt, updatedAt)
     SELECT ?, ?, ?, ?, 'SELL', ?, ?, NULL, 'sent', NULL, NULL, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM auto_orders
        WHERE tradeId = ? AND side = 'SELL' AND status NOT IN ('rejected', 'cancelled')
     )
     ON CONFLICT DO NOTHING
     RETURNING id, idemKey, correlationId`,
    o.tradeId,
    idemKey,
    o.broker,
    o.mode,
    o.qtyUnits,
    correlationId,
    now,
    now,
    o.tradeId
  )) as { id: number | bigint; idemKey: string; correlationId: string }[];
  const row = rows[0];
  return row ? { id: Number(row.id), idemKey: row.idemKey, correlationId: row.correlationId } : null;
}

export async function updateOrder(
  id: number,
  patch: {
    correlationId?: string | null;
    brokerOrderId?: string | null;
    status?: OrderStatus;
    avgFillPrice?: number | null;
    error?: string | null;
    lastReconciledAt?: string | null;
  }
): Promise<void> {
  await ensureTables();
  const allowed = new Set(['brokerOrderId', 'status', 'avgFillPrice', 'error']);
  allowed.add('correlationId');
  allowed.add('lastReconciledAt');
  const keys = Object.keys(patch).filter((k) => allowed.has(k));
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => (patch as Record<string, unknown>)[k] as string | number | null);
  await prisma.$executeRawUnsafe(
    `UPDATE auto_orders SET ${sets}, updatedAt = ? WHERE id = ?`,
    ...values,
    new Date().toISOString(),
    id
  );
}

/** Stamp one reconciliation attempt without resetting the order's creation
 * time (createdAt is the pending-order SLA anchor). */
export async function markOrderReconciled(id: number, error?: string | null): Promise<void> {
  await ensureTables();
  await prisma.$executeRawUnsafe(
    `UPDATE auto_orders
       SET reconcileAttempts = reconcileAttempts + 1,
           lastReconciledAt = ?,
           error = COALESCE(?, error),
           updatedAt = ?
     WHERE id = ?`,
    new Date().toISOString(),
    error ?? null,
    new Date().toISOString(),
    id
  );
}

/** True when an order for this idempotency key already exists and is not in a
 *  terminal-failure state — the caller must NOT place again. */
export async function orderExistsForKey(idemKey: string): Promise<boolean> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT 1 FROM auto_orders WHERE idemKey = ? AND status NOT IN ('rejected', 'cancelled') LIMIT 1`,
    idemKey
  )) as unknown[];
  return rows.length > 0;
}

/** Orders sent to a live broker whose fill state is still unresolved. */
export async function getUnresolvedOrders(): Promise<AutoOrder[]> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT * FROM auto_orders WHERE status IN ('sent', 'unknown') ORDER BY id ASC`
  )) as Record<string, unknown>[];
  return rows.map((r) => ({
    ...(r as unknown as AutoOrder),
    id: Number(r.id),
    tradeId: Number(r.tradeId),
    qtyUnits: Number(r.qtyUnits),
    avgFillPrice: r.avgFillPrice == null ? null : Number(r.avgFillPrice),
    reconcileAttempts: Number(r.reconcileAttempts ?? 0),
    lastReconciledAt: r.lastReconciledAt == null ? null : String(r.lastReconciledAt),
  }));
}

export async function getOrdersForTrade(tradeId: number): Promise<AutoOrder[]> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT * FROM auto_orders WHERE tradeId = ? ORDER BY id ASC`,
    tradeId
  )) as Record<string, unknown>[];
  return rows.map((r) => ({
    ...(r as unknown as AutoOrder),
    id: Number(r.id),
    tradeId: Number(r.tradeId),
    qtyUnits: Number(r.qtyUnits),
    avgFillPrice: r.avgFillPrice == null ? null : Number(r.avgFillPrice),
    reconcileAttempts: Number(r.reconcileAttempts ?? 0),
    lastReconciledAt: r.lastReconciledAt == null ? null : String(r.lastReconciledAt),
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
    d.date,
    new Date().toISOString(),
    d.pass,
    d.provider,
    d.model,
    d.summary,
    JSON.stringify(d.toolTrace),
    d.promptTokens,
    d.completionTokens
  );
}

export async function getDecisions(date: string, limit = 30): Promise<AutoDecision[]> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT * FROM auto_decisions WHERE date = ? ORDER BY id DESC LIMIT ?`,
    date,
    limit
  )) as Record<string, unknown>[];
  return rows.map((r) => ({
    ...(r as unknown as AutoDecision),
    id: Number(r.id),
    promptTokens: r.promptTokens == null ? null : Number(r.promptTokens),
    completionTokens: r.completionTokens == null ? null : Number(r.completionTokens),
  }));
}
