/**
 * Capped priority-refresh — defaults (see ../../final-capped-priority-sector-plan.md §2).
 *
 * These constants are the DEFAULTS. Like the rest of the app, runtime overrides
 * live in the feature_toggles table and are read with getToggle/getNumberSetting
 * once the poller wiring lands in a later PR. Until then these are the values
 * the pure planner + tests use.
 *
 * Safety posture (why these defaults):
 *  - USE_CAPPED_PRIORITY_REFRESH = OFF  → the poller keeps waiting for the full
 *    priority set; capped mode is opt-in only after shadow evidence.
 *  - BLOCK_STALE_AUTO_ENTRY = ON        → a new auto-trade entry is never taken
 *    on an outdated 5-min candle. Exits/guards are never affected.
 *  - *_SHADOW = ON                      → measure the reduced plan + sector
 *    promotion without changing what the poller actually waits for.
 *  - PRIORITY_INCLUDE_ACTIVE_SECTORS = OFF → sector promotion does not influence
 *    the live capped selection yet (shadow-measured first).
 */
import type { PriorityFeed } from './types';

// ── Boolean settings ────────────────────────────────────────────────────────
export const PRIORITY_REFRESH_SHADOW = true;
export const USE_CAPPED_PRIORITY_REFRESH = false;
export const BLOCK_STALE_AUTO_ENTRY = true;
export const PRIORITY_ACTIVE_SECTORS_SHADOW = true;
export const PRIORITY_INCLUDE_ACTIVE_SECTORS = false;

// ── Numeric settings ─────────────────────────────────────────────────────────
/** Eligible names considered per feed (rank 1..N of body.picks). */
export const PRIORITY_PER_FEED = 10;
/** Hard cap on unique Tier 1 symbols (Tier 0 is outside this cap). */
export const PRIORITY_MAX_UNIQUE = 40;
/** Of the Tier 1 cap, how many slots are reserved for sector promotion. */
export const PRIORITY_SECTOR_RESERVED_SLOTS = 10;
/** Active sectors selected per side (bullish / bearish). */
export const PRIORITY_TOP_SECTORS_PER_SIDE = 2;
/** Max age of a stored sector snapshot before sector promotion is skipped (s). */
export const PRIORITY_SECTOR_MAX_AGE_SEC = 120;
/** Only sectors within the top-N by turnover are eligible to qualify as active
 *  (plan §10 "rank sectors by total turnover"). Internal — not a /config knob. */
export const PRIORITY_HIGH_TURNOVER_SECTORS = 6;
/** Retain this many trading sessions of sector snapshots + cycle telemetry. */
export const PRIORITY_RETENTION_SESSIONS = 20;

/**
 * Fair round-robin order. OI first (the strongest institutional signal), then
 * gainers/losers (both directions), then the two most-active feeds. One feed
 * can never consume the whole cap — round N takes rank N from each feed in turn.
 */
export const FEED_ORDER: readonly PriorityFeed[] = [
  'nse-oi',
  'nse-gainers',
  'nse-losers',
  'nse-active-value',
  'nse-active-volume',
] as const;
