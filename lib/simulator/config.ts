/**
 * Market Simulator — configuration.
 *
 * Every tunable knob lives here as a single typed object so the engine, the API
 * and the UI share one source of truth. `DEFAULT_SIMULATOR_CONFIG` is the seed;
 * the UI overrides individual fields when loading a session.
 */

import type { SimInstrumentKind, SimInterval } from './types';

export interface SimulatorConfig {
  // -- instrument --
  /** Underlying / trading symbol (e.g. "RELIANCE"). */
  symbol: string;
  /** What to replay — equity, stock future, or stock option. */
  instrumentKind: SimInstrumentKind;
  /** Dhan exchange segment (resolved from instrumentKind). */
  segment: string;
  /** Resolved Dhan security id (filled in by the data source). */
  securityId: string;
  /** Lot size — used for value/turnover math on F&O. */
  lotSize: number;

  // -- replay window --
  /** Inclusive start date, YYYY-MM-DD. */
  fromDate: string;
  /** Inclusive end date, YYYY-MM-DD. */
  toDate: string;
  /** Candle granularity to fetch and replay. */
  interval: SimInterval;

  // -- clock --
  /**
   * Playback speed multiplier. Real emit interval = `baseTickMs / speed`.
   * 1 = lifelike, 4 = 4× faster, etc.
   */
  speed: number;
  /** Base wall-clock gap between ticks at speed 1, in ms. */
  baseTickMs: number;
  /**
   * Emitted ticks per candle.
   * **1 (default) = pure real data**: every step is one real OHLCV+OI bar, no
   * fabrication. Values > 1 interpolate a synthetic intra-bar path between the
   * real open and close — smoother motion, but the in-between prices are NOT
   * real. Keep at 1 for honest backtesting; download a finer interval (e.g.
   * 1-min) if you want more granular *real* movement.
   */
  ticksPerCandle: number;
  /** Start paused instead of auto-playing once loaded. */
  startPaused: boolean;
  /** Restart from the top when the timeline finishes. */
  loop: boolean;

  // -- synthesis --
  /** Deterministic seed for the intra-candle price path. */
  seed: number;
}

export const DEFAULT_SIMULATOR_CONFIG: SimulatorConfig = {
  symbol: 'RELIANCE',
  instrumentKind: 'FUTSTK',
  segment: 'NSE_FNO',
  securityId: '',
  lotSize: 1,

  fromDate: '',
  toDate: '',
  interval: '5',

  speed: 1,
  baseTickMs: 700,
  ticksPerCandle: 1, // one real candle per step — no fabricated intra-bar prices
  startPaused: true,
  loop: false,

  seed: 1337,
};

/** Map an instrument kind to its Dhan segment + chart `instrument` token. */
export function dhanInstrumentFor(kind: SimInstrumentKind): { segment: string; instrument: string } {
  switch (kind) {
    case 'EQUITY':
      return { segment: 'NSE_EQ', instrument: 'EQUITY' };
    case 'FUTSTK':
      return { segment: 'NSE_FNO', instrument: 'FUTSTK' };
    case 'OPTSTK':
      return { segment: 'NSE_FNO', instrument: 'OPTSTK' };
  }
}

/** Allowed playback speeds surfaced in the UI. */
export const SIM_SPEEDS = [0.5, 1, 2, 4, 8, 16, 60] as const;

/** Merge a partial override onto the defaults, coercing/clamping numeric knobs. */
export function resolveConfig(partial: Partial<SimulatorConfig>): SimulatorConfig {
  const merged = { ...DEFAULT_SIMULATOR_CONFIG, ...partial };
  merged.speed = clamp(merged.speed, 0.1, 240);
  merged.baseTickMs = clamp(merged.baseTickMs, 20, 5000);
  merged.ticksPerCandle = Math.round(clamp(merged.ticksPerCandle, 1, 240));
  return merged;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
