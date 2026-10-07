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
  return flattenBaskets((payload as { payload?: { data?: unknown } } | null)?.payload?.data);
}

/**
 * TradeFinder's `sector_scope` feed (captured since 2026-10-08) carries the SAME
 * basket → symbol → param_N board as `all_sector`, one level deeper:
 * `payload.data.all_sector.<basket>.<symbol>`. Same param meanings — checked
 * against a real capture: ASHOKLEY 149.4 / 153.7 → (149.4−153.7)/153.7 = −2.80%
 * = param_2, and CANBK param_3 3.64 equals its R-Factor on the same day's board.
 */
export function parseSectorScope(payload: unknown): TfStockRow[] {
  const data = (payload as { payload?: { data?: { all_sector?: unknown } } } | null)?.payload?.data;
  return flattenBaskets(data?.all_sector);
}

function flattenBaskets(data: unknown): TfStockRow[] {
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

export interface TfPulseList {
  /** TradeFinder's own list name, e.g. 'top_gainers', 'breakout_beacon'. */
  name: string;
  rows: { symbol: string; params: (number | string | null)[] }[];
}

/**
 * TradeFinder's `market_pulse` feed: `payload.data` is a map of named lists
 * (top_gainers, intraday_boost, breakout_beacon, …), each an array of
 * `{ Symbol, param_0..param_3 }`. The params are passed through RAW — their
 * meaning differs by list and is only partly confirmed (see app/tf/page.tsx for
 * which columns are labelled and why). Never interpret them here.
 */
export function parseMarketPulse(payload: unknown): TfPulseList[] {
  const data = (payload as { payload?: { data?: unknown } } | null)?.payload?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const lists: TfPulseList[] = [];
  for (const [name, list] of Object.entries(data as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const rows = list
      .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && typeof r.Symbol === 'string')
      .map((r) => ({
        symbol: r.Symbol as string,
        params: [r.param_0, r.param_1, r.param_2, r.param_3].map((v) =>
          typeof v === 'number' || typeof v === 'string' ? v : null
        ),
      }));
    lists.push({ name, rows });
  }
  return lists;
}

/**
 * Whether a market_pulse list's first three params are LTP, prev close and %
 * change — MEASURED on the capture itself, never assumed: every row must
 * satisfy (p0 − p1) / p1 × 100 ≈ p2. On the 2026-10-07 capture this held for
 * every row of six lists (top_gainers, top_losers, intraday_boost,
 * high_powered_stocks, top_level_stocks, low_level_stocks) and failed for
 * breakout_beacon, whose params are something else (p2 is 'BULL'/'BEAR').
 * param_3 is never labelled: it differs by list and is not confirmed.
 */
export function isPriceList(list: TfPulseList): boolean {
  if (list.rows.length === 0) return false;
  return list.rows.every(({ params: [p0, p1, p2] }) => {
    if (typeof p0 !== 'number' || typeof p1 !== 'number' || typeof p2 !== 'number' || p1 === 0) return false;
    return Math.abs(((p0 - p1) / p1) * 100 - p2) < 0.02;
  });
}

/** `daily-index` is already a flat array: [{ Symbol, param_3 }, ...]. */
export function parseDailyIndex(payload: unknown): { name: string; value: number | null }[] {
  const data = (payload as { payload?: { data?: unknown } } | null)?.payload?.data;
  if (!Array.isArray(data)) return [];
  return data
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map((r) => ({ name: String(r.Symbol ?? r.symbol ?? '—'), value: num(r.param_3) }));
}

/** The per-stock board from ANY stored board feed (see TF_BOARD_ENDPOINTS):
 *  each nests it differently, and reading one with another's parser yields
 *  rows full of nulls rather than an error. */
export function parseTfBoard(endpoint: string, payload: unknown): TfStockRow[] {
  if (endpoint === 'sector_scope') return parseSectorScope(payload);
  if (endpoint === 'rfactor_data') return parseRFactorData(payload);
  return parseAllSector(payload);
}

/** Per-sector values from ANY stored index feed (see TF_INDEX_ENDPOINTS).
 *  sector_scope embeds the old `daily-index` array at `payload.data['daily-index']`
 *  — the same `{ Symbol, param_3 }` rows (checked on the 2026-10-08 capture). */
export function parseTfIndices(endpoint: string, payload: unknown): { name: string; value: number | null }[] {
  if (endpoint === 'sector_scope') {
    const data = (payload as { payload?: { data?: Record<string, unknown> } } | null)?.payload?.data;
    return parseDailyIndex({ payload: { data: data?.['daily-index'] } });
  }
  return parseDailyIndex(payload);
}
