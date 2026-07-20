/**
 * Persistent "done for today" markers — survive process restart and rolling
 * deploys, unlike an in-memory flag. For once-per-day poller side-effects
 * (e.g. the pre-open config-drift reminder) that must fire AT MOST once per
 * calendar day even if the box restarts mid-window (PR#2 review 2026-07-20).
 *
 * Repo derived-table convention: raw CREATE TABLE IF NOT EXISTS, mirrored by
 * the RuntimeDailyMarker model in schema.prisma so `db push` keeps it. Created
 * lazily on first use. All reads/writes are best-effort — a DB hiccup must
 * never break the caller (wasMarkedToday fails OPEN → the caller re-checks its
 * own idempotency; markToday just logs).
 */
import { prisma } from '@/lib/db';

let tableReady = false;

async function ensureTable(): Promise<void> {
  if (tableReady) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS runtime_daily_markers (
      name      TEXT PRIMARY KEY,
      day       TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )
  `);
  tableReady = true;
}

/** True when `name` has already been marked done for `day` (YYYY-MM-DD). */
export async function wasMarkedToday(name: string, day: string): Promise<boolean> {
  try {
    await ensureTable();
    const rows = (await prisma.$queryRawUnsafe(`SELECT day FROM runtime_daily_markers WHERE name = ?`, name)) as {
      day: string;
    }[];
    return rows[0]?.day === day;
  } catch {
    return false; // fail open — caller decides; a duplicate is safer than a silent miss
  }
}

/** Mark `name` done for `day`. Call only AFTER the side-effect succeeded, so a
 *  failed attempt is retried on the next tick. */
export async function markToday(name: string, day: string): Promise<void> {
  try {
    await ensureTable();
    await prisma.$executeRawUnsafe(
      `INSERT INTO runtime_daily_markers (name, day, updatedAt) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET day = excluded.day, updatedAt = excluded.updatedAt`,
      name,
      day,
      new Date().toISOString()
    );
  } catch (err) {
    console.warn(`[DailyMarker] ${name} write failed: ${(err as Error).message}`);
  }
}
