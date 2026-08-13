/**
 * Candle-freshness defaults.
 *
 * This file used to hold the capped priority-refresh planner's settings too; the
 * shadow-measurement feature it served was removed on 2026-08-13 (panel, API,
 * poller hook, planner and telemetry tables all deleted). What remains is the
 * ONE live safety switch, kept here because the gate it controls lives next to
 * it in freshness.ts.
 *
 * Like the rest of the app this constant is the DEFAULT; the runtime override
 * lives in the feature_toggles table and is read with getToggle().
 *
 * Safety posture: BLOCK_STALE_AUTO_ENTRY = ON → a new auto-trade entry is never
 * taken on an outdated 5-min candle. Exits/guards are never affected.
 */
export const BLOCK_STALE_AUTO_ENTRY = true;
