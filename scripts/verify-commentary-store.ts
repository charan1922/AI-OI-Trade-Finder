/**
 * trade_commentary STORE round-trip against an ISOLATED throwaway SQLite
 * database. lib/db builds its file path from `process.cwd()/data/project-r.db`
 * at import, so we chdir into a temp dir with a data/ subdir BEFORE dynamically
 * importing the store. Runs in GitHub CI. Exit 1 on any failure.
 *
 * WHY this exists (PR#27 re-review): the viewer-privacy flag was asserted only
 * through the pure helper `executionStateFlag()`. That cannot see the DDL — and
 * the DDL disagreed with it. `CREATE TABLE` declared
 * `containsExecutionState INTEGER NOT NULL DEFAULT 0` (PUBLIC) while the
 * additive `ALTER TABLE` used `DEFAULT 1` (PRIVATE), so the same code had two
 * different privacy defaults depending on whether the installation was fresh or
 * upgraded. No pure check could ever catch that. These checks talk to a real
 * table, on both creation paths, because the write side of a privacy flag is
 * only proven by what SQLite actually stored.
 *
 * Only node built-ins are static here — the store is dynamically imported AFTER
 * the chdir so its prisma singleton binds to the temp DB.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The legacy-upgrade case cannot share this process: `tableReady` memoizes, and
 *  prisma binds its file path at import, so ensureCommentaryTable() can only be
 *  exercised once per process against one database. The parent re-runs THIS file
 *  as a child, cwd'd into a directory whose DB already holds a pre-flag table —
 *  so the store's own ALTER runs for real. */
const LEGACY_CHILD = process.env.COMMENTARY_STORE_LEGACY === '1';

const originalCwd = process.cwd();
// The child is spawned from the REPO ROOT so tsx still finds tsconfig.json (and
// with it the `@/…` path aliases the store imports through); it chdirs into its
// prepared database directory here, before any dynamic import binds prisma.
const tmp = LEGACY_CHILD
  ? (process.env.COMMENTARY_STORE_LEGACY_DIR as string)
  : mkdtempSync(join(tmpdir(), 'commentary-store-'));
if (!LEGACY_CHILD) mkdirSync(join(tmp, 'data'), { recursive: true });
process.chdir(tmp);

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

/** Best-effort: on Windows the better-sqlite3 handle can outlive $disconnect by
 *  a beat and rmSync throws EPERM. A leaked temp dir is not a failed assertion —
 *  never let cleanup turn a passing privacy check red. (CI is Linux; this is for
 *  the laptop run.) */
function teardown(): void {
  if (LEGACY_CHILD) return; // the parent owns (and removes) the child's directory
  process.chdir(originalCwd);
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* temp dir left behind for the OS to reap */
  }
}

/** Column list of `trade_commentary` BEFORE the privacy flag existed — the shape
 *  a long-running installation still has on disk when it upgrades. */
const PRE_FLAG_TABLE = `
  CREATE TABLE trade_commentary (
    id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, asOf TEXT NOT NULL,
    windowActive INTEGER NOT NULL DEFAULT 0, picksCount INTEGER NOT NULL DEFAULT 0,
    model TEXT NOT NULL, text TEXT NOT NULL, createdAt TEXT NOT NULL
  )
`;

/** Child mode: the DB in cwd already contains a pre-flag table with one row.
 *  Run the REAL ensureCommentaryTable() over it and report what its own ALTER
 *  stored. Asserting a hand-written copy of that ALTER would repeat the exact
 *  mistake this file exists to catch — a test that cannot see the shipped DDL. */
async function runLegacyChild(): Promise<void> {
  const { ensureCommentaryTable } = await import('../lib/ai-commentary/store');
  const { prisma } = await import('../lib/db');
  await ensureCommentaryTable();
  const row = (await prisma.$queryRawUnsafe(
    `SELECT containsExecutionState AS f FROM trade_commentary WHERE model = 'legacy'`
  )) as { f: number | null }[];
  await prisma.$disconnect();
  check(
    "the STORE's own ALTER backfills legacy rows to PRIVATE — both installation ages agree",
    row[0]?.f === 1,
    `stored ${row[0]?.f ?? 'nothing'}`
  );
}

