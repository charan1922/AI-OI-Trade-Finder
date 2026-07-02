/**
 * OI-in-contracts — the shared helper for converting NSE bhavcopy open
 * interest (stored in SHARES, per expiry) into CONTRACTS, i.e. Σ over expiries of
 * (that expiry's OI ÷ its own board lot, `NewBrdLotQty` captured at sync time).
 *
 * Why contracts, not shares: when NSE revises a stock's lot size (e.g. MCX 625→225)
 * the new months carry a different lot, so OI rolling into the next expiry changes
 * the SHARE total even though the CONTRACT count grows — making a shares-based OI
 * level/change over a multi-week window misleading (it can even flip sign). Counting
 * in contracts is lot-aware and matches NSE's live "OI spurts" feed.
 *
 * Used by the data-downloader's "why this trade" OI level/change (`getDailyContext`).
 * The EOD Movers OI build-up (`/api/nse/movers-history`) applies the identical
 * contracts conversion but deliberately keeps its own inline copy (decoupled).
 */

import { prisma } from '@/lib/db';

/** One expiry's OI (shares) and its board lot for that contract month. */
export interface ExpiryOiLot {
  oi: number;
  lot: number;
}

/**
 * Σ (expiry OI ÷ that expiry's lot) → total OI in CONTRACTS. Returns null if any
 * expiry is missing a positive lot — the caller then falls back to the shares total
 * (never fabricates a lot). Futures and options of the same expiry share one board
 * lot, so passing them as flat rows is equivalent to merging-then-dividing.
 */
export function expiryRowsToContracts(rows: ExpiryOiLot[]): number | null {
  if (rows.length === 0) return null;
  let total = 0;
  for (const r of rows) {
    if (!(r.lot > 0)) return null;
    total += r.oi / r.lot;
  }
  return total;
}

/** Per-day contracts split. `null` on a side means no lot-backed per-expiry data
 *  for that day → caller uses the shares total for that day. */
export interface ContractsOiDay {
  fut: number | null;
  opt: number | null;
}

/**
 * Per-day futures & total-option OI in CONTRACTS for one symbol, for every session
 * on/before `onOrBefore`, read from the per-expiry bhavcopy tables (OI + lot per
 * contract). Returns Map<date → { fut, opt }>. Empty map if the tables are absent
 * (older DB) — the caller degrades to the shares totals in `bhavcopy_days`.
 */
export async function getContractsOiByDate(symbol: string, onOrBefore: string): Promise<Map<string, ContractsOiDay>> {
  const out = new Map<string, ContractsOiDay>();
  try {
    const [futRows, optRows] = await Promise.all([
      prisma.$queryRawUnsafe<{ date: string; oi: number; lot: number }[]>(
        `SELECT date, futOi AS oi, lotSize AS lot FROM bhavcopy_fut_expiry WHERE symbol = ? AND date <= ?`,
        symbol,
        onOrBefore,
      ),
      prisma.$queryRawUnsafe<{ date: string; oi: number; lot: number }[]>(
        `SELECT date, optOi AS oi, lotSize AS lot FROM bhavcopy_option_expiry WHERE symbol = ? AND date <= ?`,
        symbol,
        onOrBefore,
      ),
    ]);
    const byDate = new Map<string, { fut: ExpiryOiLot[]; opt: ExpiryOiLot[] }>();
    const bucket = (d: string) => {
      let b = byDate.get(d);
      if (!b) {
        b = { fut: [], opt: [] };
        byDate.set(d, b);
      }
      return b;
    };
    for (const r of futRows) bucket(r.date).fut.push({ oi: Number(r.oi), lot: Number(r.lot) });
    for (const r of optRows) bucket(r.date).opt.push({ oi: Number(r.oi), lot: Number(r.lot) });
    for (const [d, b] of byDate) {
      out.set(d, { fut: expiryRowsToContracts(b.fut), opt: expiryRowsToContracts(b.opt) });
    }
  } catch {
    // per-expiry tables not present yet — caller falls back to shares
  }
  return out;
}
