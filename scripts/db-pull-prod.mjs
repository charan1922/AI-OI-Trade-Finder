// scripts/db-pull-prod.mjs
//
// Pull production DB data into the local dev DB.
//
//   pnpm db:pull-prod          → curated SUBSET (the tables /live + the scanner
//                                need; intraday tables trimmed to the latest day).
//                                Fast (~20 MB), skips the ~200 MB of backtest rows.
//   pnpm db:pull-prod:full     → FULL CLONE (every table, every row, plus indexes /
//                                triggers / views). ~200 MB. Makes local == prod for
//                                all tables — WIPES local-only rows in the process.
//
// What it does (see memory: pull-prod-db-to-local):
//   1. On the Railway server, builds /tmp/subset.db from prod ATTACHed READ-ONLY —
//      a curated subset by default, or a full clone with --full.
//   2. Streams that file down over `railway ssh` (base64).
//   3. Merges it into the local data/project-r.db (DROP + recreate + INSERT each
//      table, then re-create indexes/triggers/views in --full mode). The merge runs
//      transactionally through a live connection, so it's safe with the dev server up.
//
// It NEVER writes to prod (prod is ATTACHed read-only on the server). Safe to re-run
// any time you want fresh prod data locally.

// --- Mode ---
const FULL_COPY = process.argv.includes('--full');

import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// --- Prod target -------------------------------------------------------------
// Since 2026-07-17 prod lives on the self-hosted AWS box (see memory:
// aws-box-is-prod); Railway is stopped. Default backend is `aws` (ssh to the
// box, run node INSIDE the app container). Set PULL_BACKEND=railway to use the
// old transport if Railway is ever revived.
const BACKEND = process.env.PULL_BACKEND || 'aws';
const AWS_HOST = process.env.PROD_BOX_HOST || 'ubuntu@3.108.33.64';
const AWS_KEY =
  process.env.PROD_BOX_KEY || join(process.env.USERPROFILE || process.env.HOME || '', '.ssh', 'projectr-throwaway.pem');

// --- Railway target (legacy; kept for PULL_BACKEND=railway) ---
const PROJECT = 'd5d24ef5-cd81-401e-a3d4-b319ef66e4bf';
const ENVIRONMENT = 'a6fcc8f0-dec3-4b56-abdb-6bcf5e513a54';
const SERVICE = 'a5ce553b-bbd1-4699-8465-6ff34aeac202';
const PROD_DB = '/app/data/project-r.db';

// --- What to pull ---
// Full table copy:
const FULL_TABLES = [
  'fno_stocks',
  'master_contracts',
  'bhavcopy_days',
  'live_urgency_eod',
  'fno_expiry_calendar',
  'market_holidays',
  'feature_toggles',
  'trade_band_ranges',
  'band_overrides',
];
// Latest snapshot date only (these grow every 5 min; we only need the freshest day
// locally). All are live-recorded by the Fyers poller and pruned to the current
// session on prod, so the latest date is the whole useful history:
//   oi_intraday    → Since-9:45, OI urgency, the closing-snapshot baseline
//   fyers_candles  → App Breakout + App OIΔ30m + the /live candles route (both the
//                    EQ 5-min bars and the FUT nseOiPct series live here)
//   rank_snapshots → the "Running race" climbers panel
const LATEST_DATE_TABLES = { oi_intraday: 'date', fyers_candles: 'date', rank_snapshots: 'date' };

const LOCAL_DB = join(ROOT, 'data', 'project-r.db');
const SUBSET_LOCAL = join(ROOT, 'data', '.subset-pull.db'); // scratch, deleted at the end

function log(msg) {
  process.stdout.write(`[pull-prod] ${msg}\n`);
}

function railwaySsh(remoteCmd, { capture = false } = {}) {
  // Wrap remoteCmd in double quotes so the shell treats the whole remote pipeline
  // (echo ... | base64 -d | node) as ONE argument to `railway ssh` — the pipes must
  // run on the server, not locally. cmd.exe (and sh) do not interpret `|` inside "".
  const cmd = `railway ssh -p ${PROJECT} -e ${ENVIRONMENT} -s ${SERVICE} "${remoteCmd}"`;
  return execSync(cmd, {
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : ['ignore', 'inherit', 'inherit'],
    maxBuffer: 1024 * 1024 * 1024, // 1 GB — base64 of the subset can be tens of MB
    encoding: capture ? 'utf8' : undefined,
  });
}

