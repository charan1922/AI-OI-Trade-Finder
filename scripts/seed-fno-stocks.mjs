/**
 * Seed/refresh the fno_stocks table from "Dhan - Nse Fno Lot Size.csv".
 * Re-runnable: upserts by symbol. Run with:  node scripts/seed-fno-stocks.mjs
 *
 * Sectors mirror TradeFinder's Sector Scope. lib/data/fno_sectors.json is a
 * GENERATED artifact — run scripts/generate-sector-map.mjs after changing
 * lib/data/sector_scope_groups.json, never hand-edit it.
 *
 * Sector assignment (provenance recorded in sectorSource):
 *  - 'tradefinder' — TradeFinder puts the symbol in a real sector basket, and
 *                    that basket (most specific first) is its sector.
 *  - 'legacy'      — TradeFinder lists the symbol ONLY in index baskets
 *                    (NIFTY 50 / SENSEX / MID SELECT) or not at all, so it has
 *                    no TF sector. The previously assigned sector is kept
 *                    rather than invented. 21 names are in this state, incl.
 *                    LT, TITAN, TRENT, BHARTIARTL, GRASIM, ADANIPORTS.
 *  - 'inferred'    — absent from the map entirely; assigned from INFERRED below
 *                    by matching the company's business to its closest peer.
 *  - 'index'       — index contracts (NIFTY etc.), not sector-classifiable.
 *
 * TradeFinder's FULL basket membership is not squeezed into that single column:
 * 65 symbols belong to several baskets at once, and every membership is seeded
 * into stock_sector_memberships below. That table is the faithful copy; the
 * sector column is the derived primary used by R-Factor V2's peer comparison,
 * sector leaders and priority refresh.
 *
 * A symbol that is neither in the map nor in INFERRED below is REJECTED with a
 * loud error rather than guessed — extend INFERRED consciously when the CSV
 * gains new names.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import {
  buildMemberships,
  DISPLAY_NAME,
  isIndexBasket,
  loadGroups,
  primarySector,
} from '../lib/data/tf-sector-rules.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const csvPath = path.join(root, 'Dhan - Nse Fno Lot Size.csv');
const sectors = JSON.parse(readFileSync(path.join(root, 'lib', 'data', 'fno_sectors.json'), 'utf8'));

// TradeFinder's exact basket membership, kept whole (65 symbols are in several).
const tfMemberships = buildMemberships(loadGroups());

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
  { band: 'extended', label: 'Extended', lotMin: 0,    lotMax: 249,       note: 'Lot <=249 (pricey low-lot names & indices). Fills fine for option buyers.' },
  { band: 'core',     label: 'Core',     lotMin: 250,  lotMax: 1500,      note: 'Best fit — 56% of TradeFinder trades fell here.' },
  { band: 'extended', label: 'Extended', lotMin: 1501, lotMax: 2500,      note: 'Upper shoulder of Core.' },
  { band: 'avoid',    label: 'Avoid',    lotMin: 2501, lotMax: 999999999, note: 'Cheap high-lot stocks; lowest option premiums in recent trades => most slippage (IDEA, YESBANK, SUZLON, BANKBARODA).' },
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
    // A TF sector basket is the authority; anything else is a kept-over value.
    sectorSource = primarySector(tfMemberships.get(symbol) ?? []) ? 'tradefinder' : 'legacy';
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

// Hand-curated band overrides — created if missing, NEVER wiped here. Applied
// to fno_stocks.tradeBand after the lot-based seeding below so manual avoids
// (etc.) survive re-seeding.
db.exec(`CREATE TABLE IF NOT EXISTS band_overrides (
  symbol TEXT PRIMARY KEY,
  band   TEXT NOT NULL,
  note   TEXT NOT NULL DEFAULT ''
)`);

// One-time corrections (2026-07-30): KAYNES was flagged 'avoid' on 21-Jun-2026
// for an F&O ban that is no longer in effect (NSE's ban list confirmed NIL on
// 30-Jul-2026) — it had been invisible to the scanner for 5+ weeks past the
// ban's end with nothing rechecking it. Same stale-date pattern exists on
// AMBER/WIPRO/BANDHANBNK/PGEL/SAIL/NBCC/AMBUJACEM/INOXWIND/RVNL/GLENMARK —
// NOT touched here; re-verify each against the live ban list before clearing.
db.exec(`DELETE FROM band_overrides WHERE symbol = 'KAYNES'`);
// RECLTD: user-reviewed and flagged avoid (thin spread, doesn't trend — see
// 27-Jul loss review), independent of its lot-size band.
db.exec(`
  INSERT INTO band_overrides (symbol, band, note)
  VALUES ('RECLTD', 'avoid', 'user-flagged: thin spread, doesn''t trend (27-Jul review)')
  ON CONFLICT(symbol) DO UPDATE SET band = excluded.band, note = excluded.note
`);

// TradeFinder's basket membership, kept exactly as the site has it: one row per
// (symbol, basket), so the 65 multi-basket names keep every membership. The
// single fno_stocks.sector column cannot represent this, which is why it exists.
db.exec(`CREATE TABLE IF NOT EXISTS stock_sector_memberships (
  symbol    TEXT    NOT NULL,
  basket    TEXT    NOT NULL,
  label     TEXT    NOT NULL,
  isIndex   INTEGER NOT NULL DEFAULT 0,
  isPrimary INTEGER NOT NULL DEFAULT 0,
  source    TEXT    NOT NULL DEFAULT 'tradefinder',
  syncedAt  TEXT    NOT NULL,
  PRIMARY KEY (symbol, basket)
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_stock_sector_memberships_basket
  ON stock_sector_memberships(basket)`);

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

// Refresh TradeFinder memberships. Replaced wholesale (not merged) so a symbol
// dropped from a basket upstream stops claiming that membership here.
const upsertMembership = db.prepare(`
  INSERT INTO stock_sector_memberships (symbol, basket, label, isIndex, isPrimary, source, syncedAt)
  VALUES (@symbol, @basket, @label, @isIndex, @isPrimary, 'tradefinder', @syncedAt)
  ON CONFLICT(symbol, basket) DO UPDATE SET
    label=excluded.label, isIndex=excluded.isIndex,
    isPrimary=excluded.isPrimary, source=excluded.source, syncedAt=excluded.syncedAt
`);
const membershipTx = db.transaction(() => {
  db.prepare(`DELETE FROM stock_sector_memberships WHERE source = 'tradefinder'`).run();
  for (const [symbol, baskets] of tfMemberships) {
    const primary = primarySector(baskets);
    for (const basket of baskets) {
      upsertMembership.run({
        symbol,
        basket,
        label: DISPLAY_NAME[basket] ?? basket,
        isIndex: isIndexBasket(basket) ? 1 : 0,
        isPrimary: primary != null && DISPLAY_NAME[basket] === primary ? 1 : 0,
        syncedAt,
      });
    }
  }
});
membershipTx();

// Apply manual overrides on top of the lot-based band.
const overrides = db.prepare('SELECT symbol, band FROM band_overrides').all();
const applyOverride = db.prepare('UPDATE fno_stocks SET tradeBand = @band WHERE symbol = @symbol');
let applied = 0;
for (const o of overrides) applied += applyOverride.run(o).changes;
if (overrides.length) console.log(`Applied ${applied}/${overrides.length} manual band overrides`);

const counts = db
  .prepare('SELECT sector, COUNT(*) n FROM fno_stocks GROUP BY sector ORDER BY n DESC')
  .all();
const bySource = db
  .prepare('SELECT sectorSource, COUNT(*) n FROM fno_stocks GROUP BY sectorSource')
  .all();
console.log(`Seeded ${records.length} rows (months: ${lotMonths})`);
console.log('by sector:', counts.map((c) => `${c.sector}=${c.n}`).join(' '));
console.log('by source:', bySource.map((c) => `${c.sectorSource}=${c.n}`).join(' '));

const mem = db
  .prepare(
    `SELECT COUNT(*) rows, COUNT(DISTINCT symbol) symbols, COUNT(DISTINCT basket) baskets
       FROM stock_sector_memberships WHERE source = 'tradefinder'`
  )
  .get();
const multi = db
  .prepare(
    `SELECT COUNT(*) n FROM (
       SELECT symbol FROM stock_sector_memberships WHERE source = 'tradefinder'
       GROUP BY symbol HAVING COUNT(*) > 1)`
  )
  .get();
console.log(
  `TradeFinder memberships: ${mem.rows} rows, ${mem.symbols} symbols, ${mem.baskets} baskets (${multi.n} in more than one)`
);
db.close();
