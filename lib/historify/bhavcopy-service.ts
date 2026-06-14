/**
 * Bhavcopy Service — ported from the parent project's
 * `lib/r-factor/bhavcopy-service.ts` (same NSE endpoints, parsers, and
 * aggregation; the local JSON-cache import step is dropped — this project has
 * no `lib/cache`).
 *
 * Downloads official NSE end-of-day data per trading date:
 *   - F&O bhavcopy  (per-contract → aggregated per symbol, nearest-expiry futures)
 *   - Equity bhavcopy (OHLC, volume, turnover, trades)
 *   - MTO delivery data (delivery qty / %)
 * and stores one row per (date, symbol) in `bhavcopy_days`.
 *
 * Sync is explicit (user-triggered), never automatic. NSE requires a session
 * cookie — nseindia.com is visited first to obtain one.
 */

import { inflateRawSync } from 'node:zlib';
import { prisma } from '@/lib/db';

const NSE_BASE = 'https://nsearchives.nseindia.com/content';
const NSE_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: '*/*',
  'Accept-Encoding': 'gzip, deflate, br',
  Referer: 'https://www.nseindia.com/',
};

export interface BhavcopyStatus {
  rows: number;
  symbols: number;
  dates: number;
  latestDate: string | null;
}

/** Current coverage of the bhavcopy_days table. */
export async function getBhavcopyStatus(): Promise<BhavcopyStatus> {
  const [rows, dates, latest] = await Promise.all([
    prisma.bhavcopyDay.count(),
    prisma.bhavcopyDay.findMany({ select: { date: true }, distinct: ['date'] }),
    prisma.bhavcopyDay.findFirst({ select: { date: true }, orderBy: { date: 'desc' } }),
  ]);
  const symbols = await prisma.bhavcopyDay.findMany({ select: { symbol: true }, distinct: ['symbol'] });
  return { rows, symbols: symbols.length, dates: dates.length, latestDate: latest?.date ?? null };
}

/**
 * Sync bhavcopy data from NSE for the last N trading days (missing dates only).
 */
export async function syncBhavcopy(
  days = 25,
): Promise<{ dates: number; rows: number; skipped: string[]; elapsed: string }> {
  const startMs = Date.now();

  const candidateDates = getWeekdayDates(days + 10);
  const existingDates = await prisma.bhavcopyDay.findMany({ select: { date: true }, distinct: ['date'] });
  const syncedSet = new Set(existingDates.map((r) => r.date));
  const missingDates = candidateDates.filter((d) => !syncedSet.has(formatDate(d)));

  let totalRows = 0;
  let datesAdded = 0;
  const skipped: string[] = [];

  if (missingDates.length === 0) {
    return { dates: 0, rows: 0, skipped, elapsed: `${((Date.now() - startMs) / 1000).toFixed(1)}s` };
  }

  console.log(`[Bhavcopy] ${syncedSet.size} dates in DB, ${missingDates.length} to download from NSE`);
  const nseCookie = await getNSECookie();

  for (const date of missingDates) {
    const dateKey = formatDate(date);
    console.log(`[Bhavcopy] Downloading ${dateKey}...`);

    const [fnoData, eqData, mtoData] = await Promise.all([
      fetchFnOBhavcopy(date, nseCookie),
      fetchEquityBhavcopy(date, nseCookie),
      fetchMTODeliveryData(date, nseCookie),
    ]);

    if (fnoData.size === 0 && eqData.size === 0) {
      // Holiday, not-yet-published, or blocked — recorded, never fabricated.
      skipped.push(dateKey);
      console.log(`[Bhavcopy] ${dateKey} — no data (holiday/unpublished/blocked)`);
      continue;
    }

    const rows: string[] = [];
    for (const [symbol, fno] of fnoData) {
      const eq = eqData.get(symbol);
      const mto = mtoData.get(symbol);
      rows.push(
        `(NULL, '${dateKey}', '${esc(symbol)}', ${eq?.eq_volume ?? 0}, ${eq?.eq_turnover ?? 0}, ${eq?.eq_open ?? 0}, ${eq?.eq_high ?? 0}, ${eq?.eq_low ?? 0}, ${eq?.eq_close ?? 0}, ${eq?.eq_trades ?? 0}, ${mto?.eq_delivery_qty ?? 0}, ${mto?.eq_delivery_pct ?? 0}, ${fno.fut_volume}, ${fno.fut_oi}, ${fno.fut_oi_change}, ${fno.fut_turnover}, ${fno.fut_trades}, ${fno.opt_volume}, ${fno.opt_oi}, ${fno.opt_turnover}, ${fno.opt_trades}, ${fno.ce_volume}, ${fno.pe_volume}, ${fno.ce_trades}, ${fno.pe_trades})`,
      );
    }

    if (rows.length > 0) {
      const CHUNK = 200;
      for (let i = 0; i < rows.length; i += CHUNK) {
        await prisma.$executeRawUnsafe(
          `INSERT OR IGNORE INTO bhavcopy_days (id, date, symbol, eqVolume, eqTurnover, eqOpen, eqHigh, eqLow, eqClose, eqTrades, eqDeliveryQty, eqDeliveryPct, futVolume, futOi, futOiChange, futTurnover, futTrades, optVolume, optOi, optTurnover, optTrades, ceVolume, peVolume, ceTrades, peTrades) VALUES ${rows.slice(i, i + CHUNK).join(',')}`,
        );
      }
      totalRows += rows.length;
      datesAdded++;
      console.log(`[Bhavcopy] ${dateKey} — ${rows.length} stocks inserted`);
    }
  }

  const elapsed = `${((Date.now() - startMs) / 1000).toFixed(1)}s`;
  console.log(`[Bhavcopy] Sync done: ${datesAdded} dates, ${totalRows} rows in ${elapsed}`);
  return { dates: datesAdded, rows: totalRows, skipped, elapsed };
}

