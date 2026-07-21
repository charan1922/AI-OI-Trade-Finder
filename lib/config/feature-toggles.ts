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
  BLOCK_STALE_AUTO_ENTRY,
  PRIORITY_ACTIVE_SECTORS_SHADOW,
  PRIORITY_MAX_UNIQUE,
  PRIORITY_PER_FEED,
  PRIORITY_REFRESH_SHADOW,
  PRIORITY_SECTOR_MAX_AGE_SEC,
  PRIORITY_SECTOR_RESERVED_SLOTS,
  PRIORITY_TOP_SECTORS_PER_SIDE,
} from '@/lib/priority-refresh/config';
import {
  EXCLUDE_EXTENDED,
  MAX_PICKS,
  SCAN_FULL_UNIVERSE,
  SCAN_OUTSIDE_WINDOW,
  USE_BREAKOUT_BYPASS,
  USE_CHAOTIC_OPEN_GATE,
  USE_EXTENDED_TREND_BYPASS,
  USE_MOMENTUM_BREAKOUT,
  USE_RANK_CLIMB_GATE,
  USE_TF_BREAKOUT_GATE,
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
  {
    key: 'USE_CHAOTIC_OPEN_GATE',
    label: 'Skip chaotic opens',
    category: 'Trade Suggest',
    default: USE_CHAOTIC_OPEN_GATE,
    description:
      'Skips a stock whose FIRST 15 MINUTES were a violent spike compared to its own normal 5-minute movement (more than 5× its settled average bar). Why: a stock that blows all its energy at the open tends to fade right after — both auto-trade losers (HYUNDAI 15-Jul, SRF 16-Jul) opened at 5.5–5.7× and faded within 30 minutes, while the winners (MANKIND, PATANJALI, POLYCAB) opened calmer and trended. The 5× line was calibrated on a full-universe backtest: a tighter 4× would have wrongly blocked genuine trend days (KALYANKJIL, SIEMENS, CGPOWER at ~4.3–4.5×). ON (default, per operator request 17-Jul): violent-open names are skipped; the scan shows how many. OFF: the open character is still stamped on every pick as information. Honest caveat: the evidence is 2 recorded days — the nightly scorecard is accruing proof, and this switch comes OFF if the replay turns against it.',
  },
  {
    key: 'USE_RANK_CLIMB_GATE',
    label: 'Rank-climb catch path',
    category: 'Trade Suggest',
    default: USE_RANK_CLIMB_GATE,
    description:
      'OFF (default — ships off for the live-trading debut; turn ON here once live has run clean for a few days): a stock whose combined OI build is small (1–5%, below the usual 5% bar) can still qualify on the options-led path IF it is actively climbing the NSE movers leaderboard (gainers or OI board) over the last ~30 minutes — the ADANIENSOL profile (16-Jul: TF made ₹10.1k, we found 0; it was climbing gainers #15→#7 with options flow qualifying). The options-share and premium-value checks still apply. Evidence is 1 day (winners climbing 5/8 vs losers 1/7) — the replay grid tracks it nightly. ON: enables the catch path. OFF: only the plain 5% rule qualifies, exactly as the proven code.',
  },
  {
    key: 'USE_MOMENTUM_BREAKOUT',
    label: 'Momentum-breakout path',
    category: 'Trade Suggest',
    default: USE_MOMENTUM_BREAKOUT,
    description:
      'A fourth way for a stock to qualify, built for SHORT-COVERING breakouts (price rising while open interest falls — ADANIGREEN 14-Jul was the textbook case: TradeFinder rode it for ₹15.9k while every OI-based rule here rejected it, by design). ON: a stock with NO accumulation evidence (low R-Factor, no OI build, quiet setup) can still be suggested — but ONLY with a confirmed opening-range breakout, BOTH Supertrend AND VWAP agreeing, and at least a 1.5% move from the open in the trade direction. Liquidity, turnover and direction rules still apply. OFF (default): keep it off until the nightly replay benchmark proves it catches these winners without letting fakeouts through across several recorded days — one good day is not proof.',
  },
  {
    key: 'PRIORITY_REFRESH_SHADOW',
    label: 'Shadow: reduced priority refresh',
    category: 'Priority Refresh',
    default: PRIORITY_REFRESH_SHADOW,
    description:
      'MEASUREMENT ONLY — never changes trading. Each 5-minute cycle the app also works out a SMALLER “refresh first” list (your open positions + earlier picks, plus a fair top-40 drawn evenly from the five NSE mover feeds) and records its membership plus how many of that cycle’s suggestions fell OUTSIDE the proposed cap (the coverage evidence). It does NOT reorder anything and does NOT measure timing — the poller waits for the full ~50–80 name list in the exact same order as today. ON (default) to collect that evidence; OFF to stop the extra bookkeeping.',
  },
  {
    key: 'PRIORITY_ACTIVE_SECTORS_SHADOW',
    label: 'Shadow: active-sector promotion',
    category: 'Priority Refresh',
    default: PRIORITY_ACTIVE_SECTORS_SHADOW,
    description:
      'MEASUREMENT ONLY. Inside the shadow plan above, also try promoting a few stocks from the day’s strongest sectors — but only names already on a mover feed, and only when the stock’s own price move agrees with the sector’s direction. It records what WOULD have been promoted so we can judge whether it improves picks; it does not touch the live list. ON (default) to gather the evidence.',
  },
  {
    // Registered now that the stale-candle gate it controls is on `main` (PR #10
    // merged). Exposing it is REQUIRED: the gate reads this key from SQLite every
    // entry check, so a hidden stored `false` (e.g. from an earlier build) would
    // silently disable the protection if it weren't visible/manageable here
    // (PR#11 re-review B1). SAFETY toggle → drift-reported like Trade Suggest.
    key: 'BLOCK_STALE_AUTO_ENTRY',
    label: 'Block stale-candle Auto-Trade entries',
    category: 'Priority Refresh',
    default: BLOCK_STALE_AUTO_ENTRY,
    description:
      'SAFETY — ON by default. An Auto-Trade NEW entry is refused unless the stock’s latest COMPLETED 5-minute candle was refreshed after it closed this cycle: the scanner builds its stop and target from that candle, so entering on a stale/still-forming one means acting on an old picture. Exits, stop-moves and the 15:12 square-off are NEVER affected. Leave ON unless you are deliberately debugging.',
  },
  // NOTE: the LIVE controls (USE_CAPPED_PRIORITY_REFRESH,
  // PRIORITY_INCLUDE_ACTIVE_SECTORS) are still NOT registered here — a /config
  // switch must never appear before the behaviour it controls exists (PR#11
  // review). They ship in the capped-live / sector-live PRs with their real
  // behaviour + the unsafe-combo guard. This PR is measurement-only.
  {
    key: 'AUTO_SHUTDOWN',
    label: 'Auto power-off (save cost)',
    category: 'Server',
    default: false,
    description:
      'Master switch for the AWS box powering ITSELF off to save money. OFF (default): the box stays up 24/7 — safest while you are actively testing live, no surprise shutdowns. ON: a scheduler on the box powers it off in the evening (~16:30 IST, well after the 15:12 square-off) and keeps it off all weekend, then AWS wakes it again at 08:15 IST on the next trading day. The shutdown is position-guarded — it will NOT power off while any trade is open/placing, no matter the time — and overnight jobs are safe because the nightly bhavcopy sync backfills on the morning startup. Flip this ON once live testing settles and you want the ~₹1,000/month saving.',
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
  // Times are IST minutes from midnight (e.g. 09:40 = 580, 11:00 = 660).
  {
    key: 'WINDOW_START_MIN',
    label: 'Scan window opens (min IST)',
    category: 'Entry & Exit Times',
    default: WINDOW_START_MIN,
    min: 9 * 60 + 15,
    max: 13 * 60,
    description:
      'When the scanner window OPENS, as IST minutes from midnight (default 580 = 09:40 — the proven morning window). The window is where suggestions are normal; “Scan outside the window” overrides it entirely when ON.',
  },
  {
    key: 'WINDOW_END_MIN',
    label: 'Scan window closes (min IST)',
    category: 'Entry & Exit Times',
    default: WINDOW_END_MIN,
    min: 10 * 60,
    max: 14 * 60 + 30,
    description:
      'When the scanner window CLOSES, as IST minutes from midnight (default 660 = 11:00). Late-window momentum fades fastest — widen deliberately, not casually.',
  },
  {
    key: 'COMMENTARY_ENTRY_CUTOFF_MIN',
    label: 'Commentary entry cutoff (min IST)',
    category: 'Entry & Exit Times',
    // Default mirrors COMMENTARY_ENTRY_CUTOFF_MIN_DEFAULT in
    // lib/ai-commentary/generate.ts (kept a literal here to avoid an import
    // cycle: generate.ts reads this module for the runtime value).
    default: 12 * 60 + 30,
    min: 11 * 60,
    max: 15 * 60,
    description:
      'After this IST time (minutes from midnight; default 750 = 12:30) the AI commentary stops pitching fresh entries and focuses on managing/exiting open positions. Deterministic — injected by code, not left to the model.',
  },
  {
    key: 'PRIORITY_PER_FEED',
    label: 'Priority: names considered per feed',
    category: 'Priority Refresh',
    default: PRIORITY_PER_FEED,
    min: 5,
    max: 24,
    description:
      'How many names from EACH of the five NSE mover feeds (OI build-up, gainers, losers, most-active by value and by volume) the reduced list considers — ranks 1..N. Higher casts a wider net but lengthens the wait. Bounded 5–24 so a Config click can’t configure a degenerate 1-per-feed list that persists into a later live deploy (PR#11 review). Shadow-only until reduced priority refresh is turned on.',
  },
  {
    key: 'PRIORITY_MAX_UNIQUE',
    label: 'Priority: max unique Tier 1 stocks',
    category: 'Priority Refresh',
    default: PRIORITY_MAX_UNIQUE,
    min: 20,
    max: 80,
    description:
      'The hard cap on the reduced “Tier 1” candidate list (unique stocks). Your open positions and earlier picks (Tier 0) are always waited for ON TOP of this — they never eat into the cap. Bounded 20–80 so a casual change can’t shrink it to a degenerate handful (PR#11 review).',
  },
  {
    key: 'PRIORITY_SECTOR_RESERVED_SLOTS',
    label: 'Priority: sector-reserved Tier 1 slots',
    category: 'Priority Refresh',
    default: PRIORITY_SECTOR_RESERVED_SLOTS,
    min: 0,
    max: 40,
    description:
      'Of the Tier 1 cap, how many slots are set aside for active-sector promotion. Must not exceed “max unique Tier 1”. Any reserved slot that finds no qualifying sector stock falls back to the normal top-of-feed list, so the cap is always filled.',
  },
  {
    key: 'PRIORITY_TOP_SECTORS_PER_SIDE',
    label: 'Priority: top sectors per side',
    category: 'Priority Refresh',
    default: PRIORITY_TOP_SECTORS_PER_SIDE,
    min: 0,
    max: 6,
    description:
      'When promoting sector stocks, how many strong sectors to pick per side — this many bullish AND this many bearish (so both call and put opportunities are covered).',
  },
  {
    key: 'PRIORITY_SECTOR_MAX_AGE_SEC',
    label: 'Priority: max sector-snapshot age (sec)',
    category: 'Priority Refresh',
    default: PRIORITY_SECTOR_MAX_AGE_SEC,
    min: 300,
    max: 900,
    description:
      'Ignore the stored sector snapshot if it is older than this many seconds, and fall back to the plain top-of-feed list. The snapshot is produced by the PREVIOUS 5-minute cycle, so this must comfortably exceed one cycle — default 420s (5-min cycle + grace). Below ~one cycle it would reject every next-cycle read and sector promotion would never run (PR#11 review).',
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
const DRIFT_NUMBER_CATEGORIES = new Set(['Trade Suggest', 'Entry & Exit Times', 'Priority Refresh']);
/** Toggle categories whose off-default state is drift-reported + Telegram-alerted.
 *  'Priority Refresh' is included so the BLOCK_STALE_AUTO_ENTRY safety switch
 *  turned OFF is surfaced immediately + in the pre-open reminder (PR#11 re-review). */
const DRIFT_TOGGLE_CATEGORIES = new Set(['Trade Suggest', 'Priority Refresh']);

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
 * (USE_EXTENDED_TREND_BYPASS left ON since 2026-07-10, unnoticed for 10 days).
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
// The unsafe-combo TOGGLE guard (USE_CAPPED_PRIORITY_REFRESH vs
// BLOCK_STALE_AUTO_ENTRY, §30) ships in the capped-live PR alongside those
// toggles — neither is registered here (this PR is measurement-only), so there
// is no combo to guard yet. The numeric cross-check below IS relevant now
// because both PRIORITY_MAX_UNIQUE and PRIORITY_SECTOR_RESERVED_SLOTS exist here.

/** PURE cross-check for the priority-refresh numeric pair (§30): the reserved
 *  sector slots are carved out of the Tier 1 cap, so they can never exceed it. */
export function assertPriorityNumberCombo(key: string, value: number, other: { maxUnique: number; reserved: number }): void {
  if (key === 'PRIORITY_SECTOR_RESERVED_SLOTS' && value > other.maxUnique) {
    throw new Error(`Sector-reserved slots (${value}) cannot exceed max unique Tier 1 (${other.maxUnique})`);
  }
  if (key === 'PRIORITY_MAX_UNIQUE' && value < other.reserved) {
    throw new Error(`Max unique Tier 1 (${value}) cannot be below sector-reserved slots (${other.reserved})`);
  }
}

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
  // Priority-refresh cross-check (§30): reserved sector slots ≤ Tier 1 cap.
  if (key === 'PRIORITY_SECTOR_RESERVED_SLOTS' || key === 'PRIORITY_MAX_UNIQUE') {
    const [maxUnique, reserved] = await Promise.all([
      getNumberSetting('PRIORITY_MAX_UNIQUE', PRIORITY_MAX_UNIQUE),
      getNumberSetting('PRIORITY_SECTOR_RESERVED_SLOTS', PRIORITY_SECTOR_RESERVED_SLOTS),
    ]);
    assertPriorityNumberCombo(key, Math.round(value), { maxUnique, reserved });
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
