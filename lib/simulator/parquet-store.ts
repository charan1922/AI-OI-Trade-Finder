/**
 * Market Simulator — Parquet candle store (DuckDB-backed).
 *
 * Downloaded real candles persist as columnar **Parquet** files (one per
 * dataset) under `data/parquet/simulator/`, written and read through DuckDB —
 * reusing the same in-memory DuckDB instance the historify pages use (loaded via
 * dynamic import so the native module never leaks into the client bundle).
 *
 * Parquet (vs JSON) keeps the store columnar, compact, query-friendly at scale,
 * and directly push-ready to Hugging Face datasets (e.g. `charan1922/fno-5min`).
 */

import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { SimulatorConfig } from './config';
import type { SimCandle } from './types';

export const PARQUET_DIR = path.join(process.cwd(), 'data', 'parquet', 'simulator');

/** Deterministic Parquet filename for a resolved dataset. */
export function datasetKey(config: SimulatorConfig): string {
  return `${config.segment}_${config.securityId}_${config.interval}_${config.fromDate}_${config.toDate}.parquet`;
}

/** Normalize a path for DuckDB SQL (forward slashes, escaped quotes). */
function duckPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/'/g, "''");
}

async function connect() {
  // Dynamic import keeps @duckdb/node-api server-only (Turbopack-safe) — same
  // pattern as app/api/historify/day-chart.
  const { getDuckDb } = await import('@/lib/historify/duckdb');
  const db = await getDuckDb();
  return db.connect();
}

/** Read a dataset's candles back from Parquet. Returns null if not present. */
export async function readCandles(config: SimulatorConfig): Promise<SimCandle[] | null> {
  const file = path.join(PARQUET_DIR, datasetKey(config));
  if (!existsSync(file)) return null;

  const conn = await connect();
  const res = await conn.run(
    `SELECT time, open, high, low, close, volume, oi
     FROM read_parquet('${duckPath(file)}')
     ORDER BY time`,
  );
  const rows = (await res.getRows()) as unknown[][];
  if (rows.length === 0) return null;

  return rows.map((r) => ({
    time: Number(r[0]),
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5]),
    oi: Number(r[6]),
  }));
}

/** Persist a dataset's candles as a Parquet file (overwrites any existing). */
export async function writeCandles(config: SimulatorConfig, candles: SimCandle[]): Promise<void> {
  if (candles.length === 0) return;
  if (!existsSync(PARQUET_DIR)) mkdirSync(PARQUET_DIR, { recursive: true });
  const file = path.join(PARQUET_DIR, datasetKey(config));

  const conn = await connect();
  const sym = config.symbol.replace(/'/g, "''");
  const seg = config.segment.replace(/'/g, "''");
  const sec = config.securityId.replace(/'/g, "''");
  const kind = config.instrumentKind;
  const intv = config.interval;

  await conn.run(
    `CREATE OR REPLACE TEMP TABLE sim_write (
       symbol VARCHAR, segment VARCHAR, securityId VARCHAR, instrumentKind VARCHAR, interval VARCHAR,
       time BIGINT, open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE, volume DOUBLE, oi DOUBLE
     )`,
  );

  // Insert in chunks so the VALUES statement never grows unwieldy on long windows.
  const CHUNK = 1000;
  for (let i = 0; i < candles.length; i += CHUNK) {
    const values = candles
      .slice(i, i + CHUNK)
      .map(
        (c) =>
          `('${sym}','${seg}','${sec}','${kind}','${intv}',${c.time},${c.open},${c.high},${c.low},${c.close},${c.volume},${c.oi})`,
      )
      .join(',');
    await conn.run(`INSERT INTO sim_write VALUES ${values}`);
  }

  await conn.run(`COPY (SELECT * FROM sim_write ORDER BY time) TO '${duckPath(file)}' (FORMAT PARQUET)`);
  await conn.run('DROP TABLE sim_write');
}
