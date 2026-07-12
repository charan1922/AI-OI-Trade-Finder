/**
 * Import a recorded session's oi_intraday series FROM THE DEPLOYED APP into
 * the local DB, so replays run on the full day the server actually recorded
 * (the local dev server is often off for parts of the session — e.g. Jul-10
 * local recording starts 10:19 while the deployed app has 09:21→15:20).
 *
 * Sources (all real recorded data, read-only APIs on the deployed app):
 *   GET /api/live/urgency-history?date=D  → the symbols tracked that day
 *   GET /api/live/oi-series?symbol=S&date=D → that symbol's per-minute series
 *
 * Writes with INSERT OR IGNORE — never clobbers locally recorded rows.
 * futOiAvg20d is recovered exactly as futOi ÷ oiLevel (that's its definition);
 * capturedAt is the bucket time (the server API doesn't expose the original).
 *
 * Run:  npx tsx scripts/import-server-day.ts --date=2026-07-10 \
 *         [--base=https://project-r-simulator-production.up.railway.app]
 * Uses APP_PASSWORD from .env.local for the basic-auth gate.
 */
import Database from 'better-sqlite3';

process.loadEnvFile('.env.local');

const arg = (k: string, d: string): string => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const DATE = arg('date', '2026-07-10');
const BASE = arg('base', 'https://project-r-simulator-production.up.railway.app');
const PASS = process.env.APP_PASSWORD ?? '';
const auth = `Basic ${Buffer.from(`x:${PASS}`).toString('base64')}`;

const get = async (path: string): Promise<Record<string, unknown>> => {
  const res = await fetch(`${BASE}${path}`, { headers: { authorization: auth } });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const db = new Database('./data/project-r.db');
const before = (db.prepare('SELECT COUNT(*) c FROM oi_intraday WHERE date=?').get(DATE) as { c: number }).c;

// 1. Symbol universe for the day: server's frozen EOD board ∪ local symbols.
const hist = await get(`/api/live/urgency-history?date=${DATE}`);
const rows = (hist.rows ?? hist.data ?? []) as { symbol: string }[];
const serverSyms = rows.map((r) => r.symbol);
const localSyms = (db.prepare('SELECT DISTINCT symbol FROM oi_intraday WHERE date=?').all(DATE) as { symbol: string }[]).map((r) => r.symbol);
const symbols = [...new Set([...serverSyms, ...localSyms])].sort();
console.log(`${DATE}: server board ${serverSyms.length} symbols · local ${localSyms.length} · union ${symbols.length} · local rows before: ${before}`);
if (serverSyms.length === 0) {
  console.error('Server returned no symbols for this date — nothing to import.');
  process.exit(2);
}

// 2. Pull each symbol's series and upsert (IGNORE keeps local rows intact).
const ins = db.prepare(
  `INSERT OR IGNORE INTO oi_intraday
     (symbol, date, bucketTs, capturedAt, ltp, futOi, futOiAvg20d, oiLevel, futTurnover, changePctOpen, spreadPct, imbalance)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
let imported = 0;
let failed = 0;
for (const s of symbols) {
  try {
    const j = await get(`/api/live/oi-series?symbol=${encodeURIComponent(s)}&date=${DATE}`);
    const series = (j.series ?? []) as {
      bucketTs: number; ltp: number; futOi: number; oiLevel: number; futTurnover: number;
      changePctOpen: number | null; spreadPct: number | null; imbalance: number | null;
    }[];
    const tx = db.transaction(() => {
      for (const p of series) {
        const avg = p.oiLevel > 0 && p.futOi > 0 ? p.futOi / p.oiLevel : null; // exact recovery, oiLevel := futOi/avg
        const r = ins.run(
          s, DATE, p.bucketTs, new Date(p.bucketTs * 1000).toISOString(),
          p.ltp, p.futOi, avg, p.oiLevel, p.futTurnover, p.changePctOpen, p.spreadPct, p.imbalance,
        );
        imported += r.changes;
      }
    });
    tx();
  } catch (e) {
    failed++;
    console.log(`  ${s}: ${(e as Error).message}`);
  }
  await sleep(120); // gentle on the deployed instance
}

const after = (db.prepare('SELECT COUNT(*) c FROM oi_intraday WHERE date=?').get(DATE) as { c: number }).c;
const span = db.prepare('SELECT MIN(bucketTs) mn, MAX(bucketTs) mx, COUNT(DISTINCT symbol) syms FROM oi_intraday WHERE date=?').get(DATE) as { mn: number; mx: number; syms: number };
const ist = (ts: number) => new Date((ts + 19800) * 1000).toISOString().slice(11, 16);
console.log(`Imported ${imported} new rows (${failed} symbol fetches failed) · ${before} → ${after} rows · ${span.syms} symbols · span IST ${ist(span.mn)}→${ist(span.mx)}`);
db.close();
