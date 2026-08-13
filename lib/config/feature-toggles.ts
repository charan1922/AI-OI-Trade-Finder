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
import { BLOCK_STALE_AUTO_ENTRY } from '@/lib/priority-refresh/config';
import {
  MAX_PICKS,
  WINDOW_END_MIN,
  WINDOW_START_MIN,
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
    // Exposing this is REQUIRED: the gate reads this key from SQLite every entry
    // check, so a hidden stored `false` (e.g. from an earlier build) would
    // silently disable the protection if it weren't visible/manageable here
    // (PR#11 re-review B1). SAFETY toggle → drift-reported in Trade Suggest.
    key: 'BLOCK_STALE_AUTO_ENTRY',
    label: 'Block stale-candle Auto-Trade entries',
    category: 'Trade Suggest',
    default: BLOCK_STALE_AUTO_ENTRY,
    description:
      'SAFETY — ON by default. Auto-Trade refuses a NEW entry unless the stock’s latest FINISHED 5-minute candle was refreshed after it closed this cycle. The scanner builds its stop and target from that candle, so entering on an old or half-formed one means acting on a stale picture. Exits, stop moves, and the 15:12 square-off are NEVER affected. Leave ON unless you are deliberately debugging.',
  },
  {
    key: 'AUTO_SHUTDOWN',
    label: 'Auto power-off (save cost)',
    category: 'Server',
    default: false,
    description:
      'Master switch for the server powering ITSELF off to save money. OFF (default): the server stays on 24/7 — safest while you are actively testing live, with no surprise shutdowns. ON: the server powers off in the evening (~16:30 IST, well after the 15:12 square-off) and stays off all weekend, then wakes automatically at 08:15 IST on the next trading day. It will NOT power off while any trade is open, whatever the time, and overnight data catches up on the morning restart. Turn ON once live testing settles and you want the ~₹1,000/month saving.',
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
      'The most stocks one scan may suggest. The quality rules are the real limit — quiet days give 1–2 no matter what. With a ₹50–60k account only the top 1–3 are actually tradeable; the rest are just a watchlist.',
  },
  // Times are IST minutes from midnight (e.g. 09:40 = 580, 11:00 = 660).
  {
    key: 'WINDOW_START_MIN',
    label: 'Scan window opens (min IST)',
    category: 'Entry & Exit Times',
    default: WINDOW_START_MIN,
    min: 9 * 60 + 15,
    max: 13 * 60,
    description:
      'When the scan window OPENS, in IST minutes from midnight (default 580 = 09:40, the proven morning window). Autonomous suggestions do not run before this time.',
  },
  {
    key: 'WINDOW_END_MIN',
    label: 'Scan window closes (min IST)',
    category: 'Entry & Exit Times',
    default: WINDOW_END_MIN,
    min: 10 * 60,
    max: 14 * 60 + 30,
    description:
      'When the scan window CLOSES, in IST minutes from midnight (default 660 = 11:00). Momentum fades fastest late in the window — widen this on purpose, not casually.',
  },
  {
    key: 'COMMENTARY_ENTRY_CUTOFF_MIN',
    label: 'Hard new-entry cutoff (min IST) — blocks entries in ALL modes',
    category: 'Entry & Exit Times',
    // Default mirrors COMMENTARY_ENTRY_CUTOFF_MIN_DEFAULT in
    // lib/ai-commentary/generate.ts (kept a literal here to avoid an import
    // cycle: generate.ts reads this module for the runtime value).
    default: 12 * 60 + 30,
    min: 11 * 60,
    max: 15 * 60,
    description:
      'Two jobs, one time (default 750 = 12:30). (1) The AI commentary stops suggesting new entries and switches to managing/exiting open positions. (2) It is ALSO a hard backstop on ORDERS: the auto-trade entry gate uses min(entry window close, this − 1 min, square-off − 1 min), so entries stop at whichever comes FIRST. The gate does not look at the trading mode, so this blocks PAPER entries exactly as it blocks live and approval ones. Widening “Auto-trade entries close” below past this time will NOT extend trading — raise this too. The /auto-trade page always shows the resulting effective close time. Unrelated to the stale-candle freshness gate.',
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
  const rows = (await prisma.$queryRawUnsafe(`SELECT key, value, updatedAt FROM feature_toggles`)) as {
    key: string;
    value: number;
    updatedAt: string;
  }[];
  const stored = new Map(rows.map((r) => [r.key, r]));
  return TOGGLE_DEFS.map((d) => {
    const row = stored.get(d.key);
    return {
      ...d,
      value: row ? row.value === 1 : d.default,
      updatedAt: row?.updatedAt ?? null,
    };
  });
}

