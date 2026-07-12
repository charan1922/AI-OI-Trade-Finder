/**
 * App-wide feature toggles — runtime on/off switches persisted in SQLite so they
 * can be flipped from the /config page without a code change or redeploy.
 *
 * The constants in the various config.ts files remain the DEFAULTS: they seed
 * this table and are the fallback when the DB is unreachable. A stored row
 * overrides the default for the live app. Add a new switch by appending to
 * TOGGLE_DEFS and reading it with getToggle() where it's used.
 *
 * Follows the repo's derived-table convention (see lib/signals/oi-intraday.ts):
 * raw CREATE TABLE IF NOT EXISTS via Prisma, mirrored by the FeatureToggle model
 * in schema.prisma so `db push` keeps it. The table is created lazily on first
 * use — no migration required.
 */
import { prisma } from '@/lib/db';
import {
  EXCLUDE_EXTENDED,
  MAX_PICKS,
  SCAN_FULL_UNIVERSE,
  SCAN_OUTSIDE_WINDOW,
  USE_BREAKOUT_BYPASS,
  USE_EXTENDED_TREND_BYPASS,
  USE_TF_BREAKOUT_GATE,
} from '@/lib/trade-suggest/config';

export interface ToggleDef {
  key: string;
  label: string;
  /** Plain-English explanation shown in the config-page info tooltip. */
  description: string;
  category: string;
  default: boolean;
}

/** The registry of every toggle the app exposes. This is the allowlist — a
 *  write to any key not listed here is rejected. */
export const TOGGLE_DEFS: ToggleDef[] = [
  {
    key: 'USE_BREAKOUT_BYPASS',
    label: 'Breakout bypass',
    category: 'Trade Suggest',
    default: USE_BREAKOUT_BYPASS,
    description:
      'Normally a stock is only suggested when open interest (OI) shows big players building positions in it. But some fast movers break out on PRICE first and the OI shows up only later — the normal rule throws those away. ON: a stock with no OI evidence yet can still qualify, but only if price has clearly broken out of its opening range in the trade direction, the trend tools (Supertrend / VWAP) agree, and its R-Factor is strong. OFF (default): OI evidence is always required. Trade-off: ON finds early breakout winners but with weaker proof behind them — keep OFF until the daily benchmark shows it picks more winners than junk.',
  },
  {
    key: 'USE_TF_BREAKOUT_GATE',
    label: 'TF breakout gate',
    category: 'Trade Suggest',
    default: USE_TF_BREAKOUT_GATE,
    description:
      'An extra strictness filter on top of all the normal rules. ON: a stock is only suggested when its Breakout badge (the /live column) says the breakout is CONFIRMED in the same direction as the trade — meaning the morning low (for buys) or morning high (for sells) held all day, AND price has already cleared at least one important level such as the opening-range high, yesterday’s high, or a multi-day high. Stocks whose base is still forming, that look like a fakeout, or that have no candle data yet are all dropped (the scan shows how many). OFF (default): the badge is shown as information only and never blocks a suggestion. Keep OFF for now — backtesting proved the breakout signal points the right way at the right time, but has NOT yet proven that filtering on it produces better trades.',
  },
  {
    key: 'SCAN_FULL_UNIVERSE',
    label: 'Scan the full F&O universe',
    category: 'Trade Suggest',
    default: SCAN_FULL_UNIVERSE,
    description:
      'How many stocks the scanner even looks at. OFF (default): only the stocks already on NSE’s movers lists — OI spurts, top gainers, top losers, most active — the same names the /nse/movers page shows (typically 50–80). ON: it checks all ~166 tradeable F&O stocks instead. Every quality rule still applies either way — this only widens who gets LOOKED at, not who qualifies. ON also records intraday data for the whole universe, which the nightly replay benchmark needs.',
  },
  {
    key: 'SCAN_OUTSIDE_WINDOW',
    label: 'Scan outside the 09:40–11:00 window',
    category: 'Trade Suggest',
    default: SCAN_OUTSIDE_WINDOW,
    description:
      'When the scanner is allowed to suggest trades. OFF (safe default): only during the proven morning window, 09:40–11:00 — the whole strategy was built and tested on morning entries, which is when the best moves start. ON: it will suggest trades any time the market is open. Be aware: out-of-window picks get saved and mixed into the daily scorecard, so they affect your stats. Turn ON only when you deliberately want all-day scanning.',
  },
  {
    key: 'EXCLUDE_EXTENDED',
    label: 'Skip already-extended movers',
    category: 'Trade Suggest',
    default: EXCLUDE_EXTENDED,
    description:
      'ON (safe default): skips any stock that has already moved 3% or more from today’s open — by the time you’d enter, the move has mostly happened, and chasing late has been a losing bet in our testing (0 of 5 chased picks worked). OFF: the scanner is allowed to suggest those big early movers too. Keep ON unless you deliberately want to chase.',
  },
  {
    key: 'USE_EXTENDED_TREND_BYPASS',
    label: 'Extended-trend bypass',
    category: 'Trade Suggest',
    default: USE_EXTENDED_TREND_BYPASS,
    description:
      'Works WITH “Skip already-extended movers”. That rule throws away every stock already 3%+ from the open — but on a genuine TREND day, a stock can keep running much further all day. ON: such a stock is let back in, and ONLY while it is still pushing to fresh highs/lows, holding the right side of VWAP, and its Supertrend agrees with the direction — a spike that has stalled or lost VWAP stays excluded. Let-back-in stocks still carry the “extended” score penalty, so they rank cautiously. OFF (default): every 3%+ mover stays excluded, full stop. Experimental — turn ON only to gather evidence on the Trade Log before trusting it.',
  },
];