function awsSsh(remoteCmd, { capture = false } = {}) {
  // Same idea over plain ssh to the AWS box. The remote pipeline runs on the
  // box; anything that must run inside the app container is already phrased as
  // `sudo docker exec …` by the caller. READ-ONLY throughout: the builder
  // ATTACHes prod read-only and writes only /tmp/subset.db inside the container.
  const cmd = `ssh -i "${AWS_KEY}" -o StrictHostKeyChecking=accept-new ${AWS_HOST} "${remoteCmd}"`;
  return execSync(cmd, {
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : ['ignore', 'inherit', 'inherit'],
    maxBuffer: 1024 * 1024 * 1024,
    encoding: capture ? 'utf8' : undefined,
  });
}

/** Run the builder JS on prod (stdin-piped into node) and stream files back. */
function prodRunNode(builderB64) {
  if (BACKEND === 'railway') return railwaySsh(`echo ${builderB64} | base64 -d | node`);
  return awsSsh(`echo ${builderB64} | base64 -d | sudo docker exec -i projectr node -`);
}
function prodReadSubsetB64() {
  if (BACKEND === 'railway') return railwaySsh('base64 -w0 /tmp/subset.db', { capture: true });
  return awsSsh('sudo docker exec projectr base64 -w0 /tmp/subset.db', { capture: true });
}

// ---------------------------------------------------------------------------
// 1) Build the trimmed subset on the server.
// ---------------------------------------------------------------------------
// This JS runs under the server's node, requiring better-sqlite3 by ABSOLUTE
// path (module resolution starts at /tmp when we pipe it into `node`).
const serverBuilder = `
const Database = require('/app/node_modules/better-sqlite3');
const fs = require('fs');
try { fs.unlinkSync('/tmp/subset.db'); } catch (e) {}
const db = new Database('/tmp/subset.db');
db.exec("ATTACH DATABASE '${PROD_DB}' AS prod");
const FULL_COPY = ${FULL_COPY};
const FULL = ${JSON.stringify(FULL_TABLES)};
const LATEST = ${JSON.stringify(LATEST_DATE_TABLES)};
function exists(name){ return !!db.prepare("SELECT 1 FROM prod.sqlite_master WHERE type='table' AND name=?").get(name); }
function create(name){
  const row = db.prepare("SELECT sql FROM prod.sqlite_master WHERE type='table' AND name=?").get(name);
  if (!row || !row.sql) return false;
  db.exec(row.sql);
  return true;
}
function copyFull(name){
  create(name);
  db.exec('INSERT INTO main."' + name + '" SELECT * FROM prod."' + name + '"');
  const n = db.prepare('SELECT COUNT(*) c FROM main."' + name + '"').get().c;
  console.error('  ' + name + ': ' + n + ' rows');
}
if (FULL_COPY) {
  // Every user table, in full. sqlite_% internal tables are recreated implicitly
  // (sqlite_sequence by AUTOINCREMENT, sqlite_stat* by ANALYZE) — never copied.
  const tables = db.prepare("SELECT name FROM prod.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  for (const { name } of tables) copyFull(name);
  // Indexes / triggers / views last — they reference the tables just created.
  const objs = db.prepare("SELECT type, name, sql FROM prod.sqlite_master WHERE type IN ('index','trigger','view') AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").all();
  let extra = 0;
  for (const o of objs) { try { db.exec(o.sql); extra++; } catch (e) { console.error('  skip ' + o.type + ' ' + o.name + ': ' + e.message); } }
  console.error('  + ' + extra + ' indexes/triggers/views');
} else {
  for (const t of FULL){
    if (!exists(t)) { console.error('  skip (missing on prod): ' + t); continue; }
    copyFull(t);
  }
  for (const t of Object.keys(LATEST)){
    const col = LATEST[t];
    if (!exists(t)) { console.error('  skip (missing on prod): ' + t); continue; }
    create(t);
    db.exec('INSERT INTO main."' + t + '" SELECT * FROM prod."' + t + '" WHERE ' + col + ' = (SELECT MAX(' + col + ') FROM prod."' + t + '")');
    const n = db.prepare('SELECT COUNT(*) c FROM main."' + t + '"').get().c;
    const d = db.prepare('SELECT MAX(' + col + ') d FROM main."' + t + '"').get().d;
    console.error('  ' + t + ': ' + n + ' rows (latest ' + col + '=' + d + ')');
  }
}
db.exec('VACUUM');
db.close();
console.error('subset built at /tmp/subset.db');
`;

