/**
 * NSE's combined OI %-change per underlying (futures + options — the
 * oi-spurts feed that /nse/movers shows), as a symbol → pct map. Shared by
 * the Fyers poller (persists it per 5-min bucket) and the trade-suggest
 * engine (OI gate: options-led builds don't show in futures-only OI level —
 * seen live 2026-07-03: SUNPHARMA futures 0.90× avg but NSE combined +8.1%,
 * and TF's winning trade that day was the SUNPHARMA CE).
 *
 * One shared-cache NSE call; empty map on failure (callers treat missing as
 * "no evidence", never as a value).
 */

import type { OiStock } from '@/lib/nse/pulse';
import { getPulseFeed } from '@/lib/nse/pulse-cache';

export async function getNseCombinedOiPctMap(): Promise<Map<string, number>> {
  try {
    const res = await getPulseFeed<OiStock[]>('oiSpurts');
    return new Map(
      (res.data ?? [])
        .filter((s) => s.symbol && Number.isFinite(s.changeInOiPct))
        .map((s) => [s.symbol, s.changeInOiPct]),
    );
  } catch (err) {
    console.warn(`[CombinedOi] NSE oi-spurts feed unavailable: ${(err as Error).message}`);
    return new Map();
  }
}
