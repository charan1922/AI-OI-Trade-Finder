/**
 * PURE config-drift checks — no DB, no clocks. Exercises buildConfigOverrideSummary
 * (the value≠default detector behind the pre-open reminder) so the safety
 * feature is covered in CI, not only claimed (PR#2 review 2026-07-20). Run by
 * both the box bench and the DB-free CI runner (scripts/verify-quant-shadow.ts).
 */
import { buildConfigOverrideSummary } from '../lib/config/feature-toggles';

export type CheckFn = (name: string, ok: boolean, detail?: string) => void;

// Minimal fixtures matching the ToggleState / NumberState shapes the real
// getAllToggles / getAllNumberSettings return.
const toggle = (label: string, category: string, value: boolean, def: boolean) => ({ label, category, value, default: def });
const number = (key: string, label: string, category: string, value: number, def: number, min: number) => ({
  key, label, category, value, default: def, min,
});

export function runConfigDriftChecks(check: CheckFn): void {
  // 1. A non-default 'Trade Suggest' toggle appears.
  const s1 = buildConfigOverrideSummary(
    [toggle('Extended-trend bypass', 'Trade Suggest', true, false)],
    []
  );
  check('config-drift: non-default Trade Suggest toggle appears', s1.length === 1 && s1[0].includes('Extended-trend bypass') && s1[0].includes('ON') && s1[0].includes('safe default OFF'), s1[0]);

  // 2. A toggle AT its default is excluded.
  const s2 = buildConfigOverrideSummary([toggle('Skip already-extended movers', 'Trade Suggest', true, true)], []);
  check('config-drift: toggle at default is excluded', s2.length === 0);

  // 3. A NON-default toggle in another category (Server) is excluded.
  const s3 = buildConfigOverrideSummary([toggle('Auto power-off', 'Server', true, false)], []);
  check('config-drift: non-Trade-Suggest (Server) toggle excluded', s3.length === 0);

  // 4. A non-default numeric scanner setting (MAX_PICKS, Trade Suggest) is included.
  const s4 = buildConfigOverrideSummary([], [number('MAX_PICKS', 'Max picks per scan', 'Trade Suggest', 7, 3, 1)]);
  check('config-drift: numeric Trade Suggest override included', s4.length === 1 && s4[0].includes('Max picks per scan') && s4[0].includes('7') && s4[0].includes('safe default 3'), s4[0]);

  // 5. A drifted window TIME (Entry & Exit Times) is included AND rendered HH:MM.
  const s5 = buildConfigOverrideSummary([], [number('WINDOW_END_MIN', 'Scan window closes (min IST)', 'Entry & Exit Times', 870, 660, 600)]);
  check('config-drift: window-time drift included and shown HH:MM', s5.length === 1 && s5[0].includes('14:30') && s5[0].includes('safe default 11:00'), s5[0]);

  // 6. A numeric AT its default is excluded.
  const s6 = buildConfigOverrideSummary([], [number('WINDOW_START_MIN', 'Scan window opens (min IST)', 'Entry & Exit Times', 580, 580, 555)]);
  check('config-drift: numeric at default excluded', s6.length === 0);

  // 7. A numeric in an unrelated category is excluded even when drifted.
  const s7 = buildConfigOverrideSummary([], [number('SOME_OTHER', 'Unrelated knob', 'Server', 5, 1, 0)]);
  check('config-drift: unrelated-category numeric excluded', s7.length === 0);

  // 8. Mixed set: counts only the drifted, relevant ones.
  const s8 = buildConfigOverrideSummary(
    [
      toggle('Breakout bypass', 'Trade Suggest', true, false), // in
      toggle('TF breakout gate', 'Trade Suggest', false, false), // out (default)
      toggle('Auto power-off', 'Server', true, false), // out (category)
    ],
    [
      number('MAX_PICKS', 'Max picks per scan', 'Trade Suggest', 5, 3, 1), // in
      number('COMMENTARY_ENTRY_CUTOFF_MIN', 'Commentary entry cutoff (min IST)', 'Entry & Exit Times', 750, 750, 660), // out (default)
    ]
  );
  check('config-drift: mixed set counts only drifted+relevant', s8.length === 2, `got ${s8.length}: ${JSON.stringify(s8)}`);
}
