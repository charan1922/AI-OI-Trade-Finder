/**
 * Tiny deterministic PRNG (mulberry32).
 *
 * The simulator must be reproducible: the same recorded data + the same config
 * seed must always yield the same intra-candle price path. `Math.random()` would
 * break that, so all path randomness flows through a seeded generator instead.
 */

export interface Prng {
  /** Next float in [0, 1). */
  next(): number;
  /** Float in [min, max). */
  range(min: number, max: number): number;
  /** Symmetric noise in [-magnitude, +magnitude). */
  noise(magnitude: number): number;
}

export function createPrng(seed: number): Prng {
  let state = seed >>> 0 || 1;

  const next = (): number => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    range: (min, max) => min + next() * (max - min),
    noise: (magnitude) => (next() * 2 - 1) * magnitude,
  };
}
