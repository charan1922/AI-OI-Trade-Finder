/**
 * Latest retest watch-list per day, written by each scan so /trade-commentary can
 * show it without re-running the selector. Runtime table (house rule: no db push).
 */
import { prisma } from '@/lib/db';
import type { RetestWatchItem, RetestWindow } from './retest';

export interface RetestMeta {
  window: RetestWindow;
  targetR: number;
}

let ready = false;

async function ensureTable(): Promise<void> {
  if (ready) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS ob_retest_watchlist (
      date      TEXT PRIMARY KEY,
      asOf      TEXT NOT NULL,
      itemsJson TEXT NOT NULL,
      metaJson  TEXT
    )`);
  ready = true;
}

export async function saveRetestWatchlist(
  date: string,
  items: readonly RetestWatchItem[],
  meta: RetestMeta,
  asOf = new Date()
): Promise<void> {
  await ensureTable();
  await prisma.$executeRawUnsafe(
    `INSERT INTO ob_retest_watchlist (date, asOf, itemsJson, metaJson) VALUES (?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET asOf = excluded.asOf, itemsJson = excluded.itemsJson, metaJson = excluded.metaJson`,
    date,
    asOf.toISOString(),
    JSON.stringify(items),
    JSON.stringify(meta)
  );
}

export async function loadRetestWatchlist(
  date: string
): Promise<{ asOf: string; items: RetestWatchItem[]; meta: RetestMeta | null } | null> {
  await ensureTable();
  const rows = await prisma.$queryRawUnsafe<{ asOf: string; itemsJson: string; metaJson: string | null }[]>(
    `SELECT asOf, itemsJson, metaJson FROM ob_retest_watchlist WHERE date = ?`,
    date
  );
  if (!rows[0]) return null;
  try {
    return {
      asOf: rows[0].asOf,
      items: JSON.parse(rows[0].itemsJson) as RetestWatchItem[],
      meta: rows[0].metaJson ? (JSON.parse(rows[0].metaJson) as RetestMeta) : null,
    };
  } catch {
    return null;
  }
}
