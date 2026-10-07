/**
 * TradeFinder `all_sector` payload parser — the ONE place that knows its shape.
 *
 * Confirmed against a real captured payload (2026-08-06). The response is
 * keyed by BASKET, then by symbol — not flat by symbol:
 *
 *   payload.data = {
 *     "NIFTY 50_r_factor":   { "ADANIENT": {...}, "ADANIPORTS": {...}, ... },
 *     "NIFTY AUTO_r_factor": { "ASHOKLEY": {...}, ... },
 *     ...
 *   }
 *
 * and each leaf uses positional param_N names:
 *
 *   { Symbol: "ADANIENT", param_0: 3026, param_1: 3050, param_2: -0.79, param_3: 0.3705 }
 *      param_0 = LTP            param_1 = previous close
 *      param_2 = % change       param_3 = R-Factor
 *
 * Verified against the same day's rendered page: ADANIENT showed Pre C 3050
 * and the R-Factor column matched param_3 (NOT param_2 — an earlier defensive
 * guess had those swapped, which would have shown % change as the R-Factor).
 *
 * A symbol appears under every basket it belongs to (65 of 210 are in more than
 * one) with identical values, so flattening de-duplicates by symbol.
 */

export interface TfStockRow {
  symbol: string;
  /** Baskets this symbol appeared under, e.g. ['NIFTY 50', 'NIFTY AUTO']. */
  baskets: string[];
  ltp: number | null;
  previousClose: number | null;
  pctChange: number | null;
  rFactor: number | null;
}

const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};

/** Strip TradeFinder's "_r_factor" suffix off a basket key. */
export const basketLabel = (key: string): string => key.replace(/_r_factor$/, '');

/**
 * Flatten a raw `all_sector` response into one row per symbol. Returns [] for
 * anything unparseable — never invents a value, so a schema change surfaces as
 * "no rows" rather than silently wrong numbers.
 */
export function parseAllSector(payload: unknown): TfStockRow[] {
  const data = (payload as { payload?: { data?: unknown } } | null)?.payload?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];

  const bySymbol = new Map<string, TfStockRow>();
  for (const [basketKey, members] of Object.entries(data as Record<string, unknown>)) {
    if (!members || typeof members !== 'object' || Array.isArray(members)) continue;
    const label = basketLabel(basketKey);
    for (const [symbol, raw] of Object.entries(members as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object') continue;
      const o = raw as Record<string, unknown>;
      const existing = bySymbol.get(symbol);
      if (existing) {
        if (!existing.baskets.includes(label)) existing.baskets.push(label);
        continue;
      }
      bySymbol.set(symbol, {
        symbol: typeof o.Symbol === 'string' ? o.Symbol : symbol,
        baskets: [label],
        ltp: num(o.param_0),
        previousClose: num(o.param_1),
        pctChange: num(o.param_2),
        rFactor: num(o.param_3),
      });
    }
  }
  return [...bySymbol.values()];
}

/** Parse TradeFinder's current Market Pulse R-Factor response. The endpoint
 * has appeared both as a nested basket map and as nested/flat symbol records,
 * so traversal is shape-tolerant while field interpretation stays explicit. */
export function parseRFactorData(payload: unknown): TfStockRow[] {
  const legacy = parseAllSector(payload);
  if (legacy.length > 0) return legacy;

  const root =
    (payload as { payload?: { data?: unknown } } | null)?.payload?.data ??
    (payload as { data?: unknown } | null)?.data;
  if (root == null) return [];

  const bySymbol = new Map<string, TfStockRow>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 6 || value == null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const row = value as Record<string, unknown>;
    const rawSymbol = row.Symbol ?? row.symbol ?? row.trading_symbol ?? row.tradingSymbol;
    const explicitR = row.r_factor ?? row.rFactor ?? row.rfactor ?? row.RFactor;
    const positionalR = rawSymbol != null ? row.param_3 : null;
    const rFactor = num(explicitR ?? positionalR);
    if (typeof rawSymbol === 'string' && rawSymbol.trim() !== '' && rFactor != null) {
      const symbol = rawSymbol.trim().toUpperCase();
      bySymbol.set(symbol, {
        symbol,
        baskets: [],
        ltp: num(row.ltp ?? row.LTP ?? row.param_0),
        previousClose: num(row.previousClose ?? row.prev_close ?? row.param_1),
        pctChange: num(row.pctChange ?? row.change_percent ?? row.param_2),
        rFactor,
      });
      return;
    }
    for (const child of Object.values(row)) visit(child, depth + 1);
  };
  visit(root, 0);
  return [...bySymbol.values()];
}

/** `daily-index` is already a flat array: [{ Symbol, param_3 }, ...]. */
export function parseDailyIndex(payload: unknown): { name: string; value: number | null }[] {
  const data = (payload as { payload?: { data?: unknown } } | null)?.payload?.data;
  if (!Array.isArray(data)) return [];
  return data
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map((r) => ({ name: String(r.Symbol ?? r.symbol ?? '—'), value: num(r.param_3) }));
}