/**
 * Effective value of one toggle (stored override, else `fallback`). Best-effort:
 * any DB hiccup returns `fallback` so a toggle read can never break a scan.
 */
export async function getToggle(key: string, fallback: boolean): Promise<boolean> {
  try {
    await ensureTable();
    const rows = (await prisma.$queryRawUnsafe(`SELECT value FROM feature_toggles WHERE key = ?`, key)) as {
      value: number;
    }[];
    return rows.length > 0 ? rows[0].value === 1 : fallback;
  } catch {
    return fallback;
  }
}

/** Number settings whose category also affects the scanner/trading behaviour —
 *  a drifted WINDOW_END_MIN (e.g. 11:00 → 14:30) changes WHEN trades are taken
 *  just as materially as a boolean toggle, so drift detection must cover them
 *  too (PR#2 review 2026-07-20). 'Entry & Exit Times' holds the scan-window
 *  open/close + the commentary entry cutoff. */
const DRIFT_NUMBER_CATEGORIES = new Set(['Trade Suggest', 'Entry & Exit Times']);
/** Toggle categories whose off-default state is drift-reported + Telegram-alerted.
 *  BLOCK_STALE_AUTO_ENTRY now lives in Trade Suggest, so turning that safety
 *  switch OFF is surfaced immediately and in the pre-open reminder. */
const DRIFT_TOGGLE_CATEGORIES = new Set(['Trade Suggest']);

/** IST clock-style number setting (minutes-from-midnight) → render as HH:MM in
 *  the summary. Mirrors the /config page heuristic (key ends _MIN, ≥ 06:00). */
function isClockNumberSetting(key: string, min: number): boolean {
  return key.endsWith('_MIN') && min >= 6 * 60;
}
const minToHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/**
 * PURE: which scanner/trading-relevant settings currently differ from their
 * coded-safe default. Every default IS the safe state; a drifted value is
 * exactly the class of thing that caused the COLPAL 2026-07-20 loss
 * (a stored experimental strategy override left enabled and unnoticed).
 * Split out from the DB read so it is unit-testable without a database
 * (scripts/config-drift-checks.ts, run in CI). Covers 'Trade Suggest' toggles
 * AND the numeric window/pick/cutoff settings (PR#2 review 2026-07-20).
 */
export function buildConfigOverrideSummary(
  toggles: Pick<ToggleState, 'label' | 'category' | 'value' | 'default'>[],
  numbers: Pick<NumberState, 'key' | 'label' | 'category' | 'value' | 'default' | 'min'>[]
): string[] {
  const out: string[] = [];
  for (const t of toggles) {
    if (DRIFT_TOGGLE_CATEGORIES.has(t.category) && t.value !== t.default)
      out.push(`${t.label}: ${t.value ? 'ON' : 'OFF'} (safe default ${t.default ? 'ON' : 'OFF'})`);
  }
  for (const n of numbers) {
    if (!DRIFT_NUMBER_CATEGORIES.has(n.category) || n.value === n.default) continue;
    const fmt = isClockNumberSetting(n.key, n.min) ? minToHHMM : (x: number) => String(x);
    out.push(`${n.label}: ${fmt(n.value)} (safe default ${fmt(n.default)})`);
  }
  return out;
}

