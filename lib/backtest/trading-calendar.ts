/**
 * Trading calendar — OFFICIAL NSE holiday list only. Nothing inferred.
 *
 * Holidays come exclusively from `HolidaycalenderData.csv` (the NSE
 * trading-holiday calendar, 2025–2026, with occasion names), imported into the
 * `market_holidays` table with source 'nse-official-csv'.
 *
 * Weekends (Sat/Sun) are non-trading by rule — EXCEPT special sessions where
 * candle data proves the market traded (e.g. Union Budget day: Sat 2025-02-01,
 * Sun 2026-02-01). Session-presence is always checked first, so Muhurat
 * trading (an official holiday with a short live session) follows whatever the
 * symbol's data actually shows.
 *
 * A weekday with no data that is NOT on the official list is reported
 * neutrally as a "no market data" day — never labeled a holiday.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { prisma } from '@/lib/db';
import { queryRows } from './backtest-store';

const OFFICIAL_CSV = path.join(process.cwd(), 'HolidaycalenderData.csv');

export interface HolidayEntry {
  date: string;
  occasion: string | null;
}

export interface WindowCalendar {
  /** Trading sessions (dates with data for the symbol) in the window. */
  sessions: number;
  /** Calendar span of the window (first → last session date). */
  spanFrom: string;
  spanTo: string;
  /** Weekend days inside the span with no market activity (normal weekends). */
  weekendsSkipped: number;
  /** Official NSE holidays inside the span (from the CSV, with occasion names). */
  holidays: HolidayEntry[];
  /** Market traded but THIS symbol has no data — a real data gap. */
  symbolGaps: string[];
  /** Weekend dates the market actually traded (special sessions, included). */
  specialSessions: string[];
  /** Weekdays with no data anywhere and not on the official list — reported, not labeled. */
  noDataDays: string[];
}

