/**
 * Read-only out-of-sample evaluation of the R-Factor V2 shadow.
 *
 * This is the piece that decides whether V2 ever earns promotion. It answers one
 * question: when V2 said a name was highly active AND leaning a direction, did
 * the underlying actually move that way over the next 15/30/60 minutes — by more
 * than it did for a name V2 was NOT excited about, on days V2 was not tuned on?
 *
 * Honesty rules baked in:
 *   - Snapshots are one row per symbol per minute, so consecutive rows overlap
 *     heavily. Raw row counts are NOT independent samples. The headline estimator
 *     is therefore clustered BY DAY: each day contributes one number, and the
 *     spread across days is what the verdict rests on.
 *   - The final block holds out the most recent days entirely. A model that only
 *     looks good in-sample is reported as such.
 *   - A forward move is a SPOT move from retained 5-minute candles. It is not an
 *     option P&L, it ignores spread and slippage, and it is not a fill.
 *   - Everything is labelled with its sample size. Nothing here is significant
 *     on six sessions, and the script says so.
 *
 * Usage:
 *   npx tsx scripts/eval-rfactor-v2.ts
 *   npx tsx scripts/eval-rfactor-v2.ts --horizons=15,30,60 --holdout=2 --window=all
 *   npx tsx scripts/eval-rfactor-v2.ts --db=./data/prod-clone.db
 */
import Database from 'better-sqlite3';

function arg(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

const horizons = arg('horizons', '15,30,60')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);
const holdoutDays = Number(arg('holdout', '2'));
const windowMode = arg('window', 'entry'); // 'entry' = 09:45–12:15 IST only, 'all' = whole session
const minCoverage = Number(arg('min-coverage', '0.55'));

if (horizons.length === 0) throw new Error('--horizons must list at least one positive minute count');

// Read-only, and it must stay that way: this script only ever measures.
const db = new Database(arg('db', './data/project-r.db'), { readonly: true, fileMustExist: true });

const hasTable = (name: string): boolean =>
  db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name) != null;

if (!hasTable('rfactor_v2_snapshots')) {
  console.log('No rfactor_v2_snapshots table yet — run at least one live session with the shadow enabled.');
  process.exit(0);
}

interface SnapshotRow {
  date: string;
  bucketTs: number;
  symbol: string;
  /** Exact instant of observation — bucketTs is floored to the minute. */
  capturedAt: string;
  /** Exact price observed at the snapshot. Null on rows written before it existed. */
  ltp: number | null;
  oldRFactor: number | null;
  activityScore: number;
  comparableActivity: number;
  comparableCoverage: number;
  activityRank: number;
  universeSize: number;
  direction: string;
  directionConfidence: number;
  optionStatus: string;
  modelVersion: string;
  configHash: string;
}

const columns = new Set(
  (db.prepare(`PRAGMA table_info(rfactor_v2_snapshots)`).all() as { name: string }[]).map((c) => c.name),
);
// Tolerate rows written by an install that predates a column rather than
// failing outright: an older evidence set is still worth reading, it just
// carries less of it.
const optional = (name: string, fallback: string): string =>
  columns.has(name) ? name : `${fallback} AS ${name}`;

const allSnapshots = db
  .prepare(
    `SELECT date, bucketTs, symbol, capturedAt, oldRFactor, activityScore, comparableActivity,
            comparableCoverage, activityRank, universeSize, direction, directionConfidence, optionStatus,
            ${optional('ltp', 'NULL')}, ${optional('modelVersion', `'unknown'`)}, ${optional('configHash', `'unknown'`)}
       FROM rfactor_v2_snapshots
      ORDER BY date, bucketTs, symbol`,
  )
  .all() as SnapshotRow[];

if (allSnapshots.length === 0) {
  console.log('rfactor_v2_snapshots is empty — nothing to evaluate yet.');
  process.exit(0);
}

