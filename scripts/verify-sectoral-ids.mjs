#!/usr/bin/env node
/**
 * Enumerate NSE index (IDX_I) security ids from Dhan's public master CSV so the
 * placeholder ids in lib/sector/sectoral-indices.ts can be filled in and flipped
 * to `verified: true`. The heatmap cross-check (/api/heatmap/cross-check) only
 * uses an index as canonical once its id is verified — this script supplies them.
 *
 * Usage:  node scripts/verify-sectoral-ids.mjs
 *
 * No credentials needed — the master CSV is public. Prints every NSE index row,
 * then a ready-to-paste mapping for the sectoral indices our heatmap tracks.
 */

const MASTER_CSV_URL = 'https://images.dhan.co/api-data/api-scrip-master.csv';

// Our heatmap sector → official NSE index name (must match sectoral-indices.ts).
const WANTED = [
  ['IT', 'NIFTY IT'],
  ['AUTO', 'NIFTY AUTO'],
  ['PHARMA', 'NIFTY PHARMA'],
  ['FMCG', 'NIFTY FMCG'],
  ['METAL', 'NIFTY METAL'],
  ['ENERGY', 'NIFTY ENERGY'],
  ['REALTY', 'NIFTY REALTY'],
  ['PVT BANK', 'NIFTY PVT BANK'],
  ['PSU BANK', 'NIFTY PSU BANK'],
  ['FIN SERVICE', 'NIFTY FIN SERVICE'],
];

const norm = (s) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

async function main() {
  console.log(`Fetching ${MASTER_CSV_URL} …`);
  const resp = await fetch(MASTER_CSV_URL);
  if (!resp.ok) throw new Error(`Failed to fetch master CSV: ${resp.status}`);
  const text = await resp.text();
  const lines = text.split('\n');
  const header = lines[0].split(',').map((h) => h.trim().replace(/"/g, ''));
  const col = (name) => header.indexOf(name);

  const iExch = col('SEM_EXM_EXCH_ID');
  const iSeg = col('SEM_SEGMENT');
  const iId = col('SEM_SMST_SECURITY_ID');
  const iSym = col('SEM_TRADING_SYMBOL');
  const iName = col('SEM_INSTRUMENT_NAME');

  const indexRows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const c = line.split(',').map((x) => x.trim().replace(/"/g, ''));
    if (c[iExch] === 'NSE' && c[iSeg] === 'I') {
      indexRows.push({ id: c[iId], symbol: c[iSym], name: c[iName] });
    }
  }

  console.log(`\nFound ${indexRows.length} NSE index (IDX_I) rows:\n`);
  for (const r of indexRows.sort((a, b) => a.symbol.localeCompare(b.symbol))) {
    console.log(`  ${String(r.id).padStart(7)}  ${r.symbol}`);
  }

  console.log('\n── Suggested mapping for sectoral-indices.ts ──');
  const bySymNorm = new Map(indexRows.map((r) => [norm(r.symbol), r]));
  for (const [sectorKey, indexName] of WANTED) {
    const hit = bySymNorm.get(norm(indexName)) ?? indexRows.find((r) => norm(r.symbol).includes(norm(indexName)));
    if (hit) {
      console.log(`  ${sectorKey.padEnd(12)} → dhanSecId: ${hit.id}, verified: true   (${hit.symbol})`);
    } else {
      console.log(`  ${sectorKey.padEnd(12)} → NOT FOUND — check the index list above for the exact symbol`);
    }
  }
  console.log(
    '\nEdit lib/sector/sectoral-indices.ts with the ids above, set verified:true, then GET /api/heatmap/cross-check.',
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
