/**
 * DB round-trip checks for the priority-refresh stores, against an ISOLATED
 * throwaway SQLite database. lib/db builds its file path from
 * `process.cwd()/data/project-r.db` at import, so we chdir into a temp dir with
 * a data/ subdir BEFORE dynamically importing the stores. Proves what the pure
 * checks + container smoke test can't: the tables create, the SQL param counts +
 * Prisma transaction work, timestamps round-trip faithfully, and the empty-batch
 * / atomic-replace semantics hold. Runs in GitHub CI. Exit 1 on any failure.
 *
 * Only node built-ins and `import type` (erased at runtime) are static here — the
 * stores are dynamically imported AFTER the chdir so their prisma singleton binds
 * to the temp DB.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActiveSectorSignal } from '../lib/priority-refresh/types';

const originalCwd = process.cwd();
const tmp = mkdtempSync(join(tmpdir(), 'prio-store-'));
mkdirSync(join(tmp, 'data'), { recursive: true });
process.chdir(tmp);

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

function teardown(): void {
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
}

async function main(): Promise<void> {
  const { recordPriorityCycle, getLatestPriorityCycle, getPriorityCyclesForDate } = await import(
    '../lib/priority-refresh/telemetry-store'
  );
  const { recordSectorSnapshot, getLatestSectorSnapshot, getLatestSectorSnapshotBefore } = await import(
    '../lib/priority-refresh/sector-snapshot-store'
  );
  const { prepareSectorSnapshotWrite } = await import('../lib/priority-refresh/sector-producer');
  const { prisma } = await import('../lib/db');

  const pd = '2099-05-05';
  const baseRow = {
    date: pd, bucketTs: 1000, shadowEnabled: true, cappedLiveEnabled: false, blockStaleEntry: true,
    sectorShadowEnabled: true, sectorLiveEnabled: false, perFeedLimit: 10, maxUniqueTier1: 40, sectorReservedSlots: 10,
    universeCount: 166, scanPoolCount: 60, fullPriorityCount: 55, tier0Count: 2, baseTier1Count: 30,
    sectorPromotedCount: 5, cappedWaitCount: 42, suggestionCount: 4, suggestionsOutsideCap: 1,
    outsideCapSymbols: ['ZZZ'], activeBullishSectors: ['PSU Bank'], activeBearishSectors: [] as string[],
  };

  // Cycle telemetry: create table, write, read back, JSON round-trip.
  await recordPriorityCycle(baseRow);
  const c1 = await getLatestPriorityCycle(pd);
  check(
    'cycle telemetry round-trips (incl. outsideCap JSON)',
    c1?.cappedWaitCount === 42 && c1?.suggestionsOutsideCap === 1 && c1?.outsideCapSymbols.join(',') === 'ZZZ' && c1?.activeBullishSectors.join(',') === 'PSU Bank'
  );
  await recordPriorityCycle({ ...baseRow, suggestionCount: 7 });
  const rows = await getPriorityCyclesForDate(pd);
  check('same-bucket upsert does not duplicate', rows.length === 1 && rows[0].suggestionCount === 7);

  const sig = (s: string, dir: 'bullish' | 'bearish', asOfMs: number): ActiveSectorSignal => ({
    sector: s, direction: dir, weightedPct: dir === 'bullish' ? 1 : -1, totalTurnover: 9, turnoverRank: 1,
    advanceRatio: dir === 'bullish' ? 0.8 : 0.2, stocks: 5, officialNsePct: null, asOfMs,
  });

  // Non-empty snapshot + faithful asOf round-trip (delayed persistence must NOT
  // make the signal look newer — PR#11 re-review B2).
  const observedAtMs = 1_800_000_025_000;
  const observedBucketTs = 1_800_000_000;
  const prepared = prepareSectorSnapshotWrite({
    aggregates: [{
      sector: 'PSU Bank', stocks: 5, totalTurnover: 9, weightedPct: 1, simplePct: 1,
      advancers: 4, decliners: 1, unchanged: 0, advanceRatio: 0.8,
    }],
    marketDataAsOfMs: observedAtMs,
    currentCycleBucketTs: observedBucketTs,
    nowMs: observedAtMs + 155_000,
  });
  await recordSectorSnapshot(pd, prepared.bucketTs, prepared.asOfMs, prepared.signals);
  const snap1 = await getLatestSectorSnapshot(pd);
  check('non-empty sector snapshot reads back', snap1.length === 1 && snap1.some((s) => s.sector === 'PSU Bank'));
  check('13-digit sector asOfMs round-trips exactly (observation time preserved)', snap1.every((s) => s.asOfMs === observedAtMs));
  check('stored sector bucket comes from quote observation time', prepared.bucketTs === observedBucketTs);

  // Newer bucket qualifies NOTHING → latest read is [] (no stale carryover).
  await recordSectorSnapshot(pd, observedBucketTs + 300, observedAtMs + 300_000, []);
  const snap2 = await getLatestSectorSnapshot(pd);
  check('empty latest batch returns [] (no stale carryover)', snap2.length === 0);
  const prior = await getLatestSectorSnapshotBefore(pd, observedBucketTs + 300);
  check('bounded read uses newest batch strictly before current cycle', prior.length === 1 && prior[0].asOfMs === observedAtMs);

  // Rerun the same bucket with a sector dropped → atomic replace removes it.
  await recordSectorSnapshot(pd, observedBucketTs + 600, observedAtMs + 600_000, [sig('PSU Bank', 'bullish', observedAtMs + 600_000), sig('IT', 'bullish', observedAtMs + 600_000)]);
  await recordSectorSnapshot(pd, observedBucketTs + 600, observedAtMs + 650_000, [sig('PSU Bank', 'bullish', observedAtMs + 650_000)]);
  const snap3 = await getLatestSectorSnapshot(pd);
  check('rerun removes disappeared sectors (atomic replace)', snap3.length === 1 && snap3[0].sector === 'PSU Bank');

  const invalid = prepareSectorSnapshotWrite({
    aggregates: [{
      sector: 'PSU Bank', stocks: 5, totalTurnover: 9, weightedPct: 1, simplePct: 1,
      advancers: 4, decliners: 1, unchanged: 0, advanceRatio: 0.8,
    }],
    marketDataAsOfMs: Number.NaN,
    currentCycleBucketTs: observedBucketTs + 900,
    nowMs: observedAtMs + 900_000,
  });
  await recordSectorSnapshot(pd, invalid.bucketTs, invalid.asOfMs, invalid.signals);
  const snap4 = await getLatestSectorSnapshot(pd);
  check('invalid quote asOf stores an empty latest cycle (no old signal reuse)', snap4.length === 0 && invalid.asOfMs === 0);

  try {
    await prisma.$disconnect();
  } catch {
    // ignore
  }
}

console.log('=== Priority-refresh store round-trip (isolated temp SQLite) ===\n');
void main()
  .then(() => {
    teardown();
    console.log(`\n${failures === 0 ? '✅ all priority-store checks passed' : `❌ ${failures} check(s) FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    teardown();
    console.error(err);
    process.exit(1);
  });
