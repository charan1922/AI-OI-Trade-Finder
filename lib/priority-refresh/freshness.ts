/**
 * Canonical 5-minute candle-freshness rule (see plan §23) — pure, no I/O.
 *
 * The scanner builds its setup/stop/target from Fyers 5-min EQ candles, so a NEW
 * auto-trade entry must not be taken on an OUTDATED completed candle. The candle
 * store deliberately keeps the CURRENTLY FORMING bar and rewrites it each cycle,
 * so "the required bucket exists" is NOT proof it is complete: a bucket fetched
 * mid-formation carries only partial data (PR#10 review). We therefore prove
 * FINALIZATION — the required completed bucket was written (updatedAt) at or
 * AFTER its close time.
 *
 * The gate (risk/gates.ts) enforces this in CODE and re-checks it at placement
 * (tools/execute.ts, approval.ts). It NEVER affects exits or position guards.
 */
import { FYERS_BUCKET_SEC, fyersBucketFor } from '@/lib/fyers/candle-store';

/** The stored EQ bucket the gate queries: its start + when it was last written. */
export interface EqBucketStatus {
  bucketTs: number;
  /** Epoch ms of the last write to this bucket (candle-store `updatedAt`). */
  updatedAtMs: number;
}

export interface CandleFreshness {
  /** The latest FULLY COMPLETED 5-min bucket-start (epoch s) at `nowMs`. */
  requiredBucketTs: number;
  /** The stored bucket-start the gate looked at, or null when absent. */
  latestBucketTs: number | null;
  /** True only when the required bucket exists AND was fetched after it closed. */
  fresh: boolean;
}

/**
 * The latest FULLY COMPLETED 5-min bucket at wall-clock `nowMs` (bar-start, s).
 * The current (forming) bucket is `fyersBucketFor(nowMs)`; the last completed one
 * is a single 5-min period before it.
 */
export function requiredCompletedBucket(nowMs: number): number {
  return fyersBucketFor(nowMs) - FYERS_BUCKET_SEC;
}

/**
 * Evaluate freshness for the REQUIRED completed bucket. Fail-closed: a missing
 * bucket, a bucket written BEFORE it closed (still forming when fetched), a
 * bucket at the wrong start, a NaN/off-grid required bucket, or a non-finite
 * write time all read STALE.
 */
export function evaluateFreshness(row: EqBucketStatus | null, requiredBucketTs: number): CandleFreshness {
  const validRequired =
    Number.isInteger(requiredBucketTs) && requiredBucketTs > 0 && requiredBucketTs % FYERS_BUCKET_SEC === 0;
  const closeMs = (requiredBucketTs + FYERS_BUCKET_SEC) * 1000;
  const fresh =
    validRequired &&
    row != null &&
    row.bucketTs === requiredBucketTs &&
    Number.isFinite(row.updatedAtMs) &&
    row.updatedAtMs >= closeMs;
  return { requiredBucketTs, latestBucketTs: row?.bucketTs ?? null, fresh };
}

/**
 * Best-effort variant for informational callers. A read failure is reported to
 * the caller and represented as missing/stale data; it must not interrupt the
 * surrounding scan. Money-touching entry gates deliberately use the strict
 * store read instead and remain authoritative.
 */
export async function evaluateFreshnessBestEffort(
  requiredBucketTs: number,
  readStatus: () => Promise<EqBucketStatus | null>,
  onError?: (error: unknown) => void
): Promise<CandleFreshness> {
  try {
    return evaluateFreshness(await readStatus(), requiredBucketTs);
  } catch (error) {
    onError?.(error);
    return evaluateFreshness(null, requiredBucketTs);
  }
}
