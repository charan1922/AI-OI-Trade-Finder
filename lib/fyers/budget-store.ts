/**
 * Persisted Fyers data-budget counter (one row per IST day). Runtime table,
 * never declared in schema.prisma (house rule: no db push). Read once per
 * process; written at most once a second plus immediately on a latch.
 */
import { prisma } from '@/lib/db';
import type { BudgetState, StoredBudget } from './budget';

let ready = false;

async function ensureTable(): Promise<void> {
  if (ready) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS fyers_data_budget (
      date        TEXT    PRIMARY KEY,
      count       INTEGER NOT NULL DEFAULT 0,
      latchUntil  INTEGER NOT NULL DEFAULT 0,
      latchReason TEXT,
      updatedAt   TEXT    NOT NULL
    )`);
  ready = true;
}

export async function loadStoredBudget(date: string): Promise<StoredBudget | null> {
  await ensureTable();
  const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT date, count, latchUntil, latchReason FROM fyers_data_budget WHERE date = ?`,
    date
  );
  const r = rows[0];
  if (!r) return null;
  return {
    date: String(r.date),
    count: Number(r.count ?? 0),
    latchUntil: Number(r.latchUntil ?? 0),
    latchReason: r.latchReason == null ? null : String(r.latchReason),
  };
}

export async function saveStoredBudget(s: BudgetState): Promise<void> {
  await ensureTable();
  await prisma.$executeRawUnsafe(
    `INSERT INTO fyers_data_budget (date, count, latchUntil, latchReason, updatedAt)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       count = MAX(fyers_data_budget.count, excluded.count),
       latchUntil = excluded.latchUntil,
       latchReason = excluded.latchReason,
       updatedAt = excluded.updatedAt`,
    s.date,
    s.count,
    s.latchUntil,
    s.latchReason,
    new Date().toISOString()
  );
}
