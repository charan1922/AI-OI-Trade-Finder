/**
 * Dhan option-chain read — what the OPTIONS are doing for a given underlying.
 *
 * The surviving half of the retired lib/r-factor-v2 module (deleted 2026-08-11).
 * It is DESCRIPTIVE: /live shows it and the commentary narrates it, but it gates
 * no trade. scripts/measure-option-evidence.ts is why — measured against 91
 * graded suggestions, it agreed with the scanner 89% of the time and did not
 * separate winners from losers. Re-run that study before promoting it.
 */
export { deriveOptionActivityEvidence, OPTION_EVIDENCE_VERSION } from './evidence';
export { getCachedOptionEvidence, scheduleOptionEvidenceShadow } from './shadow';
export {
  ensureOptionChainTable,
  istMinuteOfDay,
  loadSameTimeOptionBaseline,
  OPTION_CHAIN_RETENTION_SESSIONS,
  pruneOptionChainSnapshots,
  recordOptionEvidence,
} from './store';
export type {
  OptionActivityEvidence,
  OptionDirection,
  OptionStrikeEvidence,
  PaceBaselineKind,
} from './types';
