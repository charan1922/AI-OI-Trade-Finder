// scripts/db-pull-prod.mjs
//
// Pull production DB data into the local dev DB — over HTTPS, no SSH.
//
//   pnpm db:pull-prod          → curated SUBSET (the tables /live + the scanner
//                                need; intraday tables trimmed to the latest day).
//                                Fast (~20 MB), skips the ~200 MB of backtest rows.
//   pnpm db:pull-prod:full     → FULL CLONE (every table, every row, plus indexes /
//                                triggers / views). Makes local == prod for all
//                                tables — WIPES local-only rows in the process.
//
// How it works (see memory: pull-prod-db-to-local, aws-box-is-prod):
//   1. POST /api/db-explorer/dump on the prod box (admin, HTTP Basic with
//      APP_PASSWORD) — the box builds the subset/clone IN-PROCESS from its live
//      DB (ATTACHed read-only) and streams it back as a SQLite file.
//   2. That file is saved locally, then merged into data/project-r.db (DROP +
//      recreate + INSERT each table, transactionally, safe with the dev server up).
//
// WHY HTTPS not SSH: 443 is always open and authenticated, so this works whenever
// the box is up regardless of your laptop's IP — unlike SSH (port 22), which is
// IP-allowlisted and unreachable while the box sleeps nights/weekends. It NEVER
// writes to prod (the box ATTACHes its live DB read-only). Safe to re-run anytime.
//
// Config (env overrides): PROD_BOX_URL (default the DuckDNS origin),
// PROD_APP_PASSWORD / APP_PASSWORD (the box's operator password; auto-loaded from
// .env.local).

const FULL_COPY = process.argv.includes('--full');

import { createWriteStream, existsSync, mkdirSync, openSync, readSync, closeSync, statSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Load .env.local so APP_PASSWORD is available (Node 24 built-in; best-effort).
try {
  process.loadEnvFile(join(ROOT, '.env.local'));
} catch {
  // no .env.local — rely on ambient env / explicit PROD_APP_PASSWORD
}

const PROD_URL = (process.env.PROD_BOX_URL || 'https://charan-projectr.duckdns.org').replace(/\/+$/, '');
const PASSWORD = process.env.PROD_APP_PASSWORD || process.env.APP_PASSWORD;

const LOCAL_DB = join(ROOT, 'data', 'project-r.db');
const SUBSET_LOCAL = join(ROOT, 'data', '.subset-pull.db'); // scratch, deleted at the end

function log(msg) {
  process.stdout.write(`[pull-prod] ${msg}\n`);
}
function die(msg) {
  process.stderr.write(`[pull-prod] ${msg}\n`);
  process.exit(1);
}

if (!PASSWORD) {
  die(
    'No operator password found. Set PROD_APP_PASSWORD (or APP_PASSWORD) in .env.local\n' +
      '  — the same password the box uses (memory: keep .env.local in sync with the server).'
  );
}

// ---------------------------------------------------------------------------
// 1) Ask the box to build + stream the copy (HTTPS, HTTP Basic admin auth).
// ---------------------------------------------------------------------------
log(`pulling ${FULL_COPY ? 'FULL clone' : 'trimmed subset'} from ${PROD_URL} ...`);
const auth = 'Basic ' + Buffer.from(`x:${PASSWORD}`).toString('base64');
let res;
try {
  res = await fetch(`${PROD_URL}/api/db-explorer/dump`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify({ full: FULL_COPY }),
  });
} catch (err) {
  die(`could not reach ${PROD_URL} (${err.cause?.code || err.message}). Is the box up? Try: pnpm box:status`);
}
if (res.status === 401 || res.status === 403) {
  die(`auth rejected (HTTP ${res.status}). Check APP_PASSWORD in .env.local matches the box's operator password.`);
}
if (!res.ok || !res.body) {
  const text = await res.text().catch(() => '');
  die(`dump endpoint returned HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
}

// ---------------------------------------------------------------------------
// 2) Stream the SQLite file down to a scratch path and sanity-check it.
// ---------------------------------------------------------------------------
if (!existsSync(join(ROOT, 'data'))) mkdirSync(join(ROOT, 'data'), { recursive: true });
await pipeline(Readable.fromWeb(res.body), createWriteStream(SUBSET_LOCAL));
const bytes = statSync(SUBSET_LOCAL).size;
const fd = openSync(SUBSET_LOCAL, 'r');
const head = Buffer.alloc(16);
readSync(fd, head, 0, 16, 0);
closeSync(fd);
if (bytes < 16 || head.subarray(0, 15).toString('ascii') !== 'SQLite format 3') {
  die(`downloaded blob is not a SQLite file (got ${bytes} bytes). The box may have returned an error page.`);
}
log(`downloaded ${(bytes / 1024 / 1024).toFixed(1)} MB`);

// ---------------------------------------------------------------------------
// 3) Merge into the local DB (DROP + recreate + INSERT each table in the copy).
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
    local.exec(sql); // recreate with the exact schema from the copy
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
  } catch {
    // nothing to roll back
  }
  die(`merge failed: ${err.message}`);
} finally {
  local.close();
}

// cleanup scratch
try {
  unlinkSync(SUBSET_LOCAL);
} catch {
  // best-effort
}

log(
  FULL_COPY
    ? 'done. Local DB is now a FULL clone of prod (all tables, indexes included).'
    : 'done. Local DB now has fresh prod data for /live + scanner.'
);
