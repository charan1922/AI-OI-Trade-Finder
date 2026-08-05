/**
 * TradeFinder Sector Scope → this app's sector model.
 *
 * SOURCE OF TRUTH: lib/data/sector_scope_groups.json — TradeFinder's exact 16
 * baskets, verified stock-for-stock against the live site on 2026-08-05.
 *
 * TradeFinder does NOT partition stocks into sectors: its baskets are index
 * memberships, so 65 of its 210 names belong to several at once (ICICIBANK is
 * in NIFTY 50, SENSEX, BANK, PVT BANK and FIN SERVICE). Two things follow:
 *
 *  - The full membership is kept as-is in `stock_sector_memberships`. That table
 *    is what "same as TradeFinder" actually means; nothing is lost there.
 *  - `fno_stocks.sector` / `fno_sectors.json` hold ONE value each, so a primary
 *    sector is derived by the explicit rule below. Downstream code (R-Factor V2
 *    peer comparison, sector leaders, priority refresh) reads that single value.
 *
 * Shared by scripts/generate-sector-map.mjs and scripts/seed-fno-stocks.mjs so
 * the derivation can never drift between them.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Baskets that are index memberships, never a stock's own sector. */
export const INDEX_BASKETS = new Set(['NIFTY 50', 'SENSEX', 'NIFTY MID SELECT']);

/**
 * 'OTHERS' is NOT a TradeFinder sector.
 *
 * Verified against the live site on 2026-08-05: Sector Scope renders exactly 15
 * baskets (METAL, PSU BANK, REALTY, ENERGY, AUTO, IT, PHARMA, NIFTY 50, PVT
 * BANK, BANK, FIN SERVICE, FMCG, CEMENT, NIFTY MID SELECT, SENSEX) and there is
 * no OTHERS card. The 14 symbols listed under OTHERS in
 * sector_scope_groups.json (SRF, HAL, DIXON, AMBER, CROMPTON, DELHIVERY,
 * HAVELLS, IDEA, INDUSTOWER, KEI, NAM-INDIA, PGEL, PIDILITIND, COCHINSHIP)
 * appear NOWHERE on that page — searched by name, not found.
 *
 * So TradeFinder's Sector Scope covers 196 stocks, not 210, and gives these 14
 * no sector. They keep the sector they already had rather than being swept into
 * a bin TradeFinder does not use. Only caveat: TF's treemap is canvas-drawn and
 * unreadable, so an OTHERS group could exist there — unproven either way, and
 * an unproven grouping is not a basis for regrouping trading data.
 */
export const UNVERIFIED_BASKETS = new Set(['OTHERS']);

/**
 * Sector baskets, most specific first. A symbol takes the first one it is in.
 * PSU BANK / PVT BANK beat the broader BANK; any bank beats FIN SERVICE, which
 * TradeFinder also uses as an umbrella. OTHERS is TF's own leftover bin and so
 * is the last resort.
 */
export const SPECIFICITY = [
  'NIFTY PSU BANK',
  'NIFTY PVT BANK',
  'NIFTY BANK',
  'NIFTY CEMENT',
  'NIFTY METAL',
  'NIFTY PHARMA',
  'NIFTY IT',
  'NIFTY AUTO',
  'NIFTY REALTY',
  'NIFTY FMCG',
  'NIFTY ENERGY',
  'NIFTY FIN SERVICE',
];

/** TradeFinder's on-screen label for each basket. */
export const DISPLAY_NAME = {
  'NIFTY PSU BANK': 'PSU BANK',
  'NIFTY PVT BANK': 'PVT BANK',
  'NIFTY BANK': 'BANK',
  'NIFTY CEMENT': 'CEMENT',
  'NIFTY METAL': 'METAL',
  'NIFTY PHARMA': 'PHARMA',
  'NIFTY IT': 'IT',
  'NIFTY AUTO': 'AUTO',
  'NIFTY REALTY': 'REALTY',
  'NIFTY FMCG': 'FMCG',
  'NIFTY ENERGY': 'ENERGY',
  'NIFTY FIN SERVICE': 'FIN SERVICE',
  OTHERS: 'OTHERS',
  'NIFTY 50': 'NIFTY 50',
  SENSEX: 'SENSEX',
  'NIFTY MID SELECT': 'NIFTY MID SELECT',
};

export function loadGroups() {
  const groups = JSON.parse(readFileSync(path.join(here, 'sector_scope_groups.json'), 'utf8'));
  // Fail loudly if the source gains a basket nobody classified — silence here
  // would quietly drop stocks out of every sector-aware feature.
  const unknown = Object.keys(groups).filter(
    (b) => !INDEX_BASKETS.has(b) && !UNVERIFIED_BASKETS.has(b) && !SPECIFICITY.includes(b)
  );
  if (unknown.length > 0) {
    throw new Error(
      `Unclassified TradeFinder basket(s): ${unknown.join(', ')} — add each to SPECIFICITY and DISPLAY_NAME in lib/data/tf-sector-rules.mjs`
    );
  }
  // Follow TradeFinder exactly: a basket the site does not show is not part of
  // Sector Scope, so it never reaches the map, the DB or the page.
  return Object.fromEntries(
    Object.entries(groups).filter(([basket]) => !UNVERIFIED_BASKETS.has(basket))
  );
}

const orderOf = (basket) => {
  const i = SPECIFICITY.indexOf(basket);
  if (i !== -1) return i;
  const idx = [...INDEX_BASKETS].indexOf(basket);
  // Sector baskets first, then index baskets, then anything unverified.
  return idx === -1 ? SPECIFICITY.length + INDEX_BASKETS.size : SPECIFICITY.length + idx;
};

/** symbol -> every TradeFinder basket it belongs to, in specificity order. */
export function buildMemberships(groups) {
  const bySymbol = new Map();
  for (const [basket, symbols] of Object.entries(groups)) {
    for (const symbol of symbols) {
      if (!bySymbol.has(symbol)) bySymbol.set(symbol, []);
      bySymbol.get(symbol).push(basket);
    }
  }
  for (const list of bySymbol.values()) list.sort((a, b) => orderOf(a) - orderOf(b));
  return bySymbol;
}

/**
 * The single sector a symbol gets. Returns null when TradeFinder lists it only
 * in index baskets, or only under the unverified OTHERS bin — TF assigns no
 * sector in either case, so callers must keep whatever sector the symbol
 * already had rather than invent one.
 */
export function primarySector(baskets) {
  const hit = SPECIFICITY.find((b) => baskets.includes(b));
  return hit ? DISPLAY_NAME[hit] : null;
}

export const isIndexBasket = (basket) => INDEX_BASKETS.has(basket);
