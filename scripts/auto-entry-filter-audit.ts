/**
 * Read-only comparison of proposed entry confirmations over retained sessions.
 * Production logic is not changed; every extra filter exists only in replay-lib.
 *
 * Usage:
 *   npx tsx scripts/auto-entry-filter-audit.ts
 *   npx tsx scripts/auto-entry-filter-audit.ts 2026-07-20 2026-07-21 2026-07-22
 */
import { describeVariantDrift, evaluateDay, loadDay, loadLiveVariant, type Variant } from './replay-lib';

const defaultDates = ['2026-07-15', '2026-07-16', '2026-07-17', '2026-07-20', '2026-07-21', '2026-07-22'];
const dates = process.argv.slice(2).filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value));
const sessions = dates.length > 0 ? dates : defaultDates;
// Baseline = the LIVE toggles, not the config.ts defaults; auditing a filter
// against a config nobody runs measures the wrong system (see replay-lib.ts).
const BASE = await loadLiveVariant();
const drift = describeVariantDrift(BASE);
if (drift.length > 0) console.log(`Baseline: live feature_toggles — differs from config.ts:\n  ${drift.join('\n  ')}\n`);
const variants: Variant[] = [
  BASE,
  { ...BASE, name: 'no-supertrend', requireSupertrendAlign: false },
  {
    ...BASE,
    name: 'confirmed-orb-volume-sector',
    requireConfirmedOrb: true,
    minBreakoutVolumeRatio: 1.2,
    requireSectorAlign: true,
  },
  {
    ...BASE,
    name: 'confirmed-orb-volume-sector-no-ST',
    requireConfirmedOrb: true,
    minBreakoutVolumeRatio: 1.2,
    requireSectorAlign: true,
    requireSupertrendAlign: false,
  },
];

for (const variant of variants) {
  let picks = 0;
  let targets = 0;
  let stops = 0;
  let totalR = 0;
  let allPicks = 0;
  let allTargets = 0;
  let allStops = 0;
  let allTotalR = 0;
  const days: string[] = [];
  for (const date of sessions) {
    const day = loadDay(date);
    if (!day) continue;
    const result = evaluateDay(day, variant);
    picks += result.picks.length;
    targets += result.targets;
    stops += result.stops;
    totalR += result.totalR;
    const all = evaluateDay(day, variant, { allFires: true });
    allPicks += all.picks.length;
    allTargets += all.targets;
    allStops += all.stops;
    allTotalR += all.totalR;
    days.push(`${date}:${result.picks.map((pick) => `${pick.p.symbol}/${pick.o.hit}`).join(',') || 'none'}`);
  }
  console.log(
    JSON.stringify({
      variant: variant.name,
      capped: { picks, targets, stops, totalR: Number(totalR.toFixed(2)) },
      all: { picks: allPicks, targets: allTargets, stops: allStops, totalR: Number(allTotalR.toFixed(2)) },
      days,
    })
  );
}
