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
import { getPulseFeed, type PulseFeedOptions } from '@/lib/nse/pulse-cache';

/**
 * How long a latency-bound caller (the /live quote path) will wait on NSE before
 * settling for the last captured rows. These feed DISPLAY columns; the /live
 * client abandons a quote after 8s, so a slow NSE must cost the response a
 * couple of seconds at worst, never the whole request. See the module doc in
 * lib/nse/pulse-cache.ts for why an NSE miss can otherwise run for tens of
 * seconds.
 */
export const LIVE_PATH_NSE_WAIT_MS = 2_500;

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

/**
 * The full oi-spurts row per underlying (not just the %-change) — the source for
 * the /live F&O OI Build-up columns: options premium, fut/opt value split, the
 * options-share ratio, and absolute combined OI. Same shared 30s cache as the
 * %-map above; empty map on failure (callers show "—", never fabricate). The
 * `optShare` field is the one worth wiring into gates later — it's the only
 * value here that doesn't ratchet with the day.
 */
export async function getNseOiRowMap(opts: PulseFeedOptions = {}): Promise<Map<string, OiStock>> {
  try {
    const res = await getPulseFeed<OiStock[]>('oiSpurts', opts);
    return new Map((res.data ?? []).filter((s) => s.symbol).map((s) => [s.symbol, s]));
  } catch (err) {
    console.warn(`[CombinedOi] NSE oi-spurts feed unavailable: ${(err as Error).message}`);
    return new Map();
  }
}