log(
  FULL_COPY
    ? 'building FULL clone on the server (prod ATTACHed read-only, ~200 MB)...'
    : 'building trimmed subset on the server (prod ATTACHed read-only)...'
);
const builderB64 = Buffer.from(serverBuilder, 'utf8').toString('base64');
log(`backend: ${BACKEND}${BACKEND === 'aws' ? ` (${AWS_HOST})` : ''}`);
prodRunNode(builderB64);

// ---------------------------------------------------------------------------
// 2) Stream the subset down (base64; stderr carries the "Using SSH key" banner).
// ---------------------------------------------------------------------------
log('downloading subset...');
const b64 = prodReadSubsetB64();
const buf = Buffer.from(b64.trim(), 'base64');
if (buf.length < 16 || buf.subarray(0, 15).toString('ascii') !== 'SQLite format 3') {
  throw new Error(`downloaded blob is not a SQLite file (got ${buf.length} bytes). Is the server reachable / built?`);
}
if (!existsSync(join(ROOT, 'data'))) mkdirSync(join(ROOT, 'data'), { recursive: true });
writeFileSync(SUBSET_LOCAL, buf);
log(`downloaded ${(buf.length / 1024 / 1024).toFixed(1)} MB`);

// ---------------------------------------------------------------------------
// 3) Merge into the local DB (DROP + recreate + INSERT each table in the subset).
// ---------------------------------------------------------------------------
log('merging into local data/project-r.db ...');
const Database = require('better-sqlite3');
const local = new Database(LOCAL_DB);
try {
  local.pragma('busy_timeout = 60000'); // dev server may hold the DB open (WAL); full clone writes longer
  local.exec(`ATTACH DATABASE '${SUBSET_LOCAL.replace(/\\/g, '/')}' AS src`);
  const tables = local
    .prepare("SELECT name, sql FROM src.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all();
  local.exec('BEGIN IMMEDIATE');
  for (const { name, sql } of tables) {
    local.exec(`DROP TABLE IF EXISTS main."${name}"`); // also drops its dependent indexes/triggers
    local.exec(sql); // recreate with the exact schema from the subset
    local.exec(`INSERT INTO main."${name}" SELECT * FROM src."${name}"`);
    const n = local.prepare(`SELECT COUNT(*) c FROM main."${name}"`).get().c;
    log(`  merged ${name}: ${n} rows`);
  }
  // Full clone: mirror indexes/triggers/views too (the subset never carries them).
  // Tables were just dropped+recreated, so any old dependents are gone — recreate clean.
  if (FULL_COPY) {
    const objs = local
      .prepare(
        "SELECT type, name, sql FROM src.sqlite_master WHERE type IN ('index','trigger','view') AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'"
      )
      .all();
    for (const { type, name, sql } of objs) {
      local.exec(`DROP ${type.toUpperCase()} IF EXISTS main."${name}"`);
      local.exec(sql);
    }
    log(`  recreated ${objs.length} indexes/triggers/views`);
  }
  local.exec('COMMIT');
} catch (err) {
  try {
    local.exec('ROLLBACK');
  } catch {}
  throw err;
} finally {
  local.close();
}

// cleanup scratch
try {
  unlinkSync(SUBSET_LOCAL);
} catch {}

log(
  FULL_COPY
    ? 'done. Local DB is now a FULL clone of prod (all tables, indexes included).'
    : 'done. Local DB now has fresh prod data for /live + scanner.'
);
