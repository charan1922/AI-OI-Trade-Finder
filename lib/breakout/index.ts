/**
 * TradeFinder-style breakout detection — barrel.
 *
 * Strategy source: R-Obsidian vault, wiki/setups/entry-setups.md
 * § "Breakout confirmation — 3 checks" (morning test · R-Factor efficiency ·
 * multi-level aggression).
 */

export {
  deriveBreakoutContext,
  evaluateBreakout,
  EFFICIENCY_MIN_RFACTOR,
  MORNING_BREAK_TOLERANCE_PCT,
  type DetectorOptions,
} from './detector';
export { buildLevels, type LevelInputs } from './levels';
export { deriveMorningTest, MORNING_WINDOW_MIN } from './morning-test';
export { detectSwings, SWING_K, type SwingBar, type SwingPoint } from './swings';
export type {
  BreakoutContext,
  BreakoutGrade,
  BreakoutLevel,
  BreakoutSignal,
  MorningTestState,
} from './types';
