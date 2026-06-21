/**
 * Seed/refresh the fno_stocks table from "Dhan - Nse Fno Lot Size.csv".
 * Re-runnable: upserts by symbol. Run with:  node scripts/seed-fno-stocks.mjs
 *
 * Sector assignment (provenance recorded in sectorSource):
 *  - 'tf-map'   — symbol exists in lib/data/fno_sectors.json (the project's
 *                 TradeFinder-derived 11-bucket map used by every page).
 *  - 'inferred' — not in that map; assigned by matching the company's business
 *                 to the map's convention for its closest peer (the map files
 *                 defence under AUTO like MAZDOCK, capital goods under ENERGY
 *                 like ABB/SIEMENS, retail & liquor & cigarettes under FMCG
 *                 like TRENT/UNITDSPR/ITC, brokers & AMCs under FIN SERVICE).
 *  - 'index'    — index contracts (NIFTY etc.), not sector-classifiable.
 *
 * A symbol that is neither in the map nor in INFERRED below is REJECTED with a
 * loud error rather than guessed — extend INFERRED consciously when the CSV
 * gains new names.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const csvPath = path.join(root, 'Dhan - Nse Fno Lot Size.csv');
const sectors = JSON.parse(readFileSync(path.join(root, 'lib', 'data', 'fno_sectors.json'), 'utf8'));

// Peer-convention assignments for symbols missing from fno_sectors.json.
const INFERRED = {
  ADANIPOWER: 'ENERGY', // power generation — like TATAPOWER/NTPC
  'GVT&D': 'ENERGY', // power T&D equipment — like ABB/SIEMENS
  COCHINSHIP: 'AUTO', // defence shipyard — map's convention, like MAZDOCK
  FORCEMOT: 'AUTO', // vehicle maker
  HYUNDAI: 'AUTO', // vehicle maker
  MOTILALOFS: 'FIN SERVICE', // broker — like ANGELONE
  'NAM-INDIA': 'FIN SERVICE', // asset manager — like HDFCAMC
  GODFRYPHLP: 'FMCG', // cigarettes — like ITC
  RADICO: 'FMCG', // liquor — like UNITDSPR
  VMM: 'FMCG', // retail — like TRENT/DMART
};

// Trade-band numeric segments — mirror of TRADE_BAND_SEGMENTS in lib/trade-band.ts.
// Inclusive lot bounds. "extended" intentionally has two shoulders around Core.
const BAND_SEGMENTS = [
  { band: 'avoid',    label: 'Avoid',    lotMin: 0,    lotMax: 149,       note: 'Too expensive per lot (BOSCH, MARUTI, SHREECEM) or index lots.' },
  { band: 'extended', label: 'Extended', lotMin: 150,  lotMax: 249,       note: 'Lower shoulder of Core.' },
  { band: 'core',     label: 'Core',     lotMin: 250,  lotMax: 1500,      note: 'Best fit — about 56% of trades.' },
  { band: 'extended', label: 'Extended', lotMin: 1501, lotMax: 2500,      note: 'Upper shoulder — widening here covers about 77%.' },
  { band: 'avoid',    label: 'Avoid',    lotMin: 2501, lotMax: 999999999, note: 'Cheap high-lot / penny-ish (IDEA, YESBANK, SUZLON, IDFCFIRSTB).' },
];
const classifyTradeBand = (lot) => {
  if (!(lot > 0)) return '';
  const seg = BAND_SEGMENTS.find((s) => lot >= s.lotMin && lot <= s.lotMax);
  return seg ? seg.band : '';
};

const raw = readFileSync(csvPath, 'utf8');
const lines = raw.split(/\r?\n/).filter((l) => l.trim());
const header = lines[0];
// Month labels from the header, e.g. "Lot Size (Jun 2026)" ×3.
const months = [...header.matchAll(/Lot Size \(([^)]+)\)/g)].map((m) => m[1]);
const lotMonths = months.join(' / ');

const parseLine = (l) => l.match(/("([^"]*)"|[^,]+)/g).map((f) => f.replace(/^"|"$/g, ''));

const rows = lines.slice(1).map(parseLine);
const records = [];
const problems = [];
for (const r of rows) {
  const [name, , symbol, lot1, lot2, lot3] = r;
  if (!symbol || !(Number(lot1) > 0)) {
    problems.push(`bad row: ${r.join(',')}`);
    continue;
  }
  const isIndex = /NIFTY/i.test(symbol);
  let sector;
  let sectorSource;
  if (isIndex) {
    sector = 'INDEX';
    sectorSource = 'index';
  } else if (sectors[symbol]) {
    sector = sectors[symbol];
    sectorSource = 'tf-map';
  } else if (INFERRED[symbol]) {
    sector = INFERRED[symbol];
    sectorSource = 'inferred';
  } else {
    problems.push(`UNMAPPED SECTOR: ${symbol} (${name}) — add to INFERRED consciously`);
    continue;
  }
  records.push({
    symbol,
    name,
    isIndex: isIndex ? 1 : 0,
    lotSize: Number(lot1),
    lotSizeNext: Number(lot2) || 0,
    lotSizeFar: Number(lot3) || 0,
    lotMonths,
    sector,
    sectorSource,
    tradeBand: classifyTradeBand(Number(lot1)),
  });
}

if (problems.length > 0) {
  console.error('REFUSING to seed — fix these first:');
  for (const p of problems) console.error(' -', p);
  process.exit(1);
}

const db = new Database(path.join(root, 'data', 'project-r.db'));
// Additive, idempotent: ensure the tradeBand column exists (no-op if already there).
try {
  db.exec("ALTER TABLE fno_stocks ADD COLUMN tradeBand TEXT NOT NULL DEFAULT ''");
} catch {
  /* column already exists */
}

