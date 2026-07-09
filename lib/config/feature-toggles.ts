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
      'Lets a stock qualify on a clean price breakout even when it has no open-interest (OI) build yet. It catches fast breakout winners — like NAUKRI or ADANIENSOL — that the normal OI rule throws away. Experimental: so far it has only been checked on one day, so keep it OFF until the daily benchmark proves it earns its place.',
  },
  {
    key: 'SCAN_FULL_UNIVERSE',
    label: 'Scan the full F&O universe',
    category: 'Trade Suggest',
    default: SCAN_FULL_UNIVERSE,
    description:
      'OFF (default): scans only the stocks on NSE’s movers lists — OI spurts, gainers, losers, most active — the same names the /nse/movers page shows (typically 50–80 after overlap). ON: checks all ~166 tradeable F&O names instead. Every quality gate still applies — this only widens who gets LOOKED at. ON also records intraday data for the whole universe, which the nightly replay benchmark needs.',
  },
  {
    key: 'SCAN_OUTSIDE_WINDOW',
    label: 'Scan outside the 09:40–11:00 window',
    category: 'Trade Suggest',
    default: SCAN_OUTSIDE_WINDOW,
    description:
      'Lets the scanner produce suggestions any time the market is open, not just the proven 09:40–11:00 morning window. OFF is the safe default: the strategy was built and validated on morning entries (TradeFinder’s real trades cluster 10:00–10:40), and out-of-window picks get stored and mixed into the daily scorecard stats. Turn ON only when you deliberately want all-day scanning.',
  },
  {
    key: 'EXCLUDE_EXTENDED',
    label: 'Skip already-extended movers',
    category: 'Trade Suggest',
    default: EXCLUDE_EXTENDED,
    description:
      'Refuses to suggest a stock that has already moved 3% or more from the day’s open. Chasing those late has been a losing bet in testing (0 of 5 worked). ON is the safe default; turning it OFF lets the scanner chase big early movers.',
  },
  {
    key: 'USE_EXTENDED_TREND_BYPASS',
    label: 'Extended-trend bypass',
    category: 'Trade Suggest',
    default: USE_EXTENDED_TREND_BYPASS,
    description:
      'Works WITH “Skip already-extended movers”: normally a stock already 3%+ from the open is thrown away (chasing spent spikes lost 5 of 5). This lets a genuine TREND-day back in — but ONLY when it is still breaking to new highs/lows, holding the right side of VWAP, and its Supertrend agrees. It would have caught the gap-and-go runner KALYANKJIL (+4.5%→+17.5% on 2026-07-09) while still rejecting fades that lost VWAP. Bypassed names keep the extended score penalty, so they rank cautiously. Experimental: OFF by default — turn ON to accumulate evidence on the Trade Log before trusting it live.',
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
