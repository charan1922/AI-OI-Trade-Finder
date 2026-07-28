/**
 * Autonomous experiment loop over the trade-suggest engine — a faithful port
 * of github.com/karpathy/autoresearch's method to this domain:
 *
 *   autoresearch                     →  here
 *   ─────────────────────────────────────────────────────────────────────
 *   train.py (the mutable artifact)  →  engine config (weights + gates)
 *   fixed 5-min training run         →  point-in-time replay of recorded
 *                                       sessions (scripts/replay-lib.ts)
 *   val_bpb (single metric, lower✓)  →  mean ΣR across recorded days
 *                                       (single metric, higher ✓)
 *   keep-or-discard each experiment  →  strict hill-climb accept (>)
 *   experiment journal               →  tracking/autoresearch-log.jsonl
 *
 * Each experiment mutates ONE knob (a weight shift, a gate threshold, the
 * ATR floor, extended handling), replays every recorded session with zero
 * lookahead, and keeps the mutation only if the metric strictly improves.
 * Every experiment — accepted or not — is journaled with its full config so
 * runs are auditable and reproducible (seeded RNG).
 *
 * Guard rails:
 * - A day with ZERO picks scores −0.25 (a config that never trades must not
 *   beat a config that trades and modestly wins).
 * - The loop NEVER writes the accepted config into lib/trade-suggest/config.ts.
 *   It prints the winner + the shipped baseline; a human ships changes, and
 *   only with ≥3 recorded days of evidence (n=1 day overfits trivially —
 *   autoresearch itself works because every experiment gets a fresh
 *   validation signal; our signal grows one day per trading day).
 *
 * Run:  npx tsx scripts/autoresearch.ts [experiments=60] [seed=42]
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import {
  describeVariantDrift,
  evaluateDay,
  listRecordedDates,
  loadDay,
  loadLiveVariant,
  type DayData,
  type Variant,
} from './replay-lib';

const N_EXPERIMENTS = Number(process.argv[2] ?? 60);
const SEED = Number(process.argv[3] ?? 42);
const JOURNAL = 'tracking/autoresearch-log.jsonl';

// Seeded PRNG (mulberry32) — reproducible experiment streams.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const choice = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const r3 = (v: number) => Math.round(v * 1000) / 1000;

// ─── Mutation operators (one knob per experiment, like one-diff-per-run) ────
function mutate(base: Variant, expNo: number): { variant: Variant; description: string } {
  const v: Variant = { ...base, weights: { ...base.weights }, rfWeights: { ...base.rfWeights }, name: `exp-${expNo}` };
  const op = choice([
    'weight-shift',
    'weight-shift',
    'rf-weight-shift',
    'rf-weight-shift',
    'rf-weight-shift', // R-Factor internal blend — the user's calibration target
    'gate-rfactor',
    'gate-oilevel',
    'gate-nseoi',
    'gate-confidence',
    'atr-floor',
    'extended',
  ]);
  switch (op) {
    case 'rf-weight-shift': {
      const keys = Object.keys(v.rfWeights) as (keyof typeof v.rfWeights)[];
      const from = choice(keys);
      let to = choice(keys);
      while (to === from) to = choice(keys);
      const eps = choice([0.02, 0.04]);
      const moved = Math.min(eps, v.rfWeights[from]);
      v.rfWeights[from] = r3(v.rfWeights[from] - moved);
      v.rfWeights[to] = r3(v.rfWeights[to] + moved);
      return { variant: v, description: `rfWeights: ${String(from)} −${moved} → ${String(to)}` };
    }
    case 'weight-shift': {
      const keys = Object.keys(v.weights) as (keyof typeof v.weights)[];
      const from = choice(keys);
      let to = choice(keys);
      while (to === from) to = choice(keys);
      const eps = choice([0.02, 0.05]);
      const moved = Math.min(eps, v.weights[from]);
      v.weights[from] = r3(v.weights[from] - moved);
      v.weights[to] = r3(v.weights[to] + moved);
      return { variant: v, description: `weights: ${String(from)} −${moved} → ${String(to)}` };
    }
    case 'gate-rfactor': {
      const d = choice([-0.2, 0.2]);
      v.minRFactor = r3(clamp(base.minRFactor + d, 3.0, 4.4));
      return { variant: v, description: `minRFactor ${base.minRFactor} → ${v.minRFactor}` };
    }
    case 'gate-oilevel': {
      const d = choice([-0.05, 0.05]);
      v.minOiLevel = r3(clamp(base.minOiLevel + d, 1.0, 1.3));
      return { variant: v, description: `minOiLevel ${base.minOiLevel} → ${v.minOiLevel}` };
    }
    case 'gate-nseoi': {
      const d = choice([-1, 1]);
      v.minNseOiPct = clamp(base.minNseOiPct + d, 3, 8);
      return { variant: v, description: `minNseOiPct ${base.minNseOiPct} → ${v.minNseOiPct}` };
    }
    case 'gate-confidence': {
      const d = choice([-0.05, 0.05]);
      v.minConfidence = r3(clamp(base.minConfidence + d, 0.1, 0.4));
      return { variant: v, description: `minConfidence ${base.minConfidence} → ${v.minConfidence}` };
    }
    case 'atr-floor': {
      v.atrMult = choice([0, 0.5, 1.0, 1.5].filter((m) => m !== base.atrMult));
      return { variant: v, description: `atrMult ${base.atrMult} → ${v.atrMult}` };
    }
    default: {
      // extended handling: toggle the ban, or vary the penalty on the off path
      if (rand() < 0.5) {
        v.banExtended = !base.banExtended;
        return { variant: v, description: `banExtended ${base.banExtended} → ${v.banExtended}` };
      }
      v.extendedMult = choice([0.4, 0.6, 0.8, 1.0].filter((m) => m !== base.extendedMult));
      return { variant: v, description: `extendedMult ${base.extendedMult} → ${v.extendedMult}` };
    }
  }
}

// ─── Metric: mean ΣR across recorded days; a 0-pick day scores −0.25 ────────
function metricOf(days: DayData[], v: Variant): { metric: number; perDay: { date: string; totalR: number; picks: number; targets: number; stops: number }[] } {
  const perDay = days.map((d) => {
    const r = evaluateDay(d, v);
    return { date: d.date, totalR: r.totalR, picks: r.picks.length, targets: r.targets, stops: r.stops };
  });
  const metric = perDay.reduce((a, d) => a + (d.picks === 0 ? -0.25 : d.totalR), 0) / perDay.length;
  return { metric: r3(metric), perDay };
}

// ─── The loop ────────────────────────────────────────────────────────────────
const dates = listRecordedDates();
const days = dates.map(loadDay).filter((d): d is DayData => d !== null);
const usableDates = new Set(days.map((d) => d.date));
const skipped = dates.filter((d) => !usableDates.has(d));
if (skipped.length > 0) {
  console.log(
    `skipping ${skipped.length} date(s) with no 5-min candle coverage (oi_intraday only — not replayable): ${skipped.join(', ')}`,
  );
}
if (days.length === 0) {
  console.error('No replayable sessions (need both oi_intraday AND fyers_candles for a date).');
  process.exit(1);
}
mkdirSync('tracking', { recursive: true });
const runId = `${new Date().toISOString()}·seed${SEED}·n${N_EXPERIMENTS}`;
const journal = (rec: Record<string, unknown>) => appendFileSync(JOURNAL, `${JSON.stringify({ runId, ...rec })}\n`);

// Search starts from what the box ACTUALLY runs (feature_toggles), not the
// config.ts defaults — otherwise every "accepted" mutation is measured against
// a system nobody trades (see loadLiveVariant in replay-lib.ts).
const LIVE_BASE = await loadLiveVariant();
let best: Variant = { ...LIVE_BASE, weights: { ...LIVE_BASE.weights } };
const baseline = metricOf(days, best);
let bestMetric = baseline.metric;
console.log(`autoresearch run ${runId}`);
console.log(`benchmark: ${days.length} replayable session(s): ${days.map((d) => d.date).join(', ')}`);
const drift = describeVariantDrift(LIVE_BASE);
if (drift.length > 0) console.log(`baseline uses LIVE toggles, differing from config.ts:\n  ${drift.join('\n  ')}`);
console.log(`baseline (live toggles): metric ${bestMetric >= 0 ? '+' : ''}${bestMetric} · ${JSON.stringify(baseline.perDay)}\n`);
journal({ type: 'baseline', config: best, metric: bestMetric, perDay: baseline.perDay });

const leaderboard: { name: string; description: string; metric: number; accepted: boolean }[] = [];
let accepted = 0;
for (let i = 1; i <= N_EXPERIMENTS; i++) {
  const { variant, description } = mutate(best, i);
  const { metric, perDay } = metricOf(days, variant);
  const accept = metric > bestMetric; // strict: ties keep the incumbent
  journal({ type: 'experiment', n: i, description, metric, accepted: accept, perDay, config: variant });
  leaderboard.push({ name: variant.name, description, metric, accepted: accept });
  if (accept) {
    accepted++;
    console.log(`  #${String(i).padStart(2)} ACCEPT ${description}: metric ${bestMetric} → ${metric}`);
    best = variant;
    bestMetric = metric;
  }
}

leaderboard.sort((a, b) => b.metric - a.metric);
console.log(`\n${N_EXPERIMENTS} experiments · ${accepted} accepted · final metric ${bestMetric >= 0 ? '+' : ''}${bestMetric} (baseline ${baseline.metric >= 0 ? '+' : ''}${baseline.metric})`);
console.log('\nTop 10 experiments:');
for (const l of leaderboard.slice(0, 10)) {
  console.log(`  ${l.metric >= 0 ? '+' : ''}${String(l.metric).padEnd(7)} ${l.accepted ? 'ACCEPTED' : 'rejected'} · ${l.description}`);
}
if (bestMetric > baseline.metric) {
  console.log('\nBest config found (NOT auto-shipped — see guard rails in the header):');
  console.log(JSON.stringify({ ...best, name: 'candidate' }, null, 2));
}
if (days.length < 3) {
  console.log(
    `\n⚠ Only ${days.length} recorded day(s) — treat every result as EXPLORATORY. A config tuned on one day is curve-fit to that day; ship changes only when they hold across ≥3 recorded sessions.`,
  );
}
journal({ type: 'final', accepted, finalMetric: bestMetric, baselineMetric: baseline.metric, config: best, daysEvaluated: dates });
console.log(`\nJournal appended → ${JOURNAL}`);
