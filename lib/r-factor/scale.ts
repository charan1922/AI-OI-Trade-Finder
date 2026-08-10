/**
 * The R-Factor presentation scale, and the one function that applies it.
 *
 * DELIBERATELY DEPENDENCY-FREE. Calibrated cutoffs live in files that are
 * otherwise pure constants (lib/trade-suggest/config.ts, breakout-bypass.ts) and
 * are read from both server and client paths; importing the R-Factor engine into
 * them to reach this arithmetic would drag the whole factor library along for two
 * lines of maths. Nothing here imports anything.
 *
 * SCALE HISTORY: 1–5 originally, 1–8 on 2026-07-03, 1–10 on 2026-08-11 (so ours
 * is directly comparable with TradeFinder's board, which runs to about 10). The
 * underlying raw [0,1] scoring has never changed across any of those — only the
 * span it is printed on.
 *
 * WHY A HELPER RATHER THAN NUMBERS. Every calibrated cutoff was chosen as a
 * position on the RAW scale and then written down on whichever span was current.
 * Widening the span without moving those numbers silently loosens all of them:
 * the scanner's MIN_RFACTOR of 3.6 is raw 0.375 on 1–8 but raw 0.289 on 1–10 —
 * a materially laxer trade gate nobody chose. Expressing cutoffs as
 * `rFactorAtRaw(0.375)` states the intent, so the next rescale needs no
 * threshold edits at all.
 */

export const RF_MIN = 1;
export const RF_MAX = 10;

/**
 * R-Factor for a raw [0,1] score — the only place the span is applied.
 *
 * EXACT, not rounded. Rounding here would move every gate that uses it: raw
 * 0.375 maps to 4.375, and rounding that to 4.38 puts the gate at raw 0.3756
 * instead — small, but a threshold should sit exactly where it was calibrated,
 * and nothing forces a comparison to be done at display precision. Callers that
 * SHOW the number round it themselves (the engine rounds its output to 2dp).
 */
export function rFactorAtRaw(raw: number): number {
  return RF_MIN + (RF_MAX - RF_MIN) * raw;
}

/** Where a displayed R-Factor sits on the raw [0,1] scale — the inverse. Useful
 *  when reading a historical value that was recorded on a DIFFERENT span. */
export function rawFromRFactor(rFactor: number, max: number = RF_MAX, min: number = RF_MIN): number {
  return max === min ? 0 : (rFactor - min) / (max - min);
}