// Reference table so the numeric band ranges are queryable from the DB itself.
db.exec(`CREATE TABLE IF NOT EXISTS trade_band_ranges (
  band   TEXT    NOT NULL,
  label  TEXT    NOT NULL,
  lotMin INTEGER NOT NULL,
  lotMax INTEGER NOT NULL,
  note   TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (band, lotMin)
)`);
db.exec('DELETE FROM trade_band_ranges');
const insRange = db.prepare(
  'INSERT INTO trade_band_ranges (band, label, lotMin, lotMax, note) VALUES (@band, @label, @lotMin, @lotMax, @note)'
);
for (const seg of BAND_SEGMENTS) insRange.run(seg);
const syncedAt = new Date().toISOString();
const upsert = db.prepare(`
  INSERT INTO fno_stocks (symbol, name, isIndex, lotSize, lotSizeNext, lotSizeFar, lotMonths, sector, sectorSource, tradeBand, syncedAt)
  VALUES (@symbol, @name, @isIndex, @lotSize, @lotSizeNext, @lotSizeFar, @lotMonths, @sector, @sectorSource, @tradeBand, @syncedAt)
  ON CONFLICT(symbol) DO UPDATE SET
    name=excluded.name, isIndex=excluded.isIndex, lotSize=excluded.lotSize,
    lotSizeNext=excluded.lotSizeNext, lotSizeFar=excluded.lotSizeFar,
    lotMonths=excluded.lotMonths, sector=excluded.sector,
    sectorSource=excluded.sectorSource, tradeBand=excluded.tradeBand, syncedAt=excluded.syncedAt
`);
const tx = db.transaction((recs) => {
  for (const rec of recs) upsert.run({ ...rec, syncedAt });
});
tx(records);

const counts = db
  .prepare('SELECT sector, COUNT(*) n FROM fno_stocks GROUP BY sector ORDER BY n DESC')
  .all();
const bySource = db
  .prepare('SELECT sectorSource, COUNT(*) n FROM fno_stocks GROUP BY sectorSource')
  .all();
console.log(`Seeded ${records.length} rows (months: ${lotMonths})`);
console.log('by sector:', counts.map((c) => `${c.sector}=${c.n}`).join(' '));
console.log('by source:', bySource.map((c) => `${c.sectorSource}=${c.n}`).join(' '));
db.close();
