/**
 * DB round-trip checks for the R-Factor V2 shadow store, against an ISOLATED
 * throwaway SQLite database. lib/db builds its file path from
 * `process.cwd()/data/project-r.db` at import, so we chdir into a temp dir with
 * a data/ subdir BEFORE dynamically importing the store. Proves what the pure
 * checks can't: tables create, additive columns land on a pre-existing table,
 * the batched multi-row SQL param counts work past one chunk, the
 * once-per-minute write guard actually suppresses repeat polls, INSERT OR IGNORE
 * keeps the first observation, option baselines stay scoped to one expiry, and
 * retention keeps the newest sessions. Runs in GitHub CI. Exit 1 on any failure.
 *
 * Only node built-ins and `import type` (erased at runtime) are static here —
 * the store is dynamically imported AFTER the chdir so its prisma singleton
 * binds to the temp DB.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RFactorV2Input, RFactorV2Result } from '../lib/r-factor-v2/types';

const originalCwd = process.cwd();
const tmp = mkdtempSync(join(tmpdir(), 'rfv2-store-'));
mkdirSync(join(tmp, 'data'), { recursive: true });
process.chdir(tmp);

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

function teardown(): void {
  process.chdir(originalCwd);
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Windows keeps a handle on the SQLite file briefly after disconnect.
    // A leftover temp dir is harmless; failing the run over it would not be.
  }
}

const result = (over: Partial<RFactorV2Result> = {}): RFactorV2Result => ({
  activityScore: 5.5,
  rawActivity: 0.64,
  comparableActivity: 0.6,
  activityPercentile: 0.9,
  activityRank: 1,
  universeSize: 10,
  direction: 'bullish',
  directionScore: 0.4,
  directionConfidence: 0.3,
  coverage: 0.85,
  comparableCoverage: 1,
  optionStatus: 'pending',
  factors: [{ key: 'range', label: 'Range', score: 0.5, weight: 0.2, available: true, detail: 'x' }],
  ...over,
});

const input = (symbol: string): RFactorV2Input => ({
  symbol,
  sector: 'Testing',
  priceChangePct: 1.2,
  rangeRatio: 2,
  turnoverPace: 2,
  turnoverZ: null,
  turnoverBaselineKind: 'same-time',
  oiLevel: 1.2,
  futuresOiChangePct: 5,
  oiVelocity: 1,
  nseCombinedOiChangePct: 8,
  nseOiSlope30m: 0.5,
  nsePremiumPace: 1.5,
  spreadPct: 0.1,
  imbalance: 0.6,
  option: null,
});

async function main(): Promise<void> {
  const { prisma } = await import('../lib/db');

  // A table created BEFORE the newer columns existed — proves the additive
  // ALTER path, which is what a real install upgrading in place will hit.
  await prisma.$executeRawUnsafe(`
    CREATE TABLE rfactor_v2_snapshots (
      date TEXT NOT NULL, bucketTs INTEGER NOT NULL, symbol TEXT NOT NULL, capturedAt TEXT NOT NULL,
      oldRFactor REAL, activityScore REAL NOT NULL, rawActivity REAL NOT NULL,
      activityPercentile REAL NOT NULL, activityRank INTEGER NOT NULL, universeSize INTEGER NOT NULL,
      direction TEXT NOT NULL, directionScore REAL NOT NULL, directionConfidence REAL NOT NULL,
      coverage REAL NOT NULL, optionStatus TEXT NOT NULL, inputs TEXT NOT NULL, factors TEXT NOT NULL,
      PRIMARY KEY (date, bucketTs, symbol)
    )
  `);

  const store = await import('../lib/r-factor-v2/store');
  await store.ensureRFactorV2Tables();

  const columns = new Set(
    (
      await prisma.$queryRawUnsafe<{ name: string }[]>(`PRAGMA table_info(rfactor_v2_snapshots)`)
    ).map((c) => c.name),
  );
  check(
    'additive columns land on a pre-existing table',
    ['ltp', 'modelVersion', 'configHash', 'comparableActivity', 'comparableCoverage'].every((c) =>
      columns.has(c),
    ),
    [...columns].join(','),
  );

  // 95 symbols forces more than two batches through the chunked multi-row SQL,
  // which is where a param-count mistake would surface.
  const date = '2099-05-05';
  const minuteOne = 1_800_000_060_000;
  const symbols = Array.from({ length: 95 }, (_, i) => `SYM${i}`);
  const inputs = symbols.map(input);
  const results = new Map(symbols.map((s, i) => [s, result({ activityScore: 5 + i / 100 })]));
  const oldScores = new Map(symbols.map((s) => [s, 3.6] as [string, number | null]));
  const ltps = new Map(symbols.map((s, i) => [s, 100 + i] as [string, number | null]));

  store.resetRFactorV2WriteGuard();
  await store.recordRFactorV2Batch(date, oldScores, inputs, results, minuteOne, ltps);
  const afterFirst = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT COUNT(*) AS n FROM rfactor_v2_snapshots`,
  );
  check('batched write stores every symbol past one chunk', Number(afterFirst[0].n) === 95, `${afterFirst[0].n} rows`);

  const stored = await prisma.$queryRawUnsafe<{ ltp: number; modelVersion: string; configHash: string }[]>(
    `SELECT ltp, modelVersion, configHash FROM rfactor_v2_snapshots WHERE symbol = 'SYM7'`,
  );
  check('observed price round-trips', Number(stored[0]?.ltp) === 107, `ltp=${stored[0]?.ltp}`);
  // Asserted against the exported constant, not a literal, so a deliberate
  // version bump does not look like a regression.
  const { RFACTOR_V2_MODEL_VERSION } = await import('../lib/r-factor-v2/engine');
  check(
    'model version + config hash are recorded',
    stored[0]?.modelVersion === RFACTOR_V2_MODEL_VERSION && /^[0-9a-f]{8}$/.test(stored[0]?.configHash ?? ''),
    `${stored[0]?.modelVersion}/${stored[0]?.configHash}`,
  );

  // A second poll in the SAME minute must not write again. This is the whole
  // point of the guard: /live recomputes roughly every 7 seconds.
  const changed = new Map(symbols.map((s) => [s, result({ activityScore: 9.9 })]));
  await store.recordRFactorV2Batch(date, oldScores, inputs, changed, minuteOne + 20_000, ltps);
  const repeat = await prisma.$queryRawUnsafe<{ n: number; maxScore: number }[]>(
    `SELECT COUNT(*) AS n, MAX(activityScore) AS maxScore FROM rfactor_v2_snapshots`,
  );
  check(
    'repeat poll inside the same minute writes nothing',
    Number(repeat[0].n) === 95 && Number(repeat[0].maxScore) < 9,
    `${repeat[0].n} rows, max score ${repeat[0].maxScore}`,
  );

  // A later minute must write a fresh bucket.
  await store.recordRFactorV2Batch(date, oldScores, inputs, results, minuteOne + 61_000, ltps);
  const nextMinute = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT COUNT(DISTINCT bucketTs) AS n FROM rfactor_v2_snapshots`,
  );
  check('a new minute writes a new bucket', Number(nextMinute[0].n) === 2, `${nextMinute[0].n} buckets`);

  // ── Universe integrity ────────────────────────────────────────────────────
  // /live sections poll different symbol lists while the scanner polls the full
  // universe. Rank/percentile/universeSize are all relative to whichever list
  // was computed, so a minute must be owned by exactly ONE universe.
  const minuteTwo = 1_800_000_180_000;
  const bucketTwo = Math.floor(minuteTwo / 60_000) * 60;
  const universeOf = (names: string[]) => ({
    inputs: names.map(input),
    results: new Map(names.map((s) => [s, result({ universeSize: names.length, activityRank: 1 })])),
    oldScores: new Map(names.map((s) => [s, 3.6] as [string, number | null])),
  });

  // Two DIFFERENT lists of the SAME size — the case a symbol count cannot see.
  const banking = universeOf(Array.from({ length: 30 }, (_, i) => `BANK${i}`));
  const momentum = universeOf(Array.from({ length: 30 }, (_, i) => `MOM${i}`));
  store.resetRFactorV2WriteGuard();
  await store.recordRFactorV2Batch(date, banking.oldScores, banking.inputs, banking.results, minuteTwo);
  await store.recordRFactorV2Batch(date, momentum.oldScores, momentum.inputs, momentum.results, minuteTwo + 5_000);
  const equalSized = await prisma.$queryRawUnsafe<{ keys: number; n: number }[]>(
    `SELECT COUNT(DISTINCT universeKey) AS keys, COUNT(*) AS n
       FROM rfactor_v2_snapshots WHERE bucketTs = ?`,
    bucketTwo,
  );
  check(
    'equal-sized but different watchlists never share a minute',
    Number(equalSized[0].keys) === 1 && Number(equalSized[0].n) === 30,
    `${equalSized[0].keys} universeKey(s), ${equalSized[0].n} rows`,
  );

  // A small UI section first, then the big scanner universe: the larger one
  // must take the minute over completely rather than interleaving two ranking
  // fields under identical column names.
  const minuteThree = 1_800_000_240_000;
  const bucketThree = Math.floor(minuteThree / 60_000) * 60;
  const small = universeOf(Array.from({ length: 20 }, (_, i) => `SMALL${i}`));
  const large = universeOf(Array.from({ length: 100 }, (_, i) => `BIG${i}`));
  store.resetRFactorV2WriteGuard();
  await store.recordRFactorV2Batch(date, small.oldScores, small.inputs, small.results, minuteThree);
  await store.recordRFactorV2Batch(date, large.oldScores, large.inputs, large.results, minuteThree + 5_000);
  const replaced = await prisma.$queryRawUnsafe<{ keys: number; n: number; sizes: number }[]>(
    `SELECT COUNT(DISTINCT universeKey) AS keys, COUNT(*) AS n, COUNT(DISTINCT universeSize) AS sizes
       FROM rfactor_v2_snapshots WHERE bucketTs = ?`,
    bucketThree,
  );
  check(
    'a larger universe replaces the minute instead of mixing ranks',
    Number(replaced[0].keys) === 1 && Number(replaced[0].n) === 100 && Number(replaced[0].sizes) === 1,
    `${replaced[0].keys} key(s), ${replaced[0].n} rows, ${replaced[0].sizes} universeSize value(s)`,
  );

  const leftovers = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT COUNT(*) AS n FROM rfactor_v2_snapshots WHERE bucketTs = ? AND symbol LIKE 'SMALL%'`,
    bucketThree,
  );
  check('the superseded smaller universe leaves no rows behind', Number(leftovers[0].n) === 0, `${leftovers[0].n} rows`);

  // Option evidence: baselines must not mix expiries.
  const optionEvidence = (premiumValue: number, capturedAt: string, expiry: string) => ({
    capturedAt,
    expiry,
    underlyingLtp: 1000,
    strikesUsed: 4,
    totalStrikes: 20,
    activityScore: 0.5,
    directionScore: 0.2,
    direction: 'bullish' as const,
    directionConfidence: 0.2,
    directionEvidenceLegs: 3,
    oiPcr: 1,
    volumePcr: 1,
    premiumValuePcr: 1,
    moneynessWeightedOiPcr: 1,
    premiumTurnoverPace: 1,
    paceBaselineKind: 'same-time' as const,
    premiumValue,
    optionVolume: 1000,
    callOiChangePct: 1,
    putOiChangePct: 1,
    gammaNetSharePct: null,
    gammaConcentrationStrike: null,
    gammaConcentrationDistancePct: null,
    grossGamma: 0,
    rows: [],
  });

  // Both expiries carry three prior sessions inside the same ±15 minute window
  // (10:00 IST near, 10:10 IST far — different bucketTs so they do not collide
  // on the (date,bucketTs,symbol) key). Without the expiry filter the two sets
  // would pool and the median would land between them, so each baseline coming
  // back at its own level is what proves the scoping.
  for (const day of ['2099-04-28', '2099-04-29', '2099-04-30']) {
    await store.recordOptionEvidence('ABC', optionEvidence(1000, `${day}T04:30:00.000Z`, '2099-05-27'));
    await store.recordOptionEvidence('ABC', optionEvidence(999_999, `${day}T04:40:00.000Z`, '2099-06-24'));
  }

  const nowMs = Date.parse('2099-05-05T04:30:00.000Z');
  const nearBaseline = await store.loadSameTimeOptionBaseline('ABC', '2099-05-27', '2099-05-05', nowMs);
  check(
    'same-clock option baseline is scoped to its own expiry',
    nearBaseline === 1000,
    `near=${nearBaseline} (would be polluted by the 999999 far-expiry rows if unscoped)`,
  );
  const farBaseline = await store.loadSameTimeOptionBaseline('ABC', '2099-06-24', '2099-05-05', nowMs);
  check('the other expiry keeps its own separate baseline', farBaseline === 999_999, `far=${farBaseline}`);

  const rolledBaseline = await store.loadSameTimeOptionBaseline('ABC', '2099-07-29', '2099-05-05', nowMs);
  check(
    'a freshly rolled expiry withholds the baseline instead of mixing regimes',
    rolledBaseline === null,
    `${rolledBaseline}`,
  );

  // Retention keeps the newest sessions only.
  for (let i = 0; i < 25; i++) {
    const day = `2099-06-${String(i + 1).padStart(2, '0')}`;
    store.resetRFactorV2WriteGuard();
    await store.recordRFactorV2Batch(day, oldScores, inputs.slice(0, 2), results, minuteOne + i * 86_400_000, ltps);
  }
  await store.pruneRFactorV2Snapshots();
  const kept = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT COUNT(DISTINCT date) AS n FROM rfactor_v2_snapshots`,
  );
  check(
    'retention keeps the newest 20 sessions',
    Number(kept[0].n) === store.RFACTOR_V2_RETENTION_SESSIONS,
    `${kept[0].n} dates`,
  );

  try {
    await prisma.$disconnect();
  } catch {
    // ignore
  }
}

main()
  .then(() => {
    teardown();
    console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    teardown();
    console.error('FAILED:', err);
    process.exit(1);
  });
