/**
 * Market Simulator — barrel exports.
 *
 * Deterministic historical replay engine that streams a live-like F&O market
 * over SSE. Order execution plugs in later via `replayEngine.onTick(...)`.
 */

export {
  DEFAULT_SIMULATOR_CONFIG,
  dhanInstrumentFor,
  resolveConfig,
  SIM_SPEEDS,
  type SimulatorConfig,
} from './config';
export { type LoadedTimeline, listDatasets, loadTimeline } from './data-source';
export { synthesizeTicks } from './quote-synthesizer';
export { replayEngine, type TickListener } from './replay-engine';
export type {
  SimCandle,
  SimClockState,
  SimDataset,
  SimEvent,
  SimInstrumentKind,
  SimInterval,
  SimLoadedMeta,
  SimQuote,
  SimStatus,
} from './types';
