/** Bars sit on this grid (seconds) — 5-minute candles, bar-start stamps. */
export const FYERS_BUCKET_SEC = 300;

/** Floor an epoch-ms wall clock to the 5-minute bar-start (epoch seconds). */
export function fyersBucketFor(nowMs: number): number {
  return Math.floor(nowMs / 1000 / FYERS_BUCKET_SEC) * FYERS_BUCKET_SEC;
}
