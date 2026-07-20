/**
 * Profit-protection SHADOW report — reads the same-day counterfactual R that
 * review.ts records on every RESOLVED scanner pick (trade_suggestions.
 * protectShadow) and compares each candidate profit-protection rule against the
 * fixed-plan baseline. This is the evidence to decide whether a "move the stop
 * up once in profit" rule earns its place LIVE.
 *
 * Complements quant-shadow-report.ts (which reads the handful of EXECUTED
 * auto_trades); this reads the far more numerous scanner picks, so the
 * calibration fills in faster. Nothing here changes trading — read-only.
 *
 * Run:  npx tsx scripts/profit-protect-report.ts [--since YYYY-MM-DD] [--db path]
 * On the box:  docker exec projectr npx tsx scripts/profit-protect-report.ts
 */
import Database from 'better-sqlite3';
import { type ProtectAggRow, aggregateProtection, parseProtectBlob } from '../lib/trade-suggest/profit-protect';

const args = process.argv.slice(2);
const argVal = (flag: string): string | null => {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};
const dbPath = argVal('--db') ?? './data/project-r.db';
const since = argVal('--since') ?? '0000-00-00';

const RESOLVED = new Set(['target', 'stop', 'timeout']);
const f = (n: number | null, d = 2) => (n == null ? '—' : n.toFixed(d));

const db = new Database(dbPath, { readonly: true });
const cols = new Set((db.prepare(`PRAGMA table_info(trade_suggestions)`).all() as { name: string }[]).map((c) => c.name));
if (!cols.has('protectShadow')) {
  console.log('No protectShadow column yet — the app must boot the new code once (ensureSuggestionsTable adds it). Nothing to report.');
  process.exit(0);
}

interface Row {
  date: string;
  symbol: string;
  optionType: string;
  spotOutcome: string | null;
  spotOutcomeR: number | null;
  protectShadow: string | null;
}

const rows = db
  .prepare(
    `SELECT date, symbol, optionType, spotOutcome, spotOutcomeR, protectShadow
       FROM trade_suggestions
      WHERE date >= ? AND outcomeAt IS NOT NULL AND protectShadow IS NOT NULL
      ORDER BY date, symbol`,
  )
  .all(since) as Row[];

// Only rows with a resolved baseline R contribute (like-for-like comparison).
// Same PURE aggregation the app uses (aggregateProtection) — single source of math.
const aggRows: ProtectAggRow[] = rows
  .filter((r) => r.spotOutcome != null && RESOLVED.has(r.spotOutcome) && r.spotOutcomeR != null)
  .map((r) => {
    const { version, rules } = parseProtectBlob(r.protectShadow);
    return { baseR: Number(r.spotOutcomeR as number), version, rules };
  });
const agg = aggregateProtection(aggRows);

if (agg.n === 0) {
  console.log(`No resolved scanner picks with a profit-protection blob on or after ${since} (db: ${dbPath}).`);
  console.log('These accrue at review time — expect this empty until a session (or a regrade) grades picks.');
  process.exit(0);
}

console.log(`\n=== Profit-protection SHADOW report — ${agg.n} resolved pick(s) since ${since} (db: ${dbPath}) ===`);
console.log('Each rule is a TIGHTEN-ONLY stop move; measurement only. R is THEORETICAL (level-fill), matched to');
console.log(`the baseline grader — gap slippage ignored on both sides. Model _v${agg.version}. Baseline mean R: ${f(agg.baselineAvgR)}`);
if (agg.excludedLegacy > 0 || agg.excludedOtherVersion > 0) {
  console.log(
    `Excluded to avoid mixing versions: ${agg.excludedLegacy} unversioned (pre-_v) + ${agg.excludedOtherVersion} other-version row(s). ` +
      'Regrade a retained session to refresh those to the current version.',
  );
}
console.log('');

console.log(['rule', 'n', 'avgR', 'baseR', 'ΔR', 'savedStops', 'hurt'].map((h) => h.padEnd(18)).join(''));
for (const r of agg.rules) {
  const d = r.deltaR;
  console.log(
    [r.name, r.n, f(r.avgR), f(r.baselineAvgR), (d != null && d >= 0 ? '+' : '') + f(d), r.savedStops, r.hurt]
      .map((c) => String(c).padEnd(18))
      .join(''),
  );
}

console.log('\nΔR > 0 means the rule beat the fixed plan on these picks. "savedStops" = losers rescued to ≥0R;');
console.log('"hurt" = picks the rule made worse (e.g. scratched on a wick that would have run). Read as direction,');
console.log('not proof, until dozens of resolved picks accrue.\n');