/** Get NSE session cookie by visiting nseindia.com first. Required for bhavcopy downloads. */
async function getNSECookie(): Promise<string> {
  try {
    const res = await fetch('https://www.nseindia.com/', {
      headers: {
        'User-Agent': NSE_HEADERS['User-Agent'],
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });
    const cookies = res.headers.getSetCookie?.() || [];
    const cookieStr = cookies.map((c) => c.split(';')[0]).join('; ');
    console.log(`[Bhavcopy] Got ${cookies.length} NSE session cookies`);
    return cookieStr;
  } catch (e) {
    console.error('[Bhavcopy] Failed to get NSE cookie:', e);
    return '';
  }
}

// ─── Internal helpers (verbatim from the parent implementation) ──────────────

function esc(s: string): string {
  return s.replace(/'/g, "''");
}

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatDateForUrl(date: Date): string {
  return formatDate(date).replace(/-/g, '');
}

function getWeekdayDates(count: number): Date[] {
  const dates: Date[] = [];
  const current = new Date();
  while (dates.length < count) {
    current.setDate(current.getDate() - 1);
    const day = current.getDay();
    if (day !== 0 && day !== 6) {
      dates.push(new Date(current));
    }
  }
  return dates.reverse(); // oldest first
}

function parseCSV(csv: string): Record<string, string>[] {
  const lines = csv.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map((h) => h.trim());
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map((v) => v.trim().replace(/^"|"$/g, ''));
    if (values.length !== headers.length) continue;
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j];
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Minimal ZIP extractor using only Node's built-in zlib — deliberately NO
 * third-party unzip dependency. Walks the End-of-Central-Directory record to
 * find the first .csv entry (NSE bhavcopy zips contain exactly one CSV) and
 * inflates it. Handles methods 0 (stored) and 8 (deflate); NSE files are far
 * below zip64 thresholds.
 */
function extractCsvFromZip(buffer: Buffer): string | null {
  // Locate EOCD (signature 0x06054b50) scanning back over a possible comment.
  const minEocd = 22;
  if (buffer.length < minEocd) return null;
  let eocd = -1;
  const scanStart = Math.max(0, buffer.length - minEocd - 65536);
  for (let i = buffer.length - minEocd; i >= scanStart; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16); // central directory start

  for (let n = 0; n < entryCount; n++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) return null;
    const method = buffer.readUInt16LE(offset + 10);
    const compSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLen);

    if (name.toLowerCase().endsWith('.csv')) {
      // Local header: 30 fixed bytes + name + extra (lengths re-read locally —
      // they can differ from the central directory copy).
      if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) return null;
      const localNameLen = buffer.readUInt16LE(localOffset + 26);
      const localExtraLen = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLen + localExtraLen;
      const data = buffer.subarray(dataStart, dataStart + compSize);
      if (method === 0) return data.toString('utf8');
      if (method === 8) return inflateRawSync(data).toString('utf8');
      return null; // unsupported compression method
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Download + extract an NSE bhavcopy zip, with retry/backoff.
 *
 * NSE throttles (403/429/5xx/timeout) during long sequential syncs. Without
 * retries, a throttled request looked identical to "no file" and the trading day
 * was silently dropped — mislabeled as a holiday. Now transient failures are
 * retried with backoff; only a genuine 404 (file doesn't exist — real holiday or
 * not-yet-published) returns immediately. Returns null only after exhausting
 * retries or on a true 404.
 */
async function downloadAndExtractZip(url: string, cookie = '', attempts = 4): Promise<string | null> {
  const hdrs: Record<string, string> = { ...NSE_HEADERS };
  if (cookie) hdrs.Cookie = cookie;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    let res: Response | null = null;
    try {
      res = await fetch(url, { headers: hdrs, signal: controller.signal });
    } catch {
      // network error / timeout — transient, fall through to retry
    } finally {
      clearTimeout(timeout);
    }
    if (res) {
      if (res.status === 404) return null; // genuine: no file for this date (holiday/unpublished)
      if (res.ok) {
        const buffer = Buffer.from(await res.arrayBuffer());
        try {
          const csv = extractCsvFromZip(buffer);
          if (csv) return csv;
        } catch {
          // corrupt/partial download — retry
        }
      }
      // else 403/429/5xx → throttled, retry
    }
    if (attempt < attempts) await sleep(500 * 2 ** (attempt - 1)); // 0.5s → 1s → 2s
  }
  return null;
}

interface FnOData {
  fut_oi: number;
  fut_oi_change: number;
  fut_volume: number;
  fut_turnover: number;
  fut_trades: number;
  opt_oi: number;
  opt_volume: number;
  opt_turnover: number;
  opt_trades: number;
  ce_volume: number;
  pe_volume: number;
  ce_trades: number;
  pe_trades: number;
}

interface EqData {
  eq_volume: number;
  eq_turnover: number;
  eq_open: number;
  eq_high: number;
  eq_low: number;
  eq_close: number;
  eq_trades: number;
}

interface MTOData {
  eq_delivery_qty: number;
  eq_delivery_pct: number;
}

async function fetchFnOBhavcopy(date: Date, cookie = ''): Promise<Map<string, FnOData>> {
  const dateStr = formatDateForUrl(date);
  const url = `${NSE_BASE}/fo/BhavCopy_NSE_FO_0_0_0_${dateStr}_F_0000.csv.zip`;
  const csv = await downloadAndExtractZip(url, cookie);
  if (!csv) return new Map();

  const rows = parseCSV(csv);
  const result = new Map<string, FnOData>();
  const futuresRows = new Map<string, { expiry: string; row: Record<string, string> }[]>();
  const optionsRows: Record<string, string>[] = [];

  for (const row of rows) {
    const type = row.FinInstrmTp;
    const symbol = row.TckrSymb;
    if (!symbol) continue;
    if (type === 'STF') {
      if (!futuresRows.has(symbol)) futuresRows.set(symbol, []);
      futuresRows.get(symbol)?.push({ expiry: row.XpryDt, row });
    } else if (type === 'STO') {
      optionsRows.push(row);
    }
  }

  for (const [symbol, entries] of futuresRows) {
    // TOTAL open interest / turnover summed across ALL futures contracts (every
    // expiry), not a single contract. This is the unambiguous "open interest in
    // this stock's futures" and is immune to all three single-contract artifacts:
    //   - maturation ramp (a far-month contract's OI growing as it nears expiry),
    //   - rollover dip (front-month handover splitting OI across two months),
    //   - near-expiry husk (the expiring contract lingering with near-zero OI).
    // Summing every series means none of those can distort the daily number.
    let fut_oi = 0;
    let fut_oi_change = 0;
    let fut_volume = 0;
    let fut_turnover = 0;
    let fut_trades = 0;
    for (const { row: r } of entries) {
      fut_oi += Number.parseFloat(r.OpnIntrst) || 0;
      fut_oi_change += Number.parseFloat(r.ChngInOpnIntrst) || 0;
      fut_volume += Number.parseFloat(r.TtlTradgVol) || 0;
      fut_turnover += Number.parseFloat(r.TtlTrfVal) || 0;
      fut_trades += Number.parseInt(r.TtlNbOfTxsExctd, 10) || 0;
    }
    result.set(symbol, {
      fut_oi,
      fut_oi_change,
      fut_volume,
      fut_turnover,
      fut_trades,
      opt_oi: 0,
      opt_volume: 0,
      opt_turnover: 0,
      opt_trades: 0,
      ce_volume: 0,
      pe_volume: 0,
      ce_trades: 0,
      pe_trades: 0,
    });
  }

  for (const row of optionsRows) {
    const symbol = row.TckrSymb;
    if (!symbol) continue;
    const vol = Number.parseFloat(row.TtlTradgVol) || 0;
    const optType = row.OptnTp;
    const txs = Number.parseInt(row.TtlNbOfTxsExctd, 10) || 0;
    const existing = result.get(symbol);
    if (existing) {
      existing.opt_oi += Number.parseFloat(row.OpnIntrst) || 0;
      existing.opt_volume += vol;
      existing.opt_turnover += Number.parseFloat(row.TtlTrfVal) || 0;
      existing.opt_trades += txs;
      if (optType === 'CE') {
        existing.ce_volume += vol;
        existing.ce_trades += txs;
      } else if (optType === 'PE') {
        existing.pe_volume += vol;
        existing.pe_trades += txs;
      }
    } else {
      result.set(symbol, {
        fut_oi: 0,
        fut_oi_change: 0,
        fut_volume: 0,
        fut_turnover: 0,
        fut_trades: 0,
        opt_oi: Number.parseFloat(row.OpnIntrst) || 0,
        opt_volume: vol,
        opt_turnover: Number.parseFloat(row.TtlTrfVal) || 0,
        opt_trades: txs,
        ce_volume: optType === 'CE' ? vol : 0,
        pe_volume: optType === 'PE' ? vol : 0,
        ce_trades: optType === 'CE' ? txs : 0,
        pe_trades: optType === 'PE' ? txs : 0,
      });
    }
  }

  return result;
}

async function fetchEquityBhavcopy(date: Date, cookie = ''): Promise<Map<string, EqData>> {
  const dateStr = formatDateForUrl(date);
  const url = `${NSE_BASE}/cm/BhavCopy_NSE_CM_0_0_0_${dateStr}_F_0000.csv.zip`;
  const csv = await downloadAndExtractZip(url, cookie);
  if (!csv) return new Map();

  const rows = parseCSV(csv);
  const result = new Map<string, EqData>();
  for (const row of rows) {
    const symbol = row.TckrSymb;
    if (!symbol || row.SctySrs !== 'EQ') continue;
    result.set(symbol, {
      eq_volume: Number.parseFloat(row.TtlTradgVol) || 0,
      eq_turnover: Number.parseFloat(row.TtlTrfVal) || 0,
      eq_open: Number.parseFloat(row.OpnPric) || 0,
      eq_high: Number.parseFloat(row.HghPric) || 0,
      eq_low: Number.parseFloat(row.LwPric) || 0,
      eq_close: Number.parseFloat(row.ClsPric) || 0,
      eq_trades: Number.parseInt(row.TtlNbOfTxsExctd, 10) || 0,
    });
  }
  return result;
}

async function fetchMTODeliveryData(date: Date, cookie = ''): Promise<Map<string, MTOData>> {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  const url = `${NSE_BASE}/archives/equities/mto/MTO_${dd}${mm}${yyyy}.DAT`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  const hdrs: Record<string, string> = { ...NSE_HEADERS };
  if (cookie) hdrs.Cookie = cookie;

  let res: Response;
  try {
    res = await fetch(url, { headers: hdrs, signal: controller.signal });
  } catch {
    return new Map();
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) return new Map();

  const text = await res.text();
  const result = new Map<string, MTOData>();

  const lines = text.split('\n');
  for (const line of lines) {
    if (line.startsWith('#') || !line.trim()) continue;
    // Format: Record Type(02/03), Sr No, Name of Security, Segment(EQ), Traded Qty, Deliverable Qty, Delivery %
    const parts = line.split(',').map((p) => p.trim());
    if (parts.length >= 7 && parts[3] === 'EQ') {
      result.set(parts[2], {
        eq_delivery_qty: Number.parseFloat(parts[5]) || 0,
        eq_delivery_pct: Number.parseFloat(parts[6]) || 0,
      });
    }
  }

  return result;
}
