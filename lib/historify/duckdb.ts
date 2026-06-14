import { DuckDBInstance, DuckDBConnection } from '@duckdb/node-api';
import path from 'path';
import fs from 'fs';

import { isVercel as checkVercel } from '@/lib/env';

let _db: DuckDBInstance | null = null;
let _httpfsLoaded = false;
const onVercel = checkVercel();
const parquetDir = onVercel
  ? path.join('/tmp', 'parquet', 'historify')
  : path.join(process.cwd(), 'data', 'parquet', 'historify');

// Hugging Face dataset base URLs
const HF_DATASETS = {
  /** 5-minute F&O candles — files at root: {SYMBOL}.parquet */
  fno5min: 'https://huggingface.co/datasets/charan1922/fno-5min/resolve/main',
  /** 18-month historify data — files under historify/: {SYMBOL}.parquet */
  fno18m: 'https://huggingface.co/datasets/charan1922/fno-data-18months/resolve/main/historify',
} as const;

export async function getDuckDb(): Promise<DuckDBInstance> {
  if (_db) return _db;

  // Ensure the output directory exists
  if (!fs.existsSync(parquetDir)) {
    fs.mkdirSync(parquetDir, { recursive: true });
  }

  // Connect to an in-memory DuckDB instance since we are only querying/writing files
  // allow_unsigned_extensions required for httpfs to install via Node API
  _db = await DuckDBInstance.create(':memory:', { allow_unsigned_extensions: 'true' });

  return _db;
}

/**
 * Ensure httpfs extension is installed and loaded on the given connection.
 * Safe to call multiple times — only runs once per process.
 */
export async function ensureHttpfs(conn: DuckDBConnection): Promise<void> {
  if (_httpfsLoaded) return;
  // On Vercel, extensions must be installed to /tmp (only writable dir)
  if (onVercel) {
    await conn.run("SET extension_directory = '/tmp/duckdb_extensions';");
  }
  await conn.run('INSTALL httpfs; LOAD httpfs;');
  _httpfsLoaded = true;
}

/**
 * Build the remote Hugging Face URL for a symbol's parquet file.
 * @param symbol  e.g. "RELIANCE"
 * @param dataset Which HF dataset to use (default: fno18m which has daily+intraday)
 */
export function getCloudParquetUrl(symbol: string, dataset: keyof typeof HF_DATASETS = 'fno18m'): string {
  return `${HF_DATASETS[dataset]}/${symbol}.parquet`;
}

/**
 * Resolve the parquet source for a symbol — local path if available, otherwise cloud URL.
 * Returns { source: string; isCloud: boolean }
 */
export function resolveParquetSource(symbol: string, customFolder?: string): { source: string; isCloud: boolean } {
  const localPath = getParquetPath(symbol, customFolder);
  if (fs.existsSync(localPath)) {
    return { source: localPath, isCloud: false };
  }
  return { source: getCloudParquetUrl(symbol, 'fno18m'), isCloud: true };
}

/**
 * Helper to get the absolute path for a symbol's parquet file
 * @param symbol The trading symbol (e.g., RELIANCE)
 * @param customFolder Optional custom sub-folder (e.g., "parquet-5min")
 */
export function getParquetPath(symbol: string, customFolder?: string): string {
  const targetDir = customFolder ? path.join(process.cwd(), 'data', customFolder) : parquetDir;

  // Ensure the specific dynamic target directory exists before returning its path
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  return path.join(targetDir, `${symbol}.parquet`);
}