// ── One scoring definition at a time ────────────────────────────────────────
// Rows from two model versions are two different measurements wearing the same
// column names; averaging them is meaningless. This is guaranteed to happen the
// first time a new version deploys over retained rows, so the harness REFUSES
// rather than printing a caveat above numbers people will quote anyway.
const versionCounts = new Map<string, number>();
for (const snap of allSnapshots) {
  const key = `${snap.modelVersion}/${snap.configHash}`;
  versionCounts.set(key, (versionCounts.get(key) ?? 0) + 1);
}
const requestedVersion = arg('model-version', '');
let snapshots = allSnapshots;
if (requestedVersion !== '') {
  snapshots = allSnapshots.filter((s) => `${s.modelVersion}/${s.configHash}`.startsWith(requestedVersion));
  if (snapshots.length === 0) {
    console.error(`No rows match --model-version=${requestedVersion}. Present: ${[...versionCounts.keys()].join(', ')}`);
    process.exit(1);
  }
} else if (versionCounts.size > 1) {
  console.error('Refusing to evaluate mixed model versions — the rows are not comparable.\n');
  for (const [version, count] of [...versionCounts].sort((a, b) => b[1] - a[1])) {
    console.error(`  ${version.padEnd(24)} ${count} rows`);
  }
  console.error('\nRe-run pinned to one, e.g:');
  console.error(`  npx tsx scripts/eval-rfactor-v2.ts --model-version=${[...versionCounts.keys()].sort().reverse()[0]}`);
  process.exit(1);
}
const evaluatedVersion = requestedVersion !== '' ? requestedVersion : ([...versionCounts.keys()][0] ?? 'unknown');

// ── Forward spot moves from retained candles ────────────────────────────────
interface Bar {
  bucketTs: number;
  close: number;
}
const seriesKey = (symbol: string, date: string): string => `${symbol}|${date}`;
const series = new Map<string, Bar[]>();
for (const row of db
  .prepare(`SELECT symbol, date, bucketTs, close FROM fyers_candles WHERE instrument='EQ' AND close > 0 ORDER BY bucketTs`)
  .all() as { symbol: string; date: string; bucketTs: number; close: number }[]) {
  const key = seriesKey(row.symbol, row.date);
  const bucket = series.get(key) ?? [];
  bucket.push({ bucketTs: Number(row.bucketTs), close: Number(row.close) });
  series.set(key, bucket);
}

const BAR_SECONDS = 300;

/**
 * First bar whose CLOSE was observable at or after `ts`.
 *
 * A bar's `bucketTs` is when it OPENS; its close is not knowable until five
 * minutes later. Matching on `bucketTs >= ts` therefore skips the bar that is
 * actually the first usable price: for a 10:03 snapshot the 10:00 bar closes at
 * 10:05 and is available then, whereas the 10:05 bar's close only exists at
 * 10:10. Selecting the latter silently pushes every mid-bar observation almost
 * a full bar into the future, which distorts 15- and 30-minute outcomes.
 *
 * Returns the bar plus the moment its close became observable, which is the
 * timestamp every horizon must then be measured from.
 */
function barObservableAtOrAfter(bars: Bar[] | undefined, ts: number): { bar: Bar; observedAt: number } | null {
  if (bars == null) return null;
  let lo = 0;
  let hi = bars.length - 1;
  let found: Bar | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].bucketTs + BAR_SECONDS >= ts) {
      found = bars[mid];
      hi = mid - 1;
    } else lo = mid + 1;
  }
  if (found == null) return null;
  const observedAt = found.bucketTs + BAR_SECONDS;
  // Never bridge a gap wider than two bars; a stale reference is not a measurement.
  return observedAt - ts <= 10 * 60 ? { bar: found, observedAt } : null;
}

const istMinuteOfDay = (bucketTs: number): number => Math.floor((((bucketTs + 19800) % 86400) + 86400) % 86400 / 60);
const ENTRY_START = 9 * 60 + 45;
const ENTRY_END = 12 * 60 + 15;

interface Observation {
  date: string;
  symbol: string;
  minuteOfDay: number;
  comparableActivity: number;
  activityScore: number;
  oldRFactor: number | null;
  activityRank: number;
  direction: string;
  directionConfidence: number;
  optionStatus: string;
  /** Signed by V2's own call: positive means the move went the way V2 leaned. */
  directional: Map<number, number>;
  /** Unsigned forward move, for scoring activity alone. */
  absolute: Map<number, number>;
}

const observations: Observation[] = [];
let skippedNoCandles = 0;
let skippedCoverage = 0;
let skippedWindow = 0;
/** Entry taken from the exact recorded price. */
let storedLtpRows = 0;
/** Entry inferred from a candle close because the row predates the ltp column. */
let inferredEntryRows = 0;