async function main(): Promise<void> {
  if (LEGACY_CHILD) return runLegacyChild();

  const { ensureCommentaryTable, insertCommentary, getCommentary, executionStateFlag } = await import(
    '../lib/ai-commentary/store'
  );
  const { prisma } = await import('../lib/db');

  const date = '2099-04-04';
  const base = {
    date,
    asOf: `${date} 10:00`,
    windowActive: true,
    picksCount: 1,
    model: 'test-model',
    picks: [],
    promptTokens: 10,
    completionTokens: 20,
    promptKey: 'trade-commentary',
    promptVersion: 1,
  };

  // ── 1. The FRESH-table DDL default is private ───────────────────────────────
  // The bug this file was written for. Insert WITHOUT naming the column, so the
  // column default is the only thing deciding, on a table created moments ago by
  // CREATE TABLE (not by the legacy ALTER path).
  await ensureCommentaryTable();
  await prisma.$executeRawUnsafe(
    `INSERT INTO trade_commentary (date, asOf, windowActive, picksCount, model, text, picksJson, createdAt)
     VALUES (?, ?, 1, 0, 'raw', 'raw insert naming no privacy column', '[]', ?)`,
    date,
    `${date} 09:59`,
    new Date().toISOString()
  );
  const rawRow = (await prisma.$queryRawUnsafe(
    `SELECT containsExecutionState AS f FROM trade_commentary WHERE model = 'raw'`
  )) as { f: number }[];
  check(
    'fresh-table column default stores PRIVATE (1), not public',
    rawRow[0]?.f === 1,
    `stored ${rawRow[0]?.f ?? 'nothing'}`
  );

  // ── 2. Explicit classifications round-trip both ways ────────────────────────
  const privateId = await insertCommentary({
    ...base,
    text: 'INFY 1600CE: OPEN (entry ₹50) — operator book',
    containsExecutionState: true,
  });
  const publicId = await insertCommentary({
    ...base,
    text: 'Nothing traded today — scanner read only.',
    containsExecutionState: false,
  });
  check('insert returns real row ids', privateId > 0 && publicId > 0 && privateId !== publicId);

  const rows = await getCommentary({ date, limit: 10 });
  const privateRow = rows.find((r) => r.id === privateId);
  const publicRow = rows.find((r) => r.id === publicId);
  check('explicit true round-trips as private', privateRow?.containsExecutionState === true);
  check('explicit false round-trips as public', publicRow?.containsExecutionState === false);
  check(
    'the flag is stored as SQLite 0/1, not a string or NULL',
    ((await prisma.$queryRawUnsafe(
      `SELECT containsExecutionState AS f FROM trade_commentary WHERE id = ?`,
      publicId
    )) as { f: number }[])[0]?.f === 0
  );

  // ── 3. A runtime caller that skips the field still stores private ───────────
  // TypeScript now requires containsExecutionState, so an ordinary caller cannot
  // reach this. Untyped/dynamic callers can, and the helper is their backstop —
  // proven through the real INSERT, not just the pure function.
  const unclassifiedId = await insertCommentary({
    ...base,
    text: 'writer that did not classify itself',
  } as unknown as Parameters<typeof insertCommentary>[0]);
  const unclassified = (await getCommentary({ date, limit: 10 })).find((r) => r.id === unclassifiedId);
  check('an unclassified writer stores PRIVATE through the real INSERT', unclassified?.containsExecutionState === true);
  check(
    'the exported helper agrees with what the table stored',
    executionStateFlag(undefined) === 1 && executionStateFlag(true) === 1 && executionStateFlag(false) === 0
  );

  // ── 4. The LEGACY upgrade path also lands on private ────────────────────────
  // Build a pre-flag database, then hand it to a CHILD running this same file so
  // the store's real ALTER — not a copy of it pasted here — decides the value.
  const legacyDir = mkdtempSync(join(tmpdir(), 'commentary-legacy-'));
  mkdirSync(join(legacyDir, 'data'), { recursive: true });
  await prisma.$executeRawUnsafe(`ATTACH DATABASE ? AS legacy`, join(legacyDir, 'data', 'project-r.db'));
  await prisma.$executeRawUnsafe(PRE_FLAG_TABLE.replace('CREATE TABLE ', 'CREATE TABLE legacy.'));
  await prisma.$executeRawUnsafe(
    `INSERT INTO legacy.trade_commentary (date, asOf, model, text, createdAt)
     VALUES (?, ?, 'legacy', 'narration written before the flag existed', ?)`,
    date,
    `${date} 09:50`,
    new Date().toISOString()
  );
  await prisma.$executeRawUnsafe(`DETACH DATABASE legacy`);
  await prisma.$disconnect();

  // Inherit tsx's loader flags (--require preflight / --import loader); drop any
  // -e/--eval so the child runs this FILE, not an inline program.
  const loaderArgs = process.execArgv.filter((a, i, all) => {
    const prev = all[i - 1];
    return !/^(-e|--eval)$/.test(a) && !/^(-e|--eval)$/.test(prev ?? '');
  });
  const child = spawnSync(process.execPath, [...loaderArgs, process.argv[1]], {
    cwd: originalCwd, // repo root — tsx needs tsconfig.json for the `@/…` aliases
    env: { ...process.env, COMMENTARY_STORE_LEGACY: '1', COMMENTARY_STORE_LEGACY_DIR: legacyDir },
    stdio: 'inherit',
  });
  check(
    'legacy-upgrade child ran the real ensureCommentaryTable() and passed',
    child.status === 0,
    child.status === 0 ? '' : `child exited ${child.status}${child.error ? ` (${child.error.message})` : ''}`
  );
  try {
    rmSync(legacyDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* see teardown() */
  }
}

main()
  .then(() => {
    teardown();
    if (failures > 0) {
      console.error(`\n❌ ${failures} commentary-store check(s) failed`);
      process.exit(1);
    }
    console.log(LEGACY_CHILD ? '   (legacy-upgrade case passed)' : '\n✅ commentary store round-trip passed');
  })
  .catch((err) => {
    teardown();
    console.error(err);
    process.exit(1);
  });
