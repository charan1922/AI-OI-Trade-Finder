/**
 * Re-grade persisted /trade-suggest picks over the RETAINED candle history.
 *
 * grade.ts / profit-protect.ts are pure and idempotent, and fyers_candles keeps
 * the newest ~20 sessions (FYERS_CANDLE_RETENTION_SESSIONS), so a grader bug fix
 * can be re-applied to past sessions — no need to wait for new live days. This
 * regrades every date that has BOTH persisted picks AND retained candles, then
 * prints the honest scorecard + the profit-protection shadow comparison.
 *
 * Run:  npx tsx scripts/regrade-suggestions.ts [--date YYYY-MM-DD ...]
 * On the box:  docker exec projectr npx tsx scripts/regrade-suggestions.ts
 *
 * With no --date it auto-selects the intersection of pick-dates and candle-dates.
 * Read-only on candles; only rewrites the outcome columns of trade_suggestions.
 */
// Node's built-in env loader — no `dotenv` dependency (it is not in package.json
// and was never installed). try/catch preserves dotenv's silent no-op when the
// file is absent; process.loadEnvFile throws.
try {
  process.loadEnvFile('.env.local');
} catch {
  // no .env.local — fall through to whatever is already in the environment
}

import { prisma } from '../lib/db';
import { reviewDate } from '../lib/trade-suggest/review';
import { getProtectionStats, getStats } from '../lib/trade-suggest/store';

const args = process.argv.slice(2);
const cliDates = args.reduce<string[]>((acc, a, i) => {
  if (a === '--date' && args[i + 1]) acc.push(args[i + 1]);
  return acc;
}, []);

async function distinct(col: string): Promise<Set<string>> {
  const rows = await prisma.$queryRawUnsafe<{ date: string }[]>(`SELECT DISTINCT date FROM ${col} ORDER BY date`);
  return new Set(rows.map((r) => r.date));
}

async function main(): Promise<void> {
  const pickDates = await distinct('trade_suggestions');
  const candleDates = await distinct('fyers_candles');
  const gradable = [...pickDates].filter((d) => candleDates.has(d)).sort();
  const dates = cliDates.length > 0 ? cliDates : gradable;

  console.log(`\n=== Re-grade /trade-suggest picks over retained candles ===`);
  console.log(`pick-dates: ${pickDates.size} · candle-dates: ${[...candleDates].sort().join(', ') || '(none)'}`);
  const ungradable = [...pickDates].filter((d) => !candleDates.has(d)).sort();
  if (ungradable.length > 0) {
    console.log(`NOT gradable (picks exist but candles pruned): ${ungradable.join(', ')}`);
  }
  if (dates.length === 0) {
    console.log('\nNothing to regrade — no date has both picks and retained candles.');
    process.exit(0);
  }

  console.log(`\nRegrading ${dates.length} date(s): ${dates.join(', ')}\n`);
  for (const date of dates) {
    const res = await reviewDate(date);
    console.log(`  ${date}: reviewed ${res.reviewed}, skipped ${res.skipped}`);
  }

  // Report over the SAME window we just regraded (covers all recent dates).
  const days = 60;
  const stats = await getStats(days);
  console.log(`\n=== Honest scorecard (resolved rows only, last ${days}d) ===`);
  console.log(
    `  reviewed ${stats.reviewed} | honest ${stats.honestReviewed} | unresolvable ${stats.unresolvable} | legacy ${stats.legacyReviewed}`,
  );
  console.log(
    `  win ${stats.hits}/${stats.honestReviewed}` +
      ` (${stats.hitRatePct ?? '—'}%) | avg R ${stats.avgOutcomeR ?? '—'}` +
      ` | avg favorable ${stats.avgFavorablePct ?? '—'}% | avg adverse ${stats.avgAdversePct ?? '—'}%`,
  );

  const prot = await getProtectionStats(days);
  console.log(`\n=== Profit-protection shadow (n=${prot.n}, baseline avg R ${prot.baselineAvgR ?? '—'}) ===`);
  if (prot.n === 0) {
    console.log('  No resolved rows carry a protection blob yet (regrade writes it going forward).');
  } else {
    console.log(['rule', 'n', 'avgR', 'baseR', 'ΔR', 'saved', 'hurt'].map((h) => String(h).padEnd(18)).join(''));
    for (const r of prot.rules) {
      const d = r.deltaR;
      console.log(
        [r.name, r.n, r.avgR ?? '—', r.baselineAvgR ?? '—', (d != null && d >= 0 ? '+' : '') + (d ?? '—'), r.savedStops, r.hurt]
          .map((c) => String(c).padEnd(18))
          .join(''),
      );
    }
  }
  console.log('\n(Sparse until many resolved picks accrue — read as direction, not proof.)\n');
  process.exit(0);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