for (const snap of snapshots) {
  if (snap.comparableCoverage < minCoverage) {
    skippedCoverage += 1;
    continue;
  }
  const minuteOfDay = istMinuteOfDay(snap.bucketTs);
  if (windowMode === 'entry' && (minuteOfDay < ENTRY_START || minuteOfDay > ENTRY_END)) {
    skippedWindow += 1;
    continue;
  }
  const bars = series.get(seriesKey(snap.symbol, snap.date));
  // Prefer the price actually observed at the snapshot. Only fall back to a
  // candle close when the row predates the stored `ltp` column, and count how
  // often that happens so the reader knows how much of the result is inferred.
  const fallback = barObservableAtOrAfter(bars, snap.bucketTs);
  const usingStoredLtp = snap.ltp != null && snap.ltp > 0;
  if (!usingStoredLtp && fallback == null) {
    skippedNoCandles += 1;
    continue;
  }
  const entryPrice = usingStoredLtp ? (snap.ltp as number) : (fallback as { bar: Bar }).bar.close;
  // Measure horizons from the EXACT capture instant, not the floored minute.
  // A price seen at 10:05:59 with a 15-minute horizon must not be paired with
  // the 10:20 close, which landed 59 seconds before the horizon was reached.
  const capturedAtMs = Date.parse(snap.capturedAt);
  const entryAt = usingStoredLtp
    ? Number.isFinite(capturedAtMs)
      ? Math.floor(capturedAtMs / 1000)
      : snap.bucketTs
    : (fallback as { observedAt: number }).observedAt;

  const directional = new Map<number, number>();
  const absolute = new Map<number, number>();
  for (const horizon of horizons) {
    const exit = barObservableAtOrAfter(bars, entryAt + horizon * 60);
    if (exit == null) continue;
    const movePct = ((exit.bar.close - entryPrice) / entryPrice) * 100;
    absolute.set(horizon, Math.abs(movePct));
    const sign = snap.direction === 'bullish' ? 1 : snap.direction === 'bearish' ? -1 : 0;
    if (sign !== 0) directional.set(horizon, movePct * sign);
  }
  if (absolute.size === 0) {
    skippedNoCandles += 1;
    continue;
  }
  // Counted only for observations that survived, so the reported split always
  // adds up to the usable total rather than to attempts.
  if (usingStoredLtp) storedLtpRows += 1;
  else inferredEntryRows += 1;
  observations.push({
    date: snap.date,
    symbol: snap.symbol,
    minuteOfDay,
    comparableActivity: snap.comparableActivity,
    activityScore: snap.activityScore,
    oldRFactor: snap.oldRFactor,
    activityRank: snap.activityRank,
    direction: snap.direction,
    directionConfidence: snap.directionConfidence,
    optionStatus: snap.optionStatus,
    directional,
    absolute,
  });
}

if (observations.length === 0) {
  console.log('No snapshot lined up with a retained candle. Candles are kept ~20 sessions;');
  console.log('shadow rows older than that can no longer be evaluated.');
  process.exit(0);
}

const allDates = [...new Set(observations.map((o) => o.date))].sort();
const trainDates = new Set(allDates.slice(0, Math.max(0, allDates.length - holdoutDays)));
const testDates = new Set(allDates.slice(Math.max(0, allDates.length - holdoutDays)));

const mean = (values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
const stdev = (values: number[]): number => {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1));
};
const fixed = (value: number, digits = 3): string => (Number.isFinite(value) ? value.toFixed(digits) : '—');

/**
 * Day-clustered summary. Each DAY yields one mean, and the reported spread is
 * across days — the only unit here that is close to independent.
 */
