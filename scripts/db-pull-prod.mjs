// scripts/db-pull-prod.mjs
//
// Pull a READ-ONLY subset of the production DB into the local dev DB.
//
//   pnpm db:pull-prod
//
// What it does (see memory: pull-prod-db-to-local):
//   1. On the Railway server, builds a trimmed /tmp/subset.db containing only the
//      tables /live and the scanner need (prod DB is ~200MB, mostly backtest rows
//      we don't want locally).
//   2. Streams that subset down over `railway ssh` (base64).
//   3. Merges it into the local data/project-r.db (DROP + recreate + INSERT each table).
//
// It NEVER writes to prod (prod is ATTACHed read-only on the server). Safe to re-run
// any time you want fresh prod data locally.

import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// --- Railway target (same IDs as the server:up / server:down package.json scripts) ---
const PROJECT = "d5d24ef5-cd81-401e-a3d4-b319ef66e4bf";
const ENVIRONMENT = "a6fcc8f0-dec3-4b56-abdb-6bcf5e513a54";
const SERVICE = "a5ce553b-bbd1-4699-8465-6ff34aeac202";
const PROD_DB = "/app/data/project-r.db";

// --- What to pull ---
// Full table copy:
const FULL_TABLES = [
  "fno_stocks",
  "master_contracts",
  "bhavcopy_days",
  "live_urgency_eod",
  "fno_expiry_calendar",
  "market_holidays",
  "feature_toggles",
  "trade_band_ranges",
  "band_overrides",
];
// Latest snapshot date only (these grow every 5 min; we only need the freshest day locally):
const LATEST_DATE_TABLES = { oi_intraday: "date" };

const LOCAL_DB = join(ROOT, "data", "project-r.db");
const SUBSET_LOCAL = join(ROOT, "data", ".subset-pull.db"); // scratch, deleted at the end

function log(msg) {
  process.stdout.write(`[pull-prod] ${msg}\n`);
}

function railwaySsh(remoteCmd, { capture = false } = {}) {
  // Wrap remoteCmd in double quotes so the shell treats the whole remote pipeline
  // (echo ... | base64 -d | node) as ONE argument to `railway ssh` — the pipes must
  // run on the server, not locally. cmd.exe (and sh) do not interpret `|` inside "".
  const cmd = `railway ssh -p ${PROJECT} -e ${ENVIRONMENT} -s ${SERVICE} "${remoteCmd}"`;
  return execSync(cmd, {
    stdio: capture ? ["ignore", "pipe", "inherit"] : ["ignore", "inherit", "inherit"],
    maxBuffer: 1024 * 1024 * 1024, // 1 GB — base64 of the subset can be tens of MB
    encoding: capture ? "utf8" : undefined,
  });
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
const FULL = ${JSON.stringify(FULL_TABLES)};
const LATEST = ${JSON.stringify(LATEST_DATE_TABLES)};
function exists(name){ return !!db.prepare("SELECT 1 FROM prod.sqlite_master WHERE type='table' AND name=?").get(name); }
function create(name){
  const row = db.prepare("SELECT sql FROM prod.sqlite_master WHERE type='table' AND name=?").get(name);
  if (!row || !row.sql) return false;
  db.exec(row.sql);
  return true;
}
for (const t of FULL){
  if (!exists(t)) { console.error('  skip (missing on prod): ' + t); continue; }
  create(t);
  db.exec('INSERT INTO main.' + t + ' SELECT * FROM prod.' + t);
  const n = db.prepare('SELECT COUNT(*) c FROM main.' + t).get().c;
  console.error('  ' + t + ': ' + n + ' rows');
}
for (const t of Object.keys(LATEST)){
  const col = LATEST[t];
  if (!exists(t)) { console.error('  skip (missing on prod): ' + t); continue; }
  create(t);
  db.exec('INSERT INTO main.' + t + ' SELECT * FROM prod.' + t + ' WHERE ' + col + ' = (SELECT MAX(' + col + ') FROM prod.' + t + ')');
  const n = db.prepare('SELECT COUNT(*) c FROM main.' + t).get().c;
  const d = db.prepare('SELECT MAX(' + col + ') d FROM main.' + t).get().d;
  console.error('  ' + t + ': ' + n + ' rows (latest ' + col + '=' + d + ')');
}
db.exec('VACUUM');
db.close();
console.error('subset built at /tmp/subset.db');
`;

log("building trimmed subset on the server (prod ATTACHed read-only)...");
const builderB64 = Buffer.from(serverBuilder, "utf8").toString("base64");
railwaySsh(`echo ${builderB64} | base64 -d | node`);

// ---------------------------------------------------------------------------
// 2) Stream the subset down (base64; stderr carries the "Using SSH key" banner).
// ---------------------------------------------------------------------------
log("downloading subset...");
const b64 = railwaySsh("base64 -w0 /tmp/subset.db", { capture: true });
const buf = Buffer.from(b64.trim(), "base64");
if (buf.length < 16 || buf.subarray(0, 15).toString("ascii") !== "SQLite format 3") {
  throw new Error(`downloaded blob is not a SQLite file (got ${buf.length} bytes). Is the server reachable / built?`);
}
if (!existsSync(join(ROOT, "data"))) mkdirSync(join(ROOT, "data"), { recursive: true });
writeFileSync(SUBSET_LOCAL, buf);
log(`downloaded ${(buf.length / 1024 / 1024).toFixed(1)} MB`);

// ---------------------------------------------------------------------------
// 3) Merge into the local DB (DROP + recreate + INSERT each table in the subset).
// ---------------------------------------------------------------------------
log("merging into local data/project-r.db ...");
const Database = require("better-sqlite3");
const local = new Database(LOCAL_DB);
try {
  local.pragma("busy_timeout = 20000"); // dev server may hold the DB open (WAL)
  local.exec(`ATTACH DATABASE '${SUBSET_LOCAL.replace(/\\/g, "/")}' AS src`);
  const tables = local
    .prepare("SELECT name, sql FROM src.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all();
  local.exec("BEGIN IMMEDIATE");
  for (const { name, sql } of tables) {
    local.exec(`DROP TABLE IF EXISTS main."${name}"`);
    local.exec(sql); // recreate with the exact schema from the subset
    local.exec(`INSERT INTO main."${name}" SELECT * FROM src."${name}"`);
    const n = local.prepare(`SELECT COUNT(*) c FROM main."${name}"`).get().c;
    log(`  merged ${name}: ${n} rows`);
  }
  local.exec("COMMIT");
} catch (err) {
  try { local.exec("ROLLBACK"); } catch {}
  throw err;
} finally {
  local.close();
}

// cleanup scratch
try { unlinkSync(SUBSET_LOCAL); } catch {}

log("done. Local DB now has fresh prod data for /live + scanner.");
