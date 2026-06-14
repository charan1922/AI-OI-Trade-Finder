/**
 * Market Simulator — historical data source.
 *
 * Resolves the instrument's Dhan security id, pulls candles (with OI for F&O)
 * from `/v2/charts/intraday`, normalizes the parallel arrays into `SimCandle[]`,
 * and persists them as columnar Parquet (via `parquet-store`) so re-loading the
 * same window is instant and doesn't re-hit Dhan's rate-limited API. A small
 * JSON manifest beside the Parquet files indexes the catalog for the UI.
 *
 * Replay-only by design: this never streams; it returns a frozen timeline that
 * the replay engine clocks through.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { clearCachedToken } from '@/lib/dhan/auth';
import { dhanRequest } from '@/lib/dhan/rate-limiter';
import { batchResolveFutures, resolveSymbol } from '@/lib/historify/master-contracts';
import { dhanInstrumentFor, type SimulatorConfig } from './config';
import { datasetKey, PARQUET_DIR, readCandles, writeCandles } from './parquet-store';
import type { SimCandle, SimDataset } from './types';

interface DhanCandleResponse {
  open?: number[];
  high?: number[];
  low?: number[];
  close?: number[];
  volume?: number[];
  timestamp?: number[];
  open_interest?: number[];
}

export interface LoadedTimeline {
  candles: SimCandle[];
  /** Config with securityId / lotSize / segment filled in. */
  config: SimulatorConfig;
}

const MANIFEST_FILE = path.join(PARQUET_DIR, '_manifest.json');

function readManifest(): Record<string, SimDataset> {
  if (!existsSync(MANIFEST_FILE)) return {};
  try {
    return JSON.parse(readFileSync(MANIFEST_FILE, 'utf8')) as Record<string, SimDataset>;
  } catch {
    return {};
  }
}

function recordManifest(entry: SimDataset): void {
  try {
    if (!existsSync(PARQUET_DIR)) mkdirSync(PARQUET_DIR, { recursive: true });
    const manifest = readManifest();
    manifest[entry.key] = entry;
    writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2), 'utf8');
  } catch (err) {
    console.warn('[Simulator] manifest write failed:', (err as Error).message);
  }
}

function buildDataset(config: SimulatorConfig, candles: SimCandle[], key: string): SimDataset {
  return {
    key,
    symbol: config.symbol,
    instrumentKind: config.instrumentKind,
    segment: config.segment,
    securityId: config.securityId,
    interval: config.interval,
    fromDate: config.fromDate,
    toDate: config.toDate,
    candles: candles.length,
    firstTime: candles[0]?.time ?? 0,
    lastTime: candles[candles.length - 1]?.time ?? 0,
    downloadedAt: new Date().toISOString(),
  };
}

/** All downloaded datasets, newest first — powers the data catalog UI. */
export function listDatasets(): SimDataset[] {
  return Object.values(readManifest()).sort((a, b) => b.downloadedAt.localeCompare(a.downloadedAt));
}

/**
 * Resolve security id + lot size for the configured instrument.
 * For options the caller must pre-resolve and pass `securityId` (strike/expiry
 * specific), so we only auto-resolve equity + stock futures here.
 */
async function resolveInstrument(
  config: SimulatorConfig,
): Promise<{ securityId: string; lotSize: number; segment: string }> {
  const { segment } = dhanInstrumentFor(config.instrumentKind);

  if (config.securityId) {
    return { securityId: config.securityId, lotSize: config.lotSize || 1, segment };
  }

  if (config.instrumentKind === 'EQUITY') {
    const eq = await resolveSymbol(config.symbol, 'NSE');
    if (!eq) throw new Error(`Equity not found in master contracts: ${config.symbol}`);
    return { securityId: eq.securityId, lotSize: 1, segment };
  }

  if (config.instrumentKind === 'FUTSTK') {
    const map = await batchResolveFutures([config.symbol], config.toDate || undefined);
    const fut = map.get(config.symbol);
    if (!fut) throw new Error(`Stock future not found for ${config.symbol}. Sync master contracts.`);
    return { securityId: fut.securityId, lotSize: fut.lotSize || 1, segment };
  }

  throw new Error(`Provide an explicit securityId for ${config.instrumentKind} (option) replay.`);
}

function normalize(raw: DhanCandleResponse): SimCandle[] {
  if (!raw.open || raw.open.length === 0) return [];
  const n = raw.open.length;
  const out: SimCandle[] = [];
  for (let i = 0; i < n; i++) {
    const open = raw.open[i];
    const high = raw.high?.[i] ?? open;
    const low = raw.low?.[i] ?? open;
    const close = raw.close?.[i] ?? open;
    if (![open, high, low, close].every(Number.isFinite)) continue;
    out.push({
      time: raw.timestamp?.[i] ?? 0,
      open,
      high,
      low,
      close,
      volume: raw.volume?.[i] ?? 0,
      oi: raw.open_interest?.[i] ?? 0,
    });
  }
  // Dhan returns ascending, but guarantee it.
  out.sort((a, b) => a.time - b.time);
  return out;
}

/** Load (and cache) the replay timeline for a config. */
export async function loadTimeline(config: SimulatorConfig): Promise<LoadedTimeline> {
  if (!config.symbol) throw new Error('symbol is required');
  if (!config.fromDate || !config.toDate) throw new Error('fromDate and toDate are required');

  const resolved = await resolveInstrument(config);
  const fullConfig: SimulatorConfig = {
    ...config,
    securityId: resolved.securityId,
    lotSize: resolved.lotSize,
    segment: resolved.segment,
  };

  const key = datasetKey(fullConfig);
  const cached = await readCandles(fullConfig);
  if (cached) {
    if (!readManifest()[key]) recordManifest(buildDataset(fullConfig, cached, key));
    return { candles: cached, config: fullConfig };
  }

  const { instrument } = dhanInstrumentFor(fullConfig.instrumentKind);
  const wantsOi = fullConfig.instrumentKind !== 'EQUITY';

  const requestCandles = () =>
    dhanRequest('/v2/charts/intraday', {
      securityId: fullConfig.securityId,
      exchangeSegment: fullConfig.segment,
      instrument,
      interval: fullConfig.interval,
      ...(wantsOi ? { oi: true } : {}),
      fromDate: fullConfig.fromDate,
      toDate: fullConfig.toDate,
    }) as Promise<DhanCandleResponse>;

  let raw: DhanCandleResponse;
  try {
    raw = await requestCandles();
  } catch (err) {
    // A token minted *before* a Data-API subscription was activated keeps
    // getting DH-902 / 401 / "status 451 / not subscribed". The cached token is
    // stale, not the entitlement — clear it, mint a fresh one, and retry once.
    const msg = (err as Error).message;
    if (/DH-90[26]|status 451|\b40[01]\b|unauthor|not subscribed|invalid[_ ]?access|invalid[_ ]?token/i.test(msg)) {
      clearCachedToken();
      raw = await requestCandles();
    } else {
      throw err;
    }
  }

  const candles = normalize(raw);
  if (candles.length === 0) {
    throw new Error(
      `No candles returned for ${fullConfig.symbol} ${fullConfig.fromDate}→${fullConfig.toDate}. ` +
        'Check the date range is a past trading window and master contracts are synced.',
    );
  }

  await writeCandles(fullConfig, candles);
  recordManifest(buildDataset(fullConfig, candles, key));
  return { candles, config: fullConfig };
}