function summarize(rows: Observation[], horizon: number, pick: (o: Observation) => number | undefined) {
  const byDate = new Map<string, number[]>();
  let rawCount = 0;
  let wins = 0;
  for (const row of rows) {
    const value = pick(row);
    if (value == null || !Number.isFinite(value)) continue;
    rawCount += 1;
    if (value > 0) wins += 1;
    const bucket = byDate.get(row.date) ?? [];
    bucket.push(value);
    byDate.set(row.date, bucket);
  }
  const perDay = [...byDate.entries()].map(([date, values]) => ({ date, mean: mean(values), n: values.length }));
  const dayMeans = perDay.map((d) => d.mean);
  return {
    horizon,
    rawCount,
    days: perDay.length,
    symbols: new Set(rows.map((r) => r.symbol)).size,
    hitRate: rawCount > 0 ? wins / rawCount : 0,
    dayMean: mean(dayMeans),
    dayStdev: stdev(dayMeans),
    /** Standard error ACROSS DAYS, not across overlapping rows. */
    dayStderr: perDay.length > 1 ? stdev(dayMeans) / Math.sqrt(perDay.length) : Number.NaN,
    perDay,
  };
}

function printTable(
  title: string,
  groups: { label: string; rows: Observation[] }[],
  horizon: number,
  pick: (o: Observation) => number | undefined,
): void {
  console.log(`\n${title}  (horizon ${horizon}m)`);
  console.log(
    `  ${'group'.padEnd(30)} ${'rows'.padStart(7)} ${'days'.padStart(5)} ${'mean%/day'.padStart(11)} ` +
      `${'±SE(day)'.padStart(10)} ${'hit%'.padStart(7)}`,
  );
  for (const group of groups) {
    const s = summarize(group.rows, horizon, pick);
    if (s.rawCount === 0) {
      console.log(`  ${group.label.padEnd(30)} ${'0'.padStart(7)}  (no rows)`);
      continue;
    }
    console.log(
      `  ${group.label.padEnd(30)} ${String(s.rawCount).padStart(7)} ${String(s.days).padStart(5)} ` +
        `${fixed(s.dayMean).padStart(11)} ${fixed(s.dayStderr).padStart(10)} ` +
        `${(s.hitRate * 100).toFixed(1).padStart(7)}`,
    );
  }
}

// ── Report ──────────────────────────────────────────────────────────────────
console.log('R-Factor V2 shadow evaluation');
console.log('='.repeat(78));
console.log(`snapshots read       : ${snapshots.length}`);
console.log(`usable observations  : ${observations.length}`);
console.log(`  dropped, coverage  : ${skippedCoverage} (comparableCoverage < ${minCoverage})`);
console.log(`  dropped, window    : ${skippedWindow} (${windowMode === 'entry' ? '09:45–12:15 IST only' : 'n/a'})`);
console.log(`  dropped, no candle : ${skippedNoCandles}`);
console.log(`sessions             : ${allDates.length} (${allDates.join(', ') || 'none'})`);
console.log(`holdout (most recent): ${[...testDates].join(', ') || 'none'}`);
console.log(`distinct symbols     : ${new Set(observations.map((o) => o.symbol)).size}`);
console.log(
  `option evidence      : ${observations.filter((o) => o.optionStatus === 'available').length} of ${observations.length} rows`,
);

const inSample = observations.filter((o) => trainDates.has(o.date));
const outSample = observations.filter((o) => testDates.has(o.date));

// Thresholds come from TRAINING sessions ONLY, then are frozen and applied
// unchanged to the held-out days. Deriving them from all observations would let
// the test period's own distribution decide which rows land in the test groups —
// that is leakage, and it would quietly flatter the held-out block.
const quantileOf = (values: number[], q: number): number =>
  values.length === 0 ? 0 : (values[Math.min(values.length - 1, Math.floor(q * values.length))] ?? 0);
const trainingActivity = observations
  .filter((o) => trainDates.has(o.date))
  .map((o) => o.comparableActivity)
  .sort((a, b) => a - b);
const thresholdSource = trainingActivity.length > 0 ? trainingActivity : [...observations.map((o) => o.comparableActivity)].sort((a, b) => a - b);
const p80 = quantileOf(thresholdSource, 0.8);
const p50 = quantileOf(thresholdSource, 0.5);
console.log(
  `activity p50 / p80   : ${fixed(p50, 4)} / ${fixed(p80, 4)} ` +
    `(from ${trainingActivity.length > 0 ? 'training sessions only' : 'ALL rows — no training split available'})`,
);
console.log(
  `entry reference      : ${storedLtpRows} exact recorded price, ${inferredEntryRows} inferred from candle close`,
);

