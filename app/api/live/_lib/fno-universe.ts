import { prisma } from '@/lib/db';

/**
 * Shared F&O-universe gate for the Live Urgency endpoints.
 *
 * Live Urgency is F&O-only and never shows the 'avoid' lot-size band (lot > 2,500
 * ⇒ low-premium options, wide spreads, worst fills — see lib/trade-band.ts). The
 * canonical universe + band live in the `fno_stocks` table; a live (non-expired)
 * stock future in `master_contracts` is what lets the OI-level column resolve.
 */

export interface FnoMeta {
  sector: string;
  tradeBand: string;
  isIndex: boolean;
}

/**
 * `fno_stocks` rows keyed by symbol. Pass `symbols` to scope the query (cheaper
 * for a small watchlist); omit it to load the whole F&O universe.
 */
export async function loadFnoUniverse(symbols?: string[]): Promise<Map<string, FnoMeta>> {
  const rows =
    symbols && symbols.length
      ? await prisma.$queryRawUnsafe<{ symbol: string; sector: string; tradeBand: string; isIndex: number }[]>(
          `SELECT symbol, sector, tradeBand, isIndex FROM fno_stocks WHERE symbol IN (${symbols.map(() => '?').join(',')})`,
          ...symbols,
        )
      : await prisma.$queryRawUnsafe<{ symbol: string; sector: string; tradeBand: string; isIndex: number }[]>(
          `SELECT symbol, sector, tradeBand, isIndex FROM fno_stocks`,
        );
  return new Map(
    rows.map((r) => [r.symbol, { sector: r.sector, tradeBand: r.tradeBand, isIndex: Number(r.isIndex) === 1 }]),
  );
}

/** Underlyings with a live (non-expired) stock future — so the OI-level column can resolve. */
export async function loadLiveFutureUnderlyings(): Promise<Set<string>> {
  const rows = await prisma.$queryRawUnsafe<{ underlying: string | null }[]>(
    `SELECT DISTINCT underlying FROM master_contracts
     WHERE instrument = 'FUTSTK' AND segment = 'NSE_FNO' AND expiryDate >= date('now')`,
  );
  return new Set(rows.map((r) => r.underlying).filter((u): u is string => !!u));
}

export type ExcludeReason = 'not-fno' | 'index' | 'avoid';

/** Whether a symbol is a tradeable Live-Urgency name (F&O, not an index, not 'avoid'). */
export function classifyFno(meta: FnoMeta | undefined): { ok: boolean; reason?: ExcludeReason } {
  if (!meta) return { ok: false, reason: 'not-fno' };
  if (meta.isIndex) return { ok: false, reason: 'index' };
  if (meta.tradeBand === 'avoid') return { ok: false, reason: 'avoid' };
  return { ok: true };
}

/** Human label for an exclusion reason (shown in the UI). */
export function excludeReasonLabel(reason: ExcludeReason): string {
  return reason === 'avoid' ? 'avoid band' : reason === 'index' ? 'index' : 'not F&O';
}
