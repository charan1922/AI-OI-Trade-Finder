import { requestFyersData } from '@/lib/fyers/client';
import { batchResolveFutures, resolveOptionSecurity } from '@/lib/historify/master-contracts';
import { checkpoint, execute } from './backtest-store';

type Result = { rows: number; error?: string; securityId?: string; expiry?: string; lotSize?: number; via?: string };
type Candle = { ts: number; open: number; high: number; low: number; close: number; volume: number; oi: number };

const esc = (value: string) => value.replace(/'/g, "''");
const istDate = (seconds: number) => new Date((seconds + 19_800) * 1000).toISOString().slice(0, 10);

function candles(response: Record<string, unknown>): Candle[] {
  const raw = response.candles;
  if (!Array.isArray(raw)) throw new Error('Fyers history response has no candles array');
  return raw.flatMap((item) => {
    if (!Array.isArray(item) || item.length < 6) return [];
    const values = item.map(Number);
    if (values.slice(0, 6).some((value) => !Number.isFinite(value))) return [];
    return [{ ts: values[0], open: values[1], high: values[2], low: values[3], close: values[4], volume: values[5], oi: Number.isFinite(values[6]) ? values[6] : 0 }];
  });
}

async function history(symbol: string, fromDate: string, toDate: string, oi: boolean) {
  return candles(await requestFyersData('history', {
    symbol, resolution: '5', date_format: '1', range_from: fromDate, range_to: toDate,
    cont_flag: '1', ...(oi ? { oi_flag: '1' } : {}),
  }, Date.now() + 60_000));
}

async function insertEquity(symbol: string, rows: Candle[]) {
  const values = rows.map((c) => `('${esc(symbol)}','${istDate(c.ts)}',${c.ts},${c.open},${c.high},${c.low},${c.close},${c.volume})`);
  for (let i = 0; i < values.length; i += 500) await execute(`INSERT OR IGNORE INTO backtest_equity VALUES ${values.slice(i, i + 500).join(',')}`);
}
async function insertFuture(symbol: string, rows: Candle[]) {
  const values = rows.map((c) => `('${esc(symbol)}','${istDate(c.ts)}',${c.ts},${c.open},${c.high},${c.low},${c.close},${c.volume},${c.oi})`);
  for (let i = 0; i < values.length; i += 500) await execute(`INSERT OR IGNORE INTO backtest_futures VALUES ${values.slice(i, i + 500).join(',')}`);
}
async function insertOption(symbol: string, optionType: 'CE' | 'PE', strike: number, rows: Candle[]) {
  const values = rows.map((c) => `('${esc(symbol)}','${istDate(c.ts)}',${c.ts},'${optionType}',${strike},${c.open},${c.high},${c.low},${c.close},${c.volume},${c.oi},0,0)`);
  for (let i = 0; i < values.length; i += 500) await execute(`INSERT OR IGNORE INTO backtest_options VALUES ${values.slice(i, i + 500).join(',')}`);
}

export async function downloadEquity5min(symbol: string, fromDate: string, toDate: string, opts?: { securityId?: string }): Promise<Result> {
  try {
    const fyersSymbol = `NSE:${symbol}-EQ`;
    const rows = await history(fyersSymbol, fromDate, toDate, false);
    if (!rows.length) return { rows: 0, error: `Fyers returned no equity data for ${symbol}` };
    await insertEquity(symbol, rows); await checkpoint();
    return { rows: rows.length, securityId: opts?.securityId ?? fyersSymbol };
  } catch (error) { return { rows: 0, error: (error as Error).message }; }
}

export async function downloadFutures5min(symbol: string, fromDate: string, toDate: string, _opts?: { securityId?: string; expiry?: string; lotSize?: number }): Promise<Result> {
  void _opts;
  try {
    const resolved = (await batchResolveFutures([symbol], toDate)).get(symbol);
    if (!resolved) return { rows: 0, error: `Fyers futures contract not found: ${symbol}` };
    // Fyers master stores the API symbol in master_contracts.symbol.
    const contract = await import('@/lib/db').then(({ prisma }) => prisma.masterContract.findFirst({ where: { securityId: resolved.securityId, segment: 'NSE_FNO' }, select: { symbol: true } }));
    if (!contract?.symbol.startsWith('NSE:')) return { rows: 0, error: `Invalid Fyers futures symbol for ${symbol}` };
    const rows = await history(contract.symbol, fromDate, toDate, true);
    if (!rows.length) return { rows: 0, error: `Fyers returned no futures data for ${symbol}` };
    await insertFuture(symbol, rows); await checkpoint();
    return { rows: rows.length, securityId: resolved.securityId, expiry: resolved.expiryDate, lotSize: resolved.lotSize };
  } catch (error) { return { rows: 0, error: (error as Error).message }; }
}

async function expiredOptionSymbol(symbol: string, optionType: 'CE' | 'PE', strike: number, fromDate: string, toDate: string) {
  const underlying = `NSE:${symbol}-EQ`;
  const limit = new Date(`${toDate}T00:00:00Z`); limit.setUTCDate(limit.getUTCDate() + 45);
  const expiryResponse = await requestFyersData('history/fno/expired/expiry-dates', {
    symbol: underlying, range_from: fromDate, range_to: limit.toISOString().slice(0, 10), date_format: '1',
  }, Date.now() + 60_000);
  const dates = ((expiryResponse.data as Record<string, unknown> | undefined)?.expiry_dates as Record<string, unknown> | undefined)?.options;
  if (!Array.isArray(dates)) return null;
  for (const expiry of dates.map(String).sort()) {
    if (expiry < toDate) continue;
    const response = await requestFyersData('history/fno/expired/underlying-symbols', { symbol: underlying, expiry_date: expiry }, Date.now() + 60_000);
    const options = ((response.data as Record<string, unknown> | undefined)?.contracts as Record<string, unknown> | undefined)?.options;
    if (!Array.isArray(options)) continue;
    const match = options.map((item) => typeof item === 'string' ? item : String((item as Record<string, unknown>).symbol ?? '')).find((value) => value.endsWith(`${strike}${optionType}`));
    if (match) return { symbol: match, expiry };
  }
  return null;
}

export async function downloadOption5min(symbol: string, optionType: 'CE' | 'PE', strike: number, fromDate: string, toDate: string, _opts?: { spotPrice?: number; securityId?: string }): Promise<Result> {
  void _opts;
  try {
    const active = await resolveOptionSecurity(symbol, strike, optionType, 0, toDate).catch(() => null);
    let fyersSymbol = active?.symbol;
    let expiry = active?.expiry;
    let via = 'fyers-history';
    if (!fyersSymbol?.startsWith('NSE:')) {
      const expired = await expiredOptionSymbol(symbol, optionType, strike, fromDate, toDate);
      if (!expired) return { rows: 0, error: `Fyers expired option not found for ${symbol} ${strike}${optionType}` };
      fyersSymbol = expired.symbol; expiry = expired.expiry; via = 'fyers-expired';
    }
    const response = via === 'fyers-expired'
      ? await requestFyersData('history/fno/expired/historical-data', { symbol: fyersSymbol, resolution: '5', date_format: '1', range_from: fromDate, range_to: toDate, include_greeks: '0', include_oi: '1' }, Date.now() + 60_000)
      : await requestFyersData('history', { symbol: fyersSymbol, resolution: '5', date_format: '1', range_from: fromDate, range_to: toDate, cont_flag: '0', oi_flag: '1' }, Date.now() + 60_000);
    const rows = candles(response);
    if (!rows.length) return { rows: 0, error: `Fyers returned no option data for ${fyersSymbol}` };
    await insertOption(symbol, optionType, strike, rows); await checkpoint();
    return { rows: rows.length, securityId: active?.securityId ?? fyersSymbol, expiry, via };
  } catch (error) { return { rows: 0, error: (error as Error).message }; }
}
