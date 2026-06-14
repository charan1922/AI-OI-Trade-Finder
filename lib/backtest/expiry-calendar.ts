/**
 * NSE monthly F&O expiry calendar — authoritative expiry dates (user-provided).
 *
 * Why a table of real dates instead of detecting expiry from an OI drop: NSE keeps
 * changing the rule (last-Thursday → last-Tuesday from Sep 2025, with holiday
 * preponements), and a "big OI drop" heuristic mis-fires on illiquid names. The
 * exact dates make the cycle boundary exact.
 *
 * Used to clip the option OI level/baseline to the trade day's own expiry cycle
 * (the summed total steps down when a month's strikes roll off).
 */

import { prisma } from '@/lib/db';

/** Official monthly expiries. ISO date + the rule note for traceability. */
const EXPIRIES: { year: number; month: string; date: string; day: string; notes: string }[] = [
  { year: 2025, month: 'January', date: '2025-01-30', day: 'Thursday', notes: 'Last Thursday Rule' },
  { year: 2025, month: 'February', date: '2025-02-27', day: 'Thursday', notes: 'Last Thursday Rule' },
  { year: 2025, month: 'March', date: '2025-03-27', day: 'Thursday', notes: 'Last Thursday Rule' },
  { year: 2025, month: 'April', date: '2025-04-24', day: 'Thursday', notes: 'Last Thursday Rule' },
  { year: 2025, month: 'May', date: '2025-05-29', day: 'Thursday', notes: 'Last Thursday Rule' },
  { year: 2025, month: 'June', date: '2025-06-26', day: 'Thursday', notes: 'Last Thursday Rule' },
  { year: 2025, month: 'July', date: '2025-07-31', day: 'Thursday', notes: 'Last Thursday Rule' },
  { year: 2025, month: 'August', date: '2025-08-28', day: 'Thursday', notes: 'Last Thursday Rule' },
  { year: 2025, month: 'September', date: '2025-09-30', day: 'Tuesday', notes: 'Permanent shift to Last Tuesday Rule' },
  { year: 2025, month: 'October', date: '2025-10-28', day: 'Tuesday', notes: 'Last Tuesday Rule' },
  { year: 2025, month: 'November', date: '2025-11-25', day: 'Tuesday', notes: 'Last Tuesday Rule' },
  { year: 2025, month: 'December', date: '2025-12-30', day: 'Tuesday', notes: 'Last Tuesday Rule' },
  { year: 2026, month: 'January', date: '2026-01-27', day: 'Tuesday', notes: 'Last Tuesday Rule' },
  { year: 2026, month: 'February', date: '2026-02-24', day: 'Tuesday', notes: 'Last Tuesday Rule' },
  { year: 2026, month: 'March', date: '2026-03-30', day: 'Monday', notes: 'Preponed (March 31 Mahavir Jayanti)' },
  { year: 2026, month: 'April', date: '2026-04-28', day: 'Tuesday', notes: 'Last Tuesday Rule' },
  { year: 2026, month: 'May', date: '2026-05-26', day: 'Tuesday', notes: 'Last Tuesday Rule' },
  { year: 2026, month: 'June', date: '2026-06-30', day: 'Tuesday', notes: 'Last Tuesday Rule (Current)' },
  { year: 2026, month: 'July', date: '2026-07-28', day: 'Tuesday', notes: 'Last Tuesday Rule' },
  { year: 2026, month: 'August', date: '2026-08-25', day: 'Tuesday', notes: 'Last Tuesday Rule' },
  { year: 2026, month: 'September', date: '2026-09-29', day: 'Tuesday', notes: 'Last Tuesday Rule' },
  { year: 2026, month: 'October', date: '2026-10-27', day: 'Tuesday', notes: 'Last Tuesday Rule' },
  { year: 2026, month: 'November', date: '2026-11-23', day: 'Monday', notes: 'Preponed (November 24 Guru Nanak Jayanti)' },
  { year: 2026, month: 'December', date: '2026-12-29', day: 'Tuesday', notes: 'Last Tuesday Rule' },
];

/** Create + seed the calendar table (idempotent). */
export async function ensureExpiryCalendar(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS fno_expiry_calendar (
      expiryDate TEXT PRIMARY KEY,
      year INTEGER NOT NULL,
      month TEXT NOT NULL,
      day TEXT NOT NULL,
      notes TEXT
    )
  `);
  const esc = (s: string) => s.replace(/'/g, "''");
  const values = EXPIRIES.map(
    (e) => `('${e.date}', ${e.year}, '${esc(e.month)}', '${esc(e.day)}', '${esc(e.notes)}')`,
  ).join(',');
  await prisma.$executeRawUnsafe(
    `INSERT OR IGNORE INTO fno_expiry_calendar (expiryDate, year, month, day, notes) VALUES ${values}`,
  );
}

/** All expiry dates (ISO) ascending. */
export async function getExpiriesAsc(): Promise<string[]> {
  await ensureExpiryCalendar();
  const rows = await prisma.$queryRawUnsafe<{ expiryDate: string }[]>(
    `SELECT expiryDate FROM fno_expiry_calendar ORDER BY expiryDate ASC`,
  );
  return rows.map((r) => r.expiryDate);
}

/**
 * The most recent monthly expiry STRICTLY before `date` (ISO YYYY-MM-DD), or null
 * if none is on/before it. The trade day's option cycle begins the session after
 * this date. `expiries` must be ascending (from getExpiriesAsc).
 */
export function mostRecentExpiryBefore(expiries: string[], date: string): string | null {
  let res: string | null = null;
  for (const e of expiries) {
    if (e < date) res = e;
    else break;
  }
  return res;
}