/** Numeric runtime settings — same storage table (INTEGER value), rendered as
 *  steppers on /config instead of switches. */
export interface NumberDef {
  key: string;
  label: string;
  description: string;
  category: string;
  default: number;
  min: number;
  max: number;
}

export const NUMBER_DEFS: NumberDef[] = [
  {
    key: 'MAX_PICKS',
    label: 'Max picks per scan',
    category: 'Trade Suggest',
    default: MAX_PICKS,
    min: 1,
    max: 10,
    description:
      'How many qualified stocks a scan may suggest at most. The quality gates are the real constraint — quiet days produce 1–2 regardless. With a ₹50–60k account only the top 1–3 are actionable; anything beyond that is a watchlist.',
  },
];

const byKey = new Map(TOGGLE_DEFS.map((d) => [d.key, d]));
const numberByKey = new Map(NUMBER_DEFS.map((d) => [d.key, d]));
let tableReady = false;

async function ensureTable(): Promise<void> {
  if (tableReady) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS feature_toggles (
      key       TEXT PRIMARY KEY,
      value     INTEGER NOT NULL,
      updatedAt TEXT NOT NULL
    )
  `);
  tableReady = true;
}

/** One toggle's definition plus its current stored state, for the API/UI. */
export interface ToggleState extends ToggleDef {
  /** Effective value: the stored override if present, else the default. */
  value: boolean;
  /** When it was last changed from the default, or null if never. */
  updatedAt: string | null;
}

/** Every toggle with its effective (stored-or-default) value. */
export async function getAllToggles(): Promise<ToggleState[]> {
  await ensureTable();
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT key, value, updatedAt FROM feature_toggles`,
  )) as { key: string; value: number; updatedAt: string }[];
  const stored = new Map(rows.map((r) => [r.key, r]));
  return TOGGLE_DEFS.map((d) => {
    const row = stored.get(d.key);
    return { ...d, value: row ? row.value === 1 : d.default, updatedAt: row?.updatedAt ?? null };
  });
}

/**
 * Effective value of one toggle (stored override, else `fallback`). Best-effort:
 * any DB hiccup returns `fallback` so a toggle read can never break a scan.
 */
export async function getToggle(key: string, fallback: boolean): Promise<boolean> {
  try {
    await ensureTable();
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT value FROM feature_toggles WHERE key = ?`,
      key,
    )) as { value: number }[];
    return rows.length > 0 ? rows[0].value === 1 : fallback;
  } catch {
    return fallback;
  }
}

/** Persist a toggle. Unknown keys are rejected (the registry is the allowlist). */
export async function setToggle(key: string, value: boolean): Promise<void> {
  if (!byKey.has(key)) throw new Error(`unknown toggle: ${key}`);
  await ensureTable();
  await prisma.$executeRawUnsafe(
    `INSERT INTO feature_toggles (key, value, updatedAt) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
    key,
    value ? 1 : 0,
    new Date().toISOString(),
  );
}

/** One numeric setting's definition plus its current stored state. */
export interface NumberState extends NumberDef {
  value: number;
  updatedAt: string | null;
}

/** Every numeric setting with its effective (stored-or-default) value. */
export async function getAllNumberSettings(): Promise<NumberState[]> {
  await ensureTable();
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT key, value, updatedAt FROM feature_toggles`,
  )) as { key: string; value: number; updatedAt: string }[];
  const stored = new Map(rows.map((r) => [r.key, r]));
  return NUMBER_DEFS.map((d) => {
    const row = stored.get(d.key);
    const value = row ? Math.min(d.max, Math.max(d.min, Math.round(row.value))) : d.default;
    return { ...d, value, updatedAt: row?.updatedAt ?? null };
  });
}

/** Effective value of one numeric setting, clamped to its [min,max]. Best-effort:
 *  any DB hiccup returns `fallback` so a read can never break a scan. */
export async function getNumberSetting(key: string, fallback: number): Promise<number> {
  const def = numberByKey.get(key);
  try {
    await ensureTable();
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT value FROM feature_toggles WHERE key = ?`,
      key,
    )) as { value: number }[];
    if (rows.length === 0) return fallback;
    const v = Math.round(rows[0].value);
    return def ? Math.min(def.max, Math.max(def.min, v)) : v;
  } catch {
    return fallback;
  }
}

/** Persist a numeric setting. Unknown keys / out-of-range values are rejected. */
export async function setNumberSetting(key: string, value: number): Promise<void> {
  const def = numberByKey.get(key);
  if (!def) throw new Error(`unknown numeric setting: ${key}`);
  if (!Number.isFinite(value) || Math.round(value) < def.min || Math.round(value) > def.max) {
    throw new Error(`${key} must be an integer between ${def.min} and ${def.max}`);
  }
  await ensureTable();
  await prisma.$executeRawUnsafe(
    `INSERT INTO feature_toggles (key, value, updatedAt) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
    key,
    Math.round(value),
    new Date().toISOString(),
  );
}