/**
 * Currently-active scanner-config overrides (toggles + numeric settings) vs
 * their safe defaults. Used by the poller's pre-open reminder (AT-review
 * 2026-07-20 operational fix); /config renders its own "overridden" badge from
 * the same value!==default rule. Thin DB wrapper over buildConfigOverrideSummary.
 */
export async function tradeSuggestConfigOverrideSummary(): Promise<string[]> {
  const [toggles, numbers] = await Promise.all([getAllToggles(), getAllNumberSettings()]);
  return buildConfigOverrideSummary(toggles, numbers);
}

/** Persist a toggle. Unknown keys are rejected (the registry is the allowlist).
 *  A 'Trade Suggest' toggle moved AWAY from its safe default fires an immediate
 *  alert — the moment-of-change reminder that a silent DB flip can't give
 *  (AT-review 2026-07-20; complements the daily pre-open reminder below). Moving
 *  BACK to the default is a return to safety, not a risk — no alert. */
export async function setToggle(key: string, value: boolean): Promise<void> {
  const def = byKey.get(key);
  if (!def) throw new Error(`unknown toggle: ${key}`);
  await ensureTable();
  await prisma.$executeRawUnsafe(
    `INSERT INTO feature_toggles (key, value, updatedAt) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
    key,
    value ? 1 : 0,
    new Date().toISOString()
  );
  if (DRIFT_TOGGLE_CATEGORIES.has(def.category) && value !== def.default) {
    try {
      const { sendMessage } = await import('@/lib/telegram');
      sendMessage(
        `⚙️ ${def.label} set to ${value ? 'ON' : 'OFF'} — differs from its safe default (${def.default ? 'ON' : 'OFF'}). Check /config if this wasn't intentional.`
      );
    } catch {
      // alerting is best-effort — never block a config write
    }
  }
}

/** One numeric setting's definition plus its current stored state. */
export interface NumberState extends NumberDef {
  value: number;
  updatedAt: string | null;
}

/** Every numeric setting with its effective (stored-or-default) value. */
export async function getAllNumberSettings(): Promise<NumberState[]> {
  await ensureTable();
  const rows = (await prisma.$queryRawUnsafe(`SELECT key, value, updatedAt FROM feature_toggles`)) as {
    key: string;
    value: number;
    updatedAt: string;
  }[];
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
    const rows = (await prisma.$queryRawUnsafe(`SELECT value FROM feature_toggles WHERE key = ?`, key)) as {
      value: number;
    }[];
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
  if (key === 'WINDOW_START_MIN' || key === 'WINDOW_END_MIN') {
    const next = Math.round(value);
    const otherKey = key === 'WINDOW_START_MIN' ? 'WINDOW_END_MIN' : 'WINDOW_START_MIN';
    const otherFallback = otherKey === 'WINDOW_START_MIN' ? WINDOW_START_MIN : WINDOW_END_MIN;
    const other = await getNumberSetting(otherKey, otherFallback);
    const start = key === 'WINDOW_START_MIN' ? next : other;
    const end = key === 'WINDOW_END_MIN' ? next : other;
    if (start >= end) throw new Error('scan window open must be earlier than scan window close');
  }
  await ensureTable();
  const next = Math.round(value);
  await prisma.$executeRawUnsafe(
    `INSERT INTO feature_toggles (key, value, updatedAt) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
    key,
    next,
    new Date().toISOString()
  );
  // Immediate drift alert, symmetric with setToggle: a scanner-relevant numeric
  // moved off its safe default (e.g. WINDOW_END_MIN 11:00→14:30) is exactly the
  // silent change the daily reminder is meant to catch — surface it at once too.
  if (DRIFT_NUMBER_CATEGORIES.has(def.category) && next !== def.default) {
    const fmt = isClockNumberSetting(def.key, def.min) ? minToHHMM : (x: number) => String(x);
    try {
      const { sendMessage } = await import('@/lib/telegram');
      sendMessage(
        `⚙️ ${def.label} set to ${fmt(next)} — differs from its safe default (${fmt(def.default)}). Check /config if this wasn't intentional.`
      );
    } catch {
      // alerting is best-effort — never block a config write
    }
  }
}
