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
import { PROTECT_PRESETS } from '../lib/trade-suggest/profit-protect';

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

const parseBlob = (v: string | null): Record<string, number> => {
  try {
    const p = JSON.parse(v ?? '{}');
    if (!p || typeof p !== 'object') return {};
    const out: Record<string, number> = {};
    for (const [k, val] of Object.entries(p)) if (typeof val === 'number') out[k] = val;
    return out;
  } catch {
    return {};
  }
};

// Only rows with a resolved baseline R contribute (like-for-like comparison).
const usable = rows
  .filter((r) => r.spotOutcome != null && RESOLVED.has(r.spotOutcome) && r.spotOutcomeR != null)
  .map((r) => ({ ...r, baseR: Number(r.spotOutcomeR), blob: parseBlob(r.protectShadow) }))
  .filter((r) => Number.isFinite(r.baseR));

if (usable.length === 0) {
  console.log(`No resolved scanner picks with a profit-protection blob on or after ${since} (db: ${dbPath}).`);
  console.log('These accrue same-day only (candles clear nightly) — expect this empty until a live session grades picks.');
  process.exit(0);
}

const avg = (v: number[]) => (v.length === 0 ? null : v.reduce((a, b) => a + b, 0) / v.length);
const baselineAvg = avg(usable.map((r) => r.baseR));

console.log(`\n=== Profit-protection SHADOW report — ${usable.length} resolved pick(s) since ${since} (db: ${dbPath}) ===`);
console.log('Each rule is a TIGHTEN-ONLY stop move; measurement only — nothing here is live.');
console.log(`Baseline (fixed plan) mean R over these picks: ${f(baselineAvg)}\n`);

console.log(['rule', 'n', 'avgR', 'baseR', 'ΔR', 'savedStops', 'hurt'].map((h) => h.padEnd(18)).join(''));
for (const rule of PROTECT_PRESETS) {
  const paired = usable.filter((r) => Number.isFinite(r.blob[rule.name]));
  if (paired.length === 0) {
    console.log([rule.name, '0', '—', '—', '—', '—', '—'].map((c) => String(c).padEnd(18)).join(''));
    continue;
  }
  const ruleAvg = avg(paired.map((r) => r.blob[rule.name]));
  const baseAvg = avg(paired.map((r) => r.baseR));
  const delta = ruleAvg != null && baseAvg != null ? ruleAvg - baseAvg : null;
  const saved = paired.filter((r) => r.baseR <= -1 && r.blob[rule.name] >= 0).length;
  const hurt = paired.filter((r) => r.blob[rule.name] < r.baseR).length;
  console.log(
    [rule.name, paired.length, f(ruleAvg), f(baseAvg), (delta != null && delta >= 0 ? '+' : '') + f(delta), saved, hurt]
      .map((c) => String(c).padEnd(18))
      .join(''),
  );
}

console.log('\nΔR > 0 means the rule beat the fixed plan on these picks. "savedStops" = losers rescued to ≥0R;');
console.log('"hurt" = picks the rule made worse (e.g. scratched on a wick that would have run). Read as direction,');
console.log('not proof, until dozens of resolved picks accrue.\n');
