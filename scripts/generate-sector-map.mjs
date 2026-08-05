/**
 * Regenerate lib/data/fno_sectors.json from TradeFinder's Sector Scope baskets.
 *
 *   node scripts/generate-sector-map.mjs           # preview only (writes nothing)
 *   node scripts/generate-sector-map.mjs --write   # rewrite lib/data/fno_sectors.json
 *
 * SOURCE OF TRUTH is lib/data/sector_scope_groups.json — TradeFinder's exact 16
 * baskets, verified stock-for-stock against the live site on 2026-08-05.
 *
 * TradeFinder does NOT give a stock one sector: 65 of its 210 names sit in
 * several baskets at once, because its baskets are index memberships, not a
 * partition. `fno_sectors.json` and `fno_stocks.sector` hold ONE value per
 * symbol, so a primary sector is derived here by an explicit, reproducible rule:
 *
 *  1. Index-only baskets (NIFTY 50, SENSEX, NIFTY MID SELECT) are never a
 *     primary sector — every constituent already has a real sector elsewhere.
 *  2. Among the remaining baskets, the most specific wins (SPECIFICITY below).
 *     PSU BANK / PVT BANK beat BANK; any bank beats the broader FIN SERVICE.
 *  3. OTHERS is the last resort — TradeFinder's own leftover bin.
 *
 * The full multi-membership is NOT discarded: it is seeded into
 * stock_sector_memberships by scripts/seed-fno-stocks.mjs.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildMemberships, loadGroups, primarySector } from '../lib/data/tf-sector-rules.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const mapPath = path.join(root, 'lib', 'data', 'fno_sectors.json');

const groups = loadGroups();
const memberships = buildMemberships(groups);
const next = {};
// Symbols TradeFinder lists ONLY in index baskets (NIFTY 50 / SENSEX / MID
// SELECT). TF assigns them no sector at all, so inventing one would not be
// "same as TradeFinder" — they keep whatever sector they already have.
const indexOnly = [];
for (const [symbol, baskets] of [...memberships].sort((a, b) => a[0].localeCompare(b[0]))) {
  const sector = primarySector(baskets);
  if (!sector) indexOnly.push([symbol, baskets.join(' + ')]);
  else next[symbol] = sector;
}

// ── report ────────────────────────────────────────────────────────────────
const current = JSON.parse(readFileSync(mapPath, 'utf8'));
const allSymbols = [...new Set([...Object.keys(current), ...Object.keys(next)])].sort();

const changed = [];
const dropped = [];
const added = [];
for (const symbol of allSymbols) {
  const before = current[symbol];
  const after = next[symbol];
  if (before && after && before !== after) changed.push([symbol, before, after]);
  else if (before && !after) dropped.push([symbol, before]);
  else if (!before && after) added.push([symbol, after]);
}

const countBy = (obj) => {
  const m = new Map();
  for (const v of Object.values(obj)) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

console.log(`source   : lib/data/sector_scope_groups.json (${Object.keys(groups).length} baskets)`);
console.log(`symbols  : ${Object.keys(next).length} mapped, ${changed.length} changed, ${added.length} new, ${dropped.length} no longer mapped`);

console.log(`\n--- sector counts BEFORE (${countBy(current).length} sectors) ---`);
for (const [s, n] of countBy(current)) console.log(`  ${String(n).padStart(3)}  ${s}`);
console.log(`\n--- sector counts AFTER (${countBy(next).length} sectors) ---`);
for (const [s, n] of countBy(next)) console.log(`  ${String(n).padStart(3)}  ${s}`);

console.log(`\n--- CHANGED (${changed.length}) ---`);
for (const [symbol, before, after] of changed) {
  console.log(`  ${symbol.padEnd(12)} ${before.padEnd(18)} -> ${after}`);
}
if (indexOnly.length) {
  console.log(`\n--- TradeFinder gives NO sector — keeps current sector (${indexOnly.length}) ---`);
  for (const [symbol, baskets] of indexOnly) {
    console.log(`  ${symbol.padEnd(12)} ${String(current[symbol] ?? '(none)').padEnd(18)} in: ${baskets}`);
  }
}
if (dropped.length) {
  console.log(`\n--- NOT in TradeFinder at all, keeps its current sector (${dropped.length}) ---`);
  for (const [symbol, before] of dropped) console.log(`  ${symbol.padEnd(12)} ${before}`);
}
if (added.length) {
  console.log(`\n--- NEW (${added.length}) ---`);
  for (const [symbol, after] of added) console.log(`  ${symbol.padEnd(12)} ${after}`);
}

const multi = [...memberships].filter(([, b]) => b.length > 1);
console.log(`\nmulti-basket symbols: ${multi.length} (full list preserved in stock_sector_memberships)`);

if (!process.argv.includes('--write')) {
  console.log('\nPREVIEW ONLY — nothing written. Re-run with --write to apply.');
  process.exit(0);
}

// Symbols absent from TradeFinder (indices, SAMMAANCAP) keep their existing
// sector rather than being deleted from the map.
const merged = { ...current, ...next };
writeFileSync(mapPath, `${JSON.stringify(merged, Object.keys(merged).sort(), 2)}\n`);
console.log(`\nWROTE ${mapPath} (${Object.keys(merged).length} symbols)`);
