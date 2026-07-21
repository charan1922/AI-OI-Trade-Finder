/**
 * Capped priority-refresh planner — barrel exports.
 * Foundation PR: pure planner + config + types only. Poller wiring, the sector
 * snapshot producer, freshness gate and telemetry land in later PRs (all behind
 * OFF-by-default toggles, shadow-first — see ../../final-capped-priority-sector-plan.md).
 */
export * from './types';
export * from './config';
export { selectRoundRobinCandidates } from './round-robin';
export { qualifySectorDirection, selectActiveSectors, selectSectorPromotions } from './sector-signal';
export { buildPriorityPlan, type BuildPriorityPlanInput } from './build-plan';
