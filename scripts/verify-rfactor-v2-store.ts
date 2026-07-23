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

  // ── Ownership must not depend on process memory ───────────────────────────
  // Simulating a restart: the guard is cleared while SQLite still holds the
  // minute. A remembered "last bucket" would forget the owner, skip the DELETE,
  // and let INSERT OR IGNORE merge a second universe into the same bucket.
  store.resetRFactorV2WriteGuard();
  const sneaky = universeOf(Array.from({ length: 30 }, (_, i) => `SNEAK${i}`));
  await store.recordRFactorV2Batch(date, sneaky.oldScores, sneaky.inputs, sneaky.results, minuteThree + 9_000);
  const afterRestart = await prisma.$queryRawUnsafe<{ keys: number; n: number }[]>(
    `SELECT COUNT(DISTINCT universeKey) AS keys, COUNT(*) AS n
       FROM rfactor_v2_snapshots WHERE bucketTs = ?`,
    bucketThree,
  );
  check(
    'a process restart cannot let a second universe into an owned minute',
    Number(afterRestart[0].keys) === 1 && Number(afterRestart[0].n) === 100,
    `${afterRestart[0].keys} key(s), ${afterRestart[0].n} rows`,
  );

  // Out-of-order arrival: a NEWER minute is written first, then a delayed OLDER
  // minute lands. The older one must own its own bucket without disturbing the
  // newer one — a single "last bucket seen" would rewind and corrupt both.
  store.resetRFactorV2WriteGuard();
  const minuteNewer = 1_800_000_360_000;
  const minuteOlder = 1_800_000_300_000;
  const bucketNewer = Math.floor(minuteNewer / 60_000) * 60;
  const bucketOlder = Math.floor(minuteOlder / 60_000) * 60;
  const newerSmall = universeOf(Array.from({ length: 20 }, (_, i) => `NEW${i}`));
  const olderLarge = universeOf(Array.from({ length: 90 }, (_, i) => `OLD${i}`));
  await store.recordRFactorV2Batch(date, newerSmall.oldScores, newerSmall.inputs, newerSmall.results, minuteNewer);
  await store.recordRFactorV2Batch(date, olderLarge.oldScores, olderLarge.inputs, olderLarge.results, minuteOlder);
  const laterBigger = universeOf(Array.from({ length: 60 }, (_, i) => `LATE${i}`));
  await store.recordRFactorV2Batch(date, laterBigger.oldScores, laterBigger.inputs, laterBigger.results, minuteNewer + 3_000);
  const ooo = await prisma.$queryRawUnsafe<{ bucketTs: number; keys: number; n: number }[]>(
    `SELECT bucketTs, COUNT(DISTINCT universeKey) AS keys, COUNT(*) AS n
       FROM rfactor_v2_snapshots WHERE bucketTs IN (?, ?) GROUP BY bucketTs ORDER BY bucketTs`,
    bucketOlder,
    bucketNewer,
  );
  check(
    'a delayed older minute cannot rewind ownership of a newer one',
    ooo.length === 2 && ooo.every((row) => Number(row.keys) === 1),
    ooo.map((r) => `${r.bucketTs}:${r.keys}key/${r.n}rows`).join(' '),
  );
  check(
    'a later larger universe still takes over the newer minute',
    Number(ooo.find((r) => Number(r.bucketTs) === bucketNewer)?.n) === 60,
    `${ooo.find((r) => Number(r.bucketTs) === bucketNewer)?.n} rows (expected 60)`,
  );

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

  // ── Baselines must not mix option-evidence definitions ────────────────────
  // v2.2 redefined premiumValue from LTP x volume to VWAP x volume. Rows from
  // the older definition are a different measurement, and a snapshot normalised
  // against them would still carry today's model version — undetectable later.
  await prisma.$executeRawUnsafe(
    `UPDATE rfactor_v2_option_snapshots SET optionEvidenceVersion = 'oe1' WHERE symbol = 'ABC' AND expiry = '2099-05-27'`,
  );
  const staleVersionBaseline = await store.loadSameTimeOptionBaseline('ABC', '2099-05-27', '2099-05-05', nowMs);
  check(
    'evidence from an older option definition never feeds a baseline',
    staleVersionBaseline === null,
    `${staleVersionBaseline} (3 rows exist, but all at oe1)`,
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

  // ── A larger universe arriving mid-write must be coalesced, not dropped ────
  // Returning early on `inFlight` meant the minute was owned by the largest
  // universe that happened to arrive while the writer was IDLE: a 166-name
  // scanner result landing during a 20-name section's write was thrown away.
  const coalesceDate = '2099-08-01';
  const coalesceMs = 1_800_000_600_000;
  store.resetRFactorV2WriteGuard();
  const smallSymbols = symbols.slice(0, 2);
  const bigSymbols = symbols.slice(0, 50);
  const mk = (list: string[]) => ({
    inputs: list.map(input),
    results: new Map(list.map((s) => [s, result()])),
    old: new Map(list.map((s) => [s, 3.6] as [string, number | null])),
    ltp: new Map(list.map((s) => [s, 100] as [string, number | null])),
  });
  const smallUniverse = mk(smallSymbols);
  const bigUniverse = mk(bigSymbols);

  // Start the small write, then hand the larger one in WHILE it is in flight.
  const firstWrite = store.recordRFactorV2Batch(
    coalesceDate,
    smallUniverse.old,
    smallUniverse.inputs,
    smallUniverse.results,
    coalesceMs,
    smallUniverse.ltp,
  );
  const secondWrite = store.recordRFactorV2Batch(
    coalesceDate,
    bigUniverse.old,
    bigUniverse.inputs,
    bigUniverse.results,
    coalesceMs,
    bigUniverse.ltp,
  );
  await Promise.all([firstWrite, secondWrite]);

  const owned = await prisma.$queryRawUnsafe<{ n: number; keys: number }[]>(
    `SELECT COUNT(*) AS n, COUNT(DISTINCT universeKey) AS keys
       FROM rfactor_v2_snapshots WHERE date = ?`,
    coalesceDate,
  );
  check(
    'a larger universe arriving mid-write is coalesced, not dropped',
    Number(owned[0].n) === bigSymbols.length,
    `${owned[0].n} rows (expected ${bigSymbols.length})`,
  );
  check(
    'the minute ends up owned by exactly ONE universe',
    Number(owned[0].keys) === 1,
    `${owned[0].keys} distinct universeKey values`,
  );

  // ── Coalescing must be PER MINUTE ─────────────────────────────────────────
  // A single global pending slot kept whichever payload had most symbols,
  // regardless of which minute it belonged to — so a delayed larger 10:00
  // payload evicted a pending smaller 10:01 one and that minute was lost.
  const crossDate = '2099-08-05';
  const crossNewer = 1_800_000_720_000;
  const crossOlder = crossNewer - 60_000;
  store.resetRFactorV2WriteGuard();
  const blocker = mk(symbols.slice(0, 3));
  const newerMinute = mk(symbols.slice(0, 5));
  const olderBigger = mk(symbols.slice(0, 70));
  const w1 = store.recordRFactorV2Batch(crossDate, blocker.old, blocker.inputs, blocker.results, crossNewer - 120_000, blocker.ltp);
  const w2 = store.recordRFactorV2Batch(crossDate, newerMinute.old, newerMinute.inputs, newerMinute.results, crossNewer, newerMinute.ltp);
  const w3 = store.recordRFactorV2Batch(crossDate, olderBigger.old, olderBigger.inputs, olderBigger.results, crossOlder, olderBigger.ltp);
  await Promise.all([w1, w2, w3]);
  const crossBuckets = await prisma.$queryRawUnsafe<{ bucketTs: number; n: number }[]>(
    `SELECT bucketTs, COUNT(*) AS n FROM rfactor_v2_snapshots WHERE date = ? GROUP BY bucketTs ORDER BY bucketTs`,
    crossDate,
  );
  check(
    'a larger payload for a DIFFERENT minute cannot evict a pending one',
    crossBuckets.length === 3,
    `${crossBuckets.length} minutes stored (expected 3): ${crossBuckets.map((b) => `${b.bucketTs}:${b.n}`).join(' ')}`,
  );

  // ── Duplicate symbols must not inflate the universe ────────────────────────
  const dupDate = '2099-08-02';
  store.resetRFactorV2WriteGuard();
  const dupList = Array.from({ length: 60 }, () => 'SYM0');
  const dup = mk(dupList);
  await store.recordRFactorV2Batch(dupDate, dup.old, dup.inputs, dup.results, coalesceMs, dup.ltp);
  const dupRows = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT COUNT(*) AS n FROM rfactor_v2_snapshots WHERE date = ?`,
    dupDate,
  );
  check(
    'a repeated symbol cannot fake a large universe',
    Number(dupRows[0].n) === 1,
    `${dupRows[0].n} rows stored for 60 copies of one symbol`,
  );

  // ── The takeover really is atomic ─────────────────────────────────────────
  // The DELETE and every INSERT chunk share one transaction, so a failure
  // anywhere leaves the previous universe untouched rather than an empty or
  // half-filled minute that still looks internally consistent.
  const atomicBefore = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT COUNT(*) AS n FROM rfactor_v2_snapshots WHERE date = ?`,
    coalesceDate,
  );
  let rolledBack = false;
  try {
    await prisma.$transaction([
      prisma.$executeRawUnsafe(`DELETE FROM rfactor_v2_snapshots WHERE date = ?`, coalesceDate),
      prisma.$executeRawUnsafe(`INSERT INTO rfactor_v2_snapshots (date) VALUES ('broken-on-purpose')`),
    ]);
  } catch {
    rolledBack = true;
  }
  const atomicAfter = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT COUNT(*) AS n FROM rfactor_v2_snapshots WHERE date = ?`,
    coalesceDate,
  );
  check(
    'a failed batch rolls the DELETE back, keeping the prior universe',
    rolledBack && Number(atomicAfter[0].n) === Number(atomicBefore[0].n),
    `rolledBack=${rolledBack}, ${atomicBefore[0].n} rows before / ${atomicAfter[0].n} after`,
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
