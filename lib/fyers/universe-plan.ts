/**
 * Keeps `fno_stocks` — the F&O universe the poller records and every TF/live
 * check filters on — in step with the exchange. PURE: the DB side lives in
 * lib/fyers/universe-sync.ts, the CI checks in scripts/verify-fno-universe-sync.ts.
 *
 * WHY (2026-10-29): `fno_stocks` was seeded by hand from a lot-size CSV on
 * 2026-06-21 and never refreshed. Four months later it disagreed with the
 * daily-synced master contracts on 57 names: NSE renamed ICICIPRULI → ICICILIFE
 * on 2026-10-23 (so every poller cycle asked Fyers for an EQ symbol that no
 * longer exists — "Fyers returned no usable EQ candles"), 12 new F&O stocks were
 * missing, 5 had left F&O, and 39 lot sizes had changed — 8 of them across a
 * trade band, which decides what /live shows and what can be traded.
 *
 * THE RULES
 *  - Lot sizes, lot months and the lot-based trade band follow the exchange
 *    (nearest three live FUTSTK expiries). A manual `band_overrides` row always
 *    wins over the lot-based band, exactly as scripts/seed-fno-stocks.mjs applies it.
 *  - A name that left F&O is NOT deleted: replays and history still read its
 *    sector. It drops out of the universe because every universe query requires a
 *    live future (lib/fyers/symbols.ts, getTfEligibleSectors, /live).
 *  - A new name is added only when its sector is KNOWN — from a rename entry
 *    below or the TF sector map. Otherwise it is reported, never guessed: the
 *    seed's long-standing rule ("REJECTED with a loud error rather than guessed").
 *    TradeFinder itself has no real sector for any of 2026-10-29's twelve new
 *    names (seven sit in its OTHERS bin, which lib/data/tf-sector-rules.mjs does
 *    not treat as a sector; five are not on its board at all).
 */
import { classifyTradeBand } from '@/lib/trade-band';

/**
 * NSE symbol changes, old → new, each with its evidence. The master contracts
 * carry no ISIN, so a rename cannot be told apart from "one stock left, another
 * joined" — this map is the conscious link that carries the sector across.
 */
export const SYMBOL_RENAMES: Record<string, { to: string; effective: string; evidence: string }> = {
  ICICIPRULI: {
    to: 'ICICILIFE',
    effective: '2026-10-23',
    evidence:
      'Same ISIN INE726G01019 and exchange token 18652 in the Fyers NSE_CM master; NSE bhavcopy has ICICIPRULI up to 2026-10-22 and ICICILIFE from 2026-10-23 (close 431 → open 430.9, fut OI 20.5M → 21.1M); lot 925 on both.',
  },
};

export interface FnoStockRow {
  symbol: string;
  name: string;
  isIndex: boolean;
  lotSize: number;
  lotSizeNext: number;
  lotSizeFar: number;
  lotMonths: string;
  sector: string;
  tradeBand: string;
}

/** One live (not yet expired) stock-future contract from master_contracts. */
export interface LiveFuture {
  underlying: string;
  expiryDate: string; // ISO
  lotSize: number;
}

export interface FnoUniversePlan {
  /** Existing rows whose lots/months/band change. */
  updates: { symbol: string; lotSize: number; lotSizeNext: number; lotSizeFar: number; lotMonths: string; tradeBand: string; bandFrom: string }[];
  /** New rows, each with a known sector. */
  additions: (Omit<FnoStockRow, 'isIndex'> & { sectorSource: string })[];
  /** Live F&O names with no known sector — reported, not added. */
  unclassified: { symbol: string; lotSize: number }[];
  /** Universe rows with no live future (left F&O, or renamed away). Kept, excluded. */
  exited: { symbol: string; renamedTo: string | null }[];
}

const MONTH = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', month: 'short', year: 'numeric' });

/** "Nov 2026 / Dec 2026 / Jan 2027" — the seed's lotMonths format. */
function monthLabel(iso: string): string {
  return MONTH.format(new Date(iso));
}

export function planFnoUniverseSync(input: {
  stocks: FnoStockRow[];
  liveFutures: LiveFuture[];
  bandOverrides: Map<string, string>;
  /** Static TF sector map (lib/data/fno_sectors.json). */
  sectorMap: Record<string, string>;
  /** Company names from the master's EQUITY rows; missing → the symbol. */
  equityNames: Map<string, string>;
  renames?: typeof SYMBOL_RENAMES;
}): FnoUniversePlan {
  const renames = input.renames ?? SYMBOL_RENAMES;
  const byUnderlying = new Map<string, LiveFuture[]>();
  for (const f of input.liveFutures) {
    if (!f.underlying || !(f.lotSize > 0)) continue;
    const list = byUnderlying.get(f.underlying) ?? [];
    list.push(f);
    byUnderlying.set(f.underlying, list);
  }
  for (const list of byUnderlying.values()) list.sort((a, b) => a.expiryDate.localeCompare(b.expiryDate));

  const lotsFor = (symbol: string) => {
    const near = byUnderlying.get(symbol) ?? [];
    return {
      lotSize: near[0].lotSize,
      lotSizeNext: near[1]?.lotSize ?? 0,
      lotSizeFar: near[2]?.lotSize ?? 0,
      lotMonths: near.slice(0, 3).map((f) => monthLabel(f.expiryDate)).join(' / '),
    };
  };
  const bandFor = (symbol: string, lot: number) => input.bandOverrides.get(symbol) ?? classifyTradeBand(lot) ?? '';

  const plan: FnoUniversePlan = { updates: [], additions: [], unclassified: [], exited: [] };
  const known = new Map(input.stocks.map((s) => [s.symbol, s]));
  const renamedFrom = new Map(Object.entries(renames).map(([from, r]) => [r.to, from]));

  for (const row of input.stocks) {
    if (row.isIndex) continue;
    if (!byUnderlying.has(row.symbol)) {
      plan.exited.push({ symbol: row.symbol, renamedTo: renames[row.symbol]?.to ?? null });
      continue;
    }
    const lots = lotsFor(row.symbol);
    const tradeBand = bandFor(row.symbol, lots.lotSize);
    if (
      lots.lotSize !== row.lotSize ||
      lots.lotSizeNext !== row.lotSizeNext ||
      lots.lotSizeFar !== row.lotSizeFar ||
      lots.lotMonths !== row.lotMonths ||
      tradeBand !== row.tradeBand
    ) {
      plan.updates.push({ symbol: row.symbol, ...lots, tradeBand, bandFrom: row.tradeBand });
    }
  }

  for (const symbol of [...byUnderlying.keys()].sort()) {
    if (known.has(symbol)) continue;
    const lots = lotsFor(symbol);
    const predecessor = known.get(renamedFrom.get(symbol) ?? '');
    const sector = predecessor?.sector || input.sectorMap[symbol];
    if (!sector) {
      plan.unclassified.push({ symbol, lotSize: lots.lotSize });
      continue;
    }
    plan.additions.push({
      symbol,
      name: input.equityNames.get(symbol) ?? predecessor?.name ?? symbol,
      ...lots,
      sector,
      sectorSource: predecessor ? `renamed:${predecessor.symbol}` : 'tf-map',
      tradeBand: bandFor(symbol, lots.lotSize),
    });
  }
  return plan;
}
