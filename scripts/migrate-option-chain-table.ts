/**
 * One-time migration for the R-Factor V2 retirement (2026-08-11).
 *
 *   1. copy `rfactor_v2_option_snapshots` -> `option_chain_snapshots`
 *   2. drop `rfactor_v2_option_snapshots`, `rfactor_v2_snapshots`,
 *      `rfactor_v2_bucket_owner`
 *   3. drop the `rFactorV2*` columns from `live_urgency_eod`
 *
 * WHY A SCRIPT AND NOT `db push`: the DB holds several tables that are created
 * at runtime with raw SQL and are NOT declared in schema.prisma
 * (bhavcopy_*_expiry, trade_commentary, market_holidays, …). `prisma db push
 * --accept-data-loss` would drop those to match the schema and destroy real
 * data — see CLAUDE.md. So the change is applied explicitly, here.
 *
 * WHY COPY RATHER THAN DROP: the option-chain evidence is the ONLY material a
 * future run of scripts/measure-option-evidence.ts has. Dhan publishes no
 * historical option chain, so a dropped row is gone permanently and the sample
 * restarts from zero. The V2 SCORE snapshots carry no such value — they fed a
 * model that never influenced a decision — so those are dropped outright.
 *
 * IDEMPOTENT. Safe to run on a DB that has already been migrated, on a fresh
 * DB, and on one where the old tables never existed. Run it before deploying
 * the code that stops writing the old tables:
 *
 *   npx tsx scripts/migrate-option-chain-table.ts            # apply
 *   npx tsx scripts/migrate-option-chain-table.ts --dry-run  # report only
 */
// Tolerant on purpose: this script runs BOTH locally (where .env.local exists)
// and inside the container at start-up (where it does not — .env.local is
// dockerignored, and the real values arrive as real env vars). process.loadEnvFile
// THROWS on a missing file, so an unguarded call would make the migration fail on
// every single prod boot while looking like a config problem.
try {
  process.loadEnvFile('.env.local');
} catch {
  // No .env.local — running in the container, where env vars are already set.
}

import { prisma } from '@/lib/db';
import { ensureOptionChainTable } from '@/lib/option-chain/store';

const DRY = process.argv.includes('--dry-run');

async function tableExists(name: string): Promise<boolean> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`,
    name,
  )) as { name: string }[];
  return rows.length > 0;
}

async function columnsOf(table: string): Promise<string[]> {
  const rows = (await prisma.$queryRawUnsafe(`PRAGMA table_info(${table})`)) as { name: string }[];
  return rows.map((r) => r.name);
}

async function countOf(table: string): Promise<number> {
  const rows = (await prisma.$queryRawUnsafe(`SELECT COUNT(*) AS c FROM ${table}`)) as { c: number | bigint }[];
  return Number(rows[0]?.c ?? 0);
}

async function main(): Promise<void> {
  console.log(DRY ? '── DRY RUN — nothing will be written ──\n' : '── applying migration ──\n');

  await ensureOptionChainTable();

  // ─ 1. carry the option evidence across ─────────────────────────────────────
  const legacy = 'rfactor_v2_option_snapshots';
  if (await tableExists(legacy)) {
    const before = await countOf(legacy);
    const already = await countOf('option_chain_snapshots');
    console.log(`${legacy}: ${before} rows | option_chain_snapshots: ${already} rows`);
    if (!DRY) {
      // Column-explicit, and INSERT OR IGNORE so a re-run cannot duplicate or
      // clobber. Legacy rows missing the later columns fall back to the same
      // defaults the old table declared.
      const cols = new Set(await columnsOf(legacy));
      const pick = (c: string, fallback: string): string => (cols.has(c) ? c : fallback);
      const moved = await prisma.$executeRawUnsafe(`
        INSERT OR IGNORE INTO option_chain_snapshots
          (date,bucketTs,symbol,capturedAt,expiry,activityScore,direction,directionScore,
           directionConfidence,premiumValue,optionVolume,paceBaselineKind,optionEvidenceVersion,evidence)
        SELECT date,bucketTs,symbol,capturedAt,expiry,activityScore,direction,directionScore,
               directionConfidence,
               ${pick('premiumValue', '0')},
               ${pick('optionVolume', '0')},
               ${pick('paceBaselineKind', "'missing'")},
               ${pick('optionEvidenceVersion', "'unknown'")},
               evidence
          FROM ${legacy}
      `);
      console.log(`  copied ${moved} row(s) -> option_chain_snapshots (now ${await countOf('option_chain_snapshots')})`);
    }
  } else {
    console.log(`${legacy}: absent — nothing to copy`);
  }

  // ─ 2. drop the retired tables ──────────────────────────────────────────────
  for (const t of ['rfactor_v2_option_snapshots', 'rfactor_v2_snapshots', 'rfactor_v2_bucket_owner']) {
    if (!(await tableExists(t))) {
      console.log(`drop ${t}: already absent`);
      continue;
    }
    const n = await countOf(t);
    if (DRY) {
      console.log(`drop ${t}: WOULD DROP (${n} rows)`);
      continue;
    }
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${t}`);
    console.log(`drop ${t}: dropped (${n} rows)`);
  }

  // ─ 3. strip the V2 columns off the frozen EOD board ────────────────────────
  // live_urgency_eod is a PERMANENT archive, so this is the one genuinely lossy
  // step: the historical V2 readings in those columns go with them. That is the
  // operator's explicit instruction (nothing named after the experiment should
  // remain), and the columns describe a model that never traded.
  if (await tableExists('live_urgency_eod')) {
    const v2Columns = (await columnsOf('live_urgency_eod')).filter((c) => c.startsWith('rFactorV2'));
    if (v2Columns.length === 0) {
      console.log('live_urgency_eod: no rFactorV2* columns left');
    }
    for (const col of v2Columns) {
      if (DRY) {
        console.log(`live_urgency_eod: WOULD DROP COLUMN ${col}`);
        continue;
      }
      try {
        await prisma.$executeRawUnsafe(`ALTER TABLE live_urgency_eod DROP COLUMN ${col}`);
        console.log(`live_urgency_eod: dropped column ${col}`);
      } catch (error) {
        // SQLite can refuse DROP COLUMN on a column referenced by an index or
        // view. Report it rather than pretending the migration was complete.
        console.log(`live_urgency_eod: could NOT drop ${col} — ${(error as Error).message}`);
      }
    }
  }

  console.log(DRY ? '\n── dry run complete ──' : '\n── migration complete ──');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
