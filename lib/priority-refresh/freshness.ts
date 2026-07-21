/**
 * Canonical 5-minute candle-freshness rule (see plan §23) — pure, no I/O.
 *
 * The scanner builds its setup score, opening range, VWAP, Supertrend, ATR,
 * breakout, stop and target from Fyers 5-min EQ candles. So a NEW auto-trade
 * entry must not be taken on an OUTDATED completed candle. This module defines
 * exactly what "fresh" means; the auto-trade entry gate (risk/gates.ts) enforces
 * it in CODE, and it is re-checked at placement time (tools/execute.ts,
 * approval.ts). It NEVER affects exits or position guards.
 */
import { FYERS_BUCKET_SEC, fyersBucketFor } from '@/lib/fyers/candle-store';

export interface CandleFreshness {
  /** Latest FULLY COMPLETED 5-min bucket-start (epoch seconds) at `nowMs`. */
  requiredBucketTs: number;
  /** Latest stored EQ bucket-start for the symbol, or null when none. */
  latestBucketTs: number | null;
  /** latestBucketTs >= requiredBucketTs (fail-closed: false when latest is null). */
  fresh: boolean;
  /** How many 5-min buckets behind `required` the stored candle is (0 = fresh). */
  ageBuckets: number | null;
}

/**
 * The latest FULLY COMPLETED 5-min bucket at wall-clock `nowMs`. The current
 * (still-forming) bucket is `fyersBucketFor(nowMs)`; the last completed one is a
 * single 5-min period before it — the same rule the poller uses to decide a
 * priority EQ refresh reached "this cycle's" candle.
 */
export function requiredCompletedBucket(nowMs: number): number {
  return fyersBucketFor(nowMs) - FYERS_BUCKET_SEC;
}

/**
 * Freshness for a symbol given its latest stored EQ bucket (or null) and now.
 * Fail-closed: a missing candle, or a NaN clock, is STALE — never fresh.
 */
export function computeCandleFreshness(latestBucketTs: number | null, nowMs: number): CandleFreshness {
  const requiredBucketTs = requiredCompletedBucket(nowMs);
  const hasLatest = latestBucketTs != null && Number.isFinite(latestBucketTs);
  const fresh = hasLatest && Number.isFinite(requiredBucketTs) && latestBucketTs >= requiredBucketTs;
  const ageBuckets = hasLatest ? Math.max(0, Math.round((requiredBucketTs - latestBucketTs) / FYERS_BUCKET_SEC)) : null;
  return { requiredBucketTs, latestBucketTs: hasLatest ? latestBucketTs : null, fresh, ageBuckets };
}
