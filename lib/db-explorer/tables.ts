/**
 * DB Explorer — server-side table registry and injection-safe access helpers.
 *
 * A generic, READ-ONLY database browser (page /db-explorer). Tables are
 * auto-discovered from sqlite_master so new runtime tables show up without code
 * changes, minus a DENYLIST of sensitive tables that must never be exposed.
 *
 * Security model (this is the whole boundary — respect it):
 *   - The only tables a request can touch are those returned by
 *     listBrowsableTables(): present in sqlite_master AND not denylisted.
 *   - SQLite identifiers (table/column names) CANNOT be bound as parameters, so
 *     every identifier that reaches a query is first validated against the live
 *     schema (assertBrowsableTable / column set) and then double-quoted. Never
 *     interpolate a raw client string as an identifier without that check.
 *   - Row VALUES are always passed as positional ($queryRawUnsafe) parameters.
 */
import { prisma } from '@/lib/db';

/**
 * Sensitive tables — never listed, never queryable through the explorer.
 * User rule: cover ALL tables EXCEPT sensitive ones. The auto-trade execution
 * + risk-config tables hold personal order flow, broker order IDs, the AI
 * decision audit, and the kill-switch/caps — kept out of the read-only browser.
 * Add a name here to hide a future sensitive table.
 */
export const DENYLISTED_TABLES: ReadonlySet<string> = new Set([
  'auto_trades', // personal trade lifecycles + realized P&L
  'auto_orders', // broker order IDs / idempotency keys
  'auto_decisions', // AI decision audit trail
  'auto_trade_settings', // mode / broker / kill-switch / risk caps
]);

/** Human labels + one-line descriptions for known tables. Unknown/new tables
 *  fall back to a prettified name and an empty description. */
export const TABLE_META: Record<string, { label: string; description: string }> = {
  master_contracts: {
    label: 'Master Contracts',
    description: 'Dhan instrument mappings (symbol → securityId), synced from the daily master CSV.',
  },
  bhavcopy_days: {
    label: 'Bhavcopy (Daily)',
    description: 'NSE daily equity + F&O data, one row per stock per trading day.',
  },
  bhavcopy_fut_expiry: {
    label: 'Bhavcopy Futures (per expiry)',
    description: 'Per-expiry futures volume/OI split behind each bhavcopy day.',
  },
  bhavcopy_option_expiry: {
    label: 'Bhavcopy Options (per expiry)',
    description: 'Per-expiry options volume/OI split behind each bhavcopy day.',
  },
  bhavcopy_option_strike: {
    label: 'Bhavcopy Options (per strike)',
    description: 'Per-strike CE/PE option data from the bhavcopy F&O file.',
  },
  fno_expiry_calendar: {
    label: 'F&O Expiry Calendar',
    description: 'Published expiry dates for the F&O universe.',
  },
  fno_stocks: {
    label: 'F&O Stocks',
    description: 'NSE F&O universe with lot sizes, sector, and trade band.',
  },
  trade_band_ranges: {
    label: 'Trade Band Ranges',
    description: 'Lot-size ranges defining the core / extended / avoid trade bands.',
  },
  band_overrides: {
    label: 'Band Overrides',
    description: 'Manual, hand-curated trade-band overrides for specific symbols.',
  },
  trade_contracts: {
    label: 'Trade Contracts',
    description: 'Dhan contract IDs preserved per backtest trade.',
  },
  tf_snapshots: {
    label: 'TradeFinder Snapshots',
    description: 'Captured TradeFinder R-Factor values per date/symbol (ground truth).',
  },
  oi_intraday: {
    label: 'OI Intraday',
    description: 'Intraday futures-OI snapshots powering the Live Urgency time-series.',
  },
  feature_toggles: {
    label: 'Feature Toggles',
    description: 'App-wide feature flags flipped from the /config page.',
  },
  fyers_candles: {
    label: 'Fyers Candles',
    description: 'Fyers live 5-min equity + futures candles (newest 20 recorded sessions).',
  },
  trade_suggestions: {
    label: 'Trade Suggestions',
    description: 'Persisted /trade-suggest calls with same-day outcomes.',
  },
  prompt_versions: {
    label: 'Prompt Versions',
    description: 'AI prompt version history (read-only audit).',
  },
  trade_commentary: {
    label: 'Trade Commentary',
    description: 'AI-generated end-of-day trade commentary rows.',
  },
  live_urgency_eod: {
    label: 'Live Urgency (EOD)',
    description: 'Permanent post-market copy of the Live Urgency board.',
  },
  market_holidays: {
    label: 'Market Holidays',
    description: 'NSE trading-holiday calendar.',
  },
  backtest_equity: {
    label: 'Backtest Equity',
    description: '5-min equity candles downloaded for backtesting.',
  },
  backtest_futures: {
    label: 'Backtest Futures',
    description: '5-min futures candles (+ OI) downloaded for backtesting.',
  },
  backtest_options: {
    label: 'Backtest Options',
    description: '5-min option candles downloaded for backtesting.',
  },
};

/** Valid SQLite identifier — first line of defence before a name is quoted. */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type ColumnInfo = {
  name: string;
  type: string;
  pk: boolean;
  notnull: boolean;
};
export type TableInfo = {
  name: string;
  label: string;
  description: string;
  rowCount: number;
  columnCount: number;
};

function prettify(name: string): string {
  return name
    .split('_')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

function metaFor(name: string): { label: string; description: string } {
  return TABLE_META[name] ?? { label: prettify(name), description: '' };
}

/** Raw table names from sqlite_master, excluding internal + denylisted tables. */
async function browsableTableNames(): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<{ name: string }[]>(
    `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
         AND name NOT LIKE '_prisma%'
       ORDER BY name ASC`
  );
  return rows.map((r) => r.name).filter((n) => IDENT_RE.test(n) && !DENYLISTED_TABLES.has(n));
}

/** Throw unless `table` is a real, non-sensitive, browsable table. Returns the
 *  validated (safe-to-quote) name. */
export async function assertBrowsableTable(table: string): Promise<string> {
  if (!IDENT_RE.test(table) || DENYLISTED_TABLES.has(table)) {
    throw new Error('Table not available');
  }
  const names = await browsableTableNames();
  if (!names.includes(table)) throw new Error('Table not available');
  return table;
}

/** Column metadata for a validated table (via PRAGMA table_info). */
export async function getColumns(validTable: string): Promise<ColumnInfo[]> {
  const rows = await prisma.$queryRawUnsafe<{ name: string; type: string; notnull: number; pk: number }[]>(
    `PRAGMA table_info("${validTable}")`
  );
  return rows.map((r) => ({
    name: r.name,
    type: r.type || '',
    pk: Number(r.pk) > 0,
    notnull: Number(r.notnull) > 0,
  }));
}

/** The index: every browsable table with its row + column counts and metadata. */
export async function listBrowsableTables(): Promise<TableInfo[]> {
  const names = await browsableTableNames();
  const out: TableInfo[] = [];
  for (const name of names) {
    const countRows = await prisma.$queryRawUnsafe<{ c: bigint | number }[]>(`SELECT COUNT(*) AS c FROM "${name}"`);
    const cols = await prisma.$queryRawUnsafe<unknown[]>(`PRAGMA table_info("${name}")`);
    const { label, description } = metaFor(name);
    out.push({
      name,
      label,
      description,
      rowCount: Number(countRows[0]?.c ?? 0),
      columnCount: cols.length,
    });
  }
  return out;
}
