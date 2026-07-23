/**
 * DB round-trip checks for the auto-trade quote-snapshot store, against an
 * ISOLATED throwaway SQLite database. lib/db builds its path from
 * `process.cwd()/data/project-r.db` at import, so we chdir into a temp dir with
 * a data/ subdir BEFORE dynamically importing the store.
 *
 * Covers the integration points the pure bench cannot reach (PR#16 review):
 * the additive bidQty/askQty migration onto a table created before those
 * columns existed, that sizes round-trip, and that retention keeps only the
 * newest sessions. Runs in GitHub CI. Exit 1 on any failure.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NewAutoQuoteSnapshot } from '../lib/auto-trade/store';

const originalCwd = process.cwd();
const tmp = mkdtempSync(join(tmpdir(), 'autotrade-store-'));
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
    // Windows briefly holds the SQLite handle after disconnect; a leftover
    // temp dir is harmless, failing the run over it would not be.
  }
}

const snapshot = (over: Partial<NewAutoQuoteSnapshot> = {}): NewAutoQuoteSnapshot => ({
  tradeId: 1,
  date: '2099-05-05',
  capturedAt: '2099-05-05T04:30:00.000Z',
  source: 'guard',
  optSecurityId: '12345',
  ltp: 120,
  priceSource: 'ltp',
  bid: 119.5,
  ask: 120.5,
  bidQty: 750,
  askQty: 300,
  spreadPct: 0.8,
  slPremium: 100,
  targetPremium: 130,
  ...over,
});

async function main(): Promise<void> {
  const { prisma } = await import('../lib/db');

  // The table as it existed BEFORE bidQty/askQty — what a real in-place upgrade
  // hits. If the additive ALTER is wrong, every guard write starts failing.
  await prisma.$executeRawUnsafe(`
    CREATE TABLE auto_quote_snapshots (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      tradeId       INTEGER NOT NULL,
      date          TEXT NOT NULL,
      capturedAt    TEXT NOT NULL,
      source        TEXT NOT NULL,
      optSecurityId TEXT NOT NULL,
      ltp           REAL NOT NULL,
      priceSource   TEXT NOT NULL,
      bid           REAL,
      ask           REAL,
      spreadPct     REAL,
      slPremium     REAL NOT NULL,
      targetPremium REAL NOT NULL
    )
  `);

  const store = await import('../lib/auto-trade/store');
  await store.insertQuoteSnapshots([snapshot()]);

  const columns = new Set(
    (await prisma.$queryRawUnsafe<{ name: string }[]>(`PRAGMA table_info(auto_quote_snapshots)`)).map(
      (c) => c.name
    )
  );
  check(
    'bidQty/askQty are added to a pre-existing table',
    columns.has('bidQty') && columns.has('askQty'),
    [...columns].join(',')
  );

  const stored = await store.getQuoteSnapshotsForTrade(1);
  check(
    'displayed size round-trips through SQLite',
    stored.length === 1 && Number(stored[0].bidQty) === 750 && Number(stored[0].askQty) === 300,
    `bidQty=${stored[0]?.bidQty} askQty=${stored[0]?.askQty}`
  );

  // A stream snapshot records bid size but has no ask size — null must survive
  // as null rather than becoming 0, which would read as a real (empty) book.
  await store.insertQuoteSnapshots([
    snapshot({ tradeId: 2, source: 'fyers_stream', bidQty: 500, askQty: null }),
  ]);
  const streamRow = await store.getQuoteSnapshotsForTrade(2);
  check(
    'an unknown ask size stays null, never 0',
    streamRow.length === 1 && Number(streamRow[0].bidQty) === 500 && streamRow[0].askQty == null,
    `askQty=${streamRow[0]?.askQty}`
  );

  // Multi-row insert: the guard batches every open position in one statement,
  // so the placeholder arity has to match the column list exactly.
  await store.insertQuoteSnapshots([
    snapshot({ tradeId: 3, date: '2099-05-06' }),
    snapshot({ tradeId: 4, date: '2099-05-06' }),
    snapshot({ tradeId: 5, date: '2099-05-06' }),
  ]);
  const batched = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT COUNT(*) AS n FROM auto_quote_snapshots WHERE date = '2099-05-06'`
  );
  check('a batched multi-row insert stores every row', Number(batched[0].n) === 3, `${batched[0].n} rows`);

  // Retention keeps the newest sessions only.
  for (let i = 0; i < 26; i++) {
    const day = `2099-06-${String(i + 1).padStart(2, '0')}`;
    await store.insertQuoteSnapshots([snapshot({ tradeId: 100 + i, date: day })]);
  }
  const deleted = await store.pruneQuoteSnapshots();
  const kept = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT COUNT(DISTINCT date) AS n FROM auto_quote_snapshots`
  );
  check(
    'retention keeps the newest 20 sessions',
    Number(kept[0].n) === store.AUTO_QUOTE_SNAPSHOT_RETENTION_SESSIONS,
    `${kept[0].n} dates kept, ${deleted} rows deleted`
  );

  // Pruning twice must be a no-op, not a slow re-delete of the same rows.
  const secondPrune = await store.pruneQuoteSnapshots();
  check('a repeat prune deletes nothing', Number(secondPrune) === 0, `${secondPrune} rows`);

  try {
    await prisma.$disconnect();
  } catch {
    // ignore
  }
}

console.log('=== Auto-trade quote-snapshot store round-trip (isolated temp SQLite) ===\n');
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