console.log(`model version        : ${evaluatedVersion} (mixed versions are refused, not averaged)`);
// Ranks are relative to the symbol set they were computed against, so a bucket
// holding two universes would mean two incompatible definitions of "rank 1".
const mixedUniverseBuckets = db
  .prepare(
    columns.has('universeKey')
      ? `SELECT COUNT(*) AS n FROM (
           SELECT date, bucketTs FROM rfactor_v2_snapshots
            GROUP BY date, bucketTs HAVING COUNT(DISTINCT universeKey) > 1)`
      : `SELECT 0 AS n`,
  )
  .get() as { n: number };
console.log(
  `universe integrity   : ${Number(mixedUniverseBuckets.n) === 0 ? 'one universe per minute' : `!! ${mixedUniverseBuckets.n} minute(s) hold MIXED universes — ranks not comparable`}`,
);

for (const horizon of horizons) {
  const activityGroups = (rows: Observation[]) => [
    { label: 'all measured names', rows },
    { label: `activity ≥ p80`, rows: rows.filter((o) => o.comparableActivity >= p80) },
    { label: `activity p50–p80`, rows: rows.filter((o) => o.comparableActivity >= p50 && o.comparableActivity < p80) },
    { label: `activity < p50`, rows: rows.filter((o) => o.comparableActivity < p50) },
    { label: 'V2 rank 1–5', rows: rows.filter((o) => o.activityRank >= 1 && o.activityRank <= 5) },
    { label: 'old R-Factor ≥ 3.6', rows: rows.filter((o) => (o.oldRFactor ?? 0) >= 3.6) },
  ];

  // Does activity alone predict a bigger move in EITHER direction? This is the
  // claim "R-Factor tells you where the money is", tested directly.
  printTable('MOVEMENT SIZE — in-sample', activityGroups(inSample), horizon, (o) => o.absolute.get(horizon));
  if (outSample.length > 0) {
    printTable('MOVEMENT SIZE — HELD-OUT days', activityGroups(outSample), horizon, (o) => o.absolute.get(horizon));
  }

  // Does the direction call pay? Positive = the move went V2's way.
  const directionGroups = (rows: Observation[]) => [
    { label: 'all directional calls', rows: rows.filter((o) => o.direction !== 'neutral') },
    {
      label: 'activity ≥ p80 + directional',
      rows: rows.filter((o) => o.direction !== 'neutral' && o.comparableActivity >= p80),
    },
    {
      label: 'activity ≥ p80 + conf ≥ 0.25',
      rows: rows.filter(
        (o) => o.direction !== 'neutral' && o.comparableActivity >= p80 && o.directionConfidence >= 0.25,
      ),
    },
    {
      label: 'with option evidence',
      rows: rows.filter((o) => o.direction !== 'neutral' && o.optionStatus === 'available'),
    },
  ];
  printTable('DIRECTION PAYOFF — in-sample', directionGroups(inSample), horizon, (o) => o.directional.get(horizon));
  if (outSample.length > 0) {
    printTable(
      'DIRECTION PAYOFF — HELD-OUT days',
      directionGroups(outSample),
      horizon,
      (o) => o.directional.get(horizon),
    );
  }
}

console.log(`\n${'='.repeat(78)}`);
console.log('How to read this');
console.log('  mean%/day  average forward SPOT move per day, then averaged across days.');
console.log('  ±SE(day)   spread across days. If the gap between two groups is smaller');
console.log('             than this, the difference is noise, not evidence.');
console.log('  hit%       share of rows on the right side of zero (rows overlap heavily —');
console.log('             treat as descriptive only, never as a win rate).');
console.log('');
if (allDates.length < 20) {
  console.log(`VERDICT: NOT EVALUABLE. ${allDates.length} session(s) of evidence.`);
  console.log('  The shadow needs materially more full sessions before any of these numbers');
  console.log('  should influence a decision, and the parameters must be frozen before the');
  console.log('  days used to judge them are collected. Nothing here justifies wiring V2');
  console.log('  into trading.');
} else {
  console.log('Enough sessions exist to read the held-out block. Promotion still requires');
  console.log('frozen parameters, an option-bid check after spread/slippage, and a separate');
  console.log('reviewed change that explicitly wires V2 into trading.');
}
console.log('Spot moves only — no option premium, spread, or slippage is modelled here.');