async function ensureHolidayTable(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS market_holidays (
      date TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      detected_at TEXT NOT NULL
    )
  `);
  // Older table versions lack the occasion column — add it idempotently.
  try {
    await prisma.$executeRawUnsafe('ALTER TABLE market_holidays ADD COLUMN occasion TEXT');
  } catch {
    // column already exists
  }
}

function isWeekend(date: string): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

function* eachDate(from: string, to: string): Generator<string> {
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) {
    yield d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

/** Parse the official NSE CSV: rows like "1","26/2/2025 ","Wednesday","Mahashivratri". */
function parseOfficialCsv(): HolidayEntry[] {
  if (!existsSync(OFFICIAL_CSV)) return [];
  const out: HolidayEntry[] = [];
  for (const line of readFileSync(OFFICIAL_CSV, 'utf8').split(/\r?\n/)) {
    const fields = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1].trim());
    if (fields.length < 4) continue;
    const m = fields[1].match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) continue; // header, footnotes, blank rows
    const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    out.push({ date: iso, occasion: fields[3] || null });
  }
  return out;
}

/** All dates the market demonstrably traded (any symbol, either source). */
async function getMarketTradingDays(): Promise<Set<string>> {
  const eq = (await queryRows('SELECT DISTINCT date FROM backtest_equity')) as { date: string }[];
  const days = new Set(eq.map((r) => r.date));
  try {
    const bhav = await prisma.$queryRawUnsafe<{ date: string }[]>('SELECT DISTINCT date FROM bhavcopy_days');
    for (const r of bhav) days.add(r.date);
  } catch {
    // bhavcopy table may not exist in a fresh DB — equity coverage alone is fine
  }
  return days;
}

const esc = (s: string) => s.replace(/'/g, "''");

/**
 * Sync `market_holidays` from the official CSV (the only holiday source) and
 * return the holiday map (date → occasion). Any non-official rows from older
 * versions of this table are removed.
 */
export async function syncHolidays(): Promise<Map<string, string | null>> {
  await ensureHolidayTable();
  const now = new Date().toISOString();

  const official = parseOfficialCsv();
  for (const h of official) {
    await prisma.$executeRawUnsafe(
      `INSERT OR REPLACE INTO market_holidays (date, source, detected_at, occasion)
       VALUES ('${h.date}', 'nse-official-csv', '${now}', ${h.occasion ? `'${esc(h.occasion)}'` : 'NULL'})`,
    );
  }
  // Official list only — purge anything else (e.g. previously derived rows).
  await prisma.$executeRawUnsafe(`DELETE FROM market_holidays WHERE source != 'nse-official-csv'`);

  const all = await prisma.$queryRawUnsafe<{ date: string; occasion: string | null }[]>(
    'SELECT date, occasion FROM market_holidays',
  );
  return new Map(all.map((r) => [r.date, r.occasion]));
}

export interface MarketCalendarSummary {
  holidays: { date: string; weekday: string; occasion: string | null; source: string }[];
  /** Weekend dates with observed trading data (e.g. Budget-day sessions). */
  specialWeekendSessions: { date: string; weekday: string }[];
  /** Range of observed market data (candles + bhavcopy). */
  dataCoverage: { from: string; to: string; tradingDays: number } | null;
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function weekdayName(date: string): string {
  return WEEKDAY_NAMES[new Date(`${date}T00:00:00Z`).getUTCDay()];
}

/** Full calendar for the Market Holidays page: official list + observed special sessions. */
export async function getMarketCalendar(): Promise<MarketCalendarSummary> {
  await syncHolidays();
  const rows = await prisma.$queryRawUnsafe<{ date: string; occasion: string | null; source: string }[]>(
    'SELECT date, occasion, source FROM market_holidays ORDER BY date',
  );
  const trading = await getMarketTradingDays();
  const sorted = [...trading].sort();

  return {
    holidays: rows.map((r) => ({ date: r.date, weekday: weekdayName(r.date), occasion: r.occasion, source: r.source })),
    specialWeekendSessions: sorted.filter(isWeekend).map((d) => ({ date: d, weekday: weekdayName(d) })),
    dataCoverage: sorted.length
      ? { from: sorted[0], to: sorted[sorted.length - 1], tradingDays: sorted.length }
      : null,
  };
}

/**
 * Classify every calendar day spanned by a symbol's session window:
 * weekend / official holiday / symbol data gap / special weekend session /
 * no-data day (unlabeled).
 */
export async function analyzeWindow(symbolSessions: string[]): Promise<WindowCalendar | null> {
  if (symbolSessions.length === 0) return null;
  const sorted = [...symbolSessions].sort();
  const spanFrom = sorted[0];
  const spanTo = sorted[sorted.length - 1];
  const sessionSet = new Set(sorted);

  const holidayMap = await syncHolidays();
  const marketDays = await getMarketTradingDays();

  let weekendsSkipped = 0;
  const holidays: HolidayEntry[] = [];
  const symbolGaps: string[] = [];
  const specialSessions: string[] = [];
  const noDataDays: string[] = [];

  for (const d of eachDate(spanFrom, spanTo)) {
    if (sessionSet.has(d)) {
      if (isWeekend(d)) specialSessions.push(d);
      continue;
    }
    if (holidayMap.has(d)) {
      // Official holiday — even if the market saw a brief special session
      // (Muhurat), this symbol didn't trade it.
      holidays.push({ date: d, occasion: holidayMap.get(d) ?? null });
    } else if (isWeekend(d)) {
      if (marketDays.has(d)) {
        symbolGaps.push(d); // market traded this weekend day; symbol missing
      } else {
        weekendsSkipped++;
      }
    } else if (marketDays.has(d)) {
      symbolGaps.push(d);
    } else {
      // Weekday, nothing traded anywhere, not on the official list. We don't
      // invent a holiday — report it plainly as a no-data day.
      noDataDays.push(d);
    }
  }

  return {
    sessions: sorted.length,
    spanFrom,
    spanTo,
    weekendsSkipped,
    holidays,
    symbolGaps,
    specialSessions,
    noDataDays,
  };
}
