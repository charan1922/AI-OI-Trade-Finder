/**
 * R-Factor — a self-contained, dependency-free library that scores a stock's
 * "R-Factor": institutional-interest STRENGTH (1.0–5.0) plus a directional BIAS,
 * from market data the caller supplies. No Dhan / Prisma / NSE / Next imports.
 *
 * Quick start:
 *   import { computeRFactor } from '@/lib/r-factor';
 *   const r = computeRFactor({ symbol, ltp, priceChangePct, futOi, ... , now: new Date() });
 *
 * Every factor is also exported standalone (each is a pure function). See README.md.
 */

// Orchestrator.
export { computeRFactor, DEFAULT_WEIGHTS } from './engine';
export type { RFactorConfig } from './engine';

// Individual factor functions (pure, independently usable).
export { futuresOiSignal, oiDirectionSignal, oiVsTwentyDaySignal } from './oi';
export { callOptionOiSignal, putOptionOiSignal, pcrSignal } from './options';
export { smartMoneyAccumulationSignal, turnoverSignal, volumeSignal } from './flow';
export { bidAskSpreadSignal } from './microstructure';
export { rangeSpreadSignal } from './range-spread';
export { breakoutSignal } from './breakout';
export { majoritySignal } from './majority';
export type { MajorityResult } from './majority';
export { isAfterEntryTime } from './timing';
export type { EntryTimeStatus } from './timing';

// Math primitives (handy for tests and custom factors).
export { clamp, round, isPos, safeDiv, pctChange, scoreFromRatio, scoreFromMagnitude, direction } from './math';

// Types.
export type { Vote, FactorKey, FactorScore, RFactorInput, RFactorWeights, RFactorResult } from './types';
