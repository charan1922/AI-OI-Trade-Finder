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
      'Normally a stock is only suggested when "open interest" (how many option/futures contracts big players are holding) is clearly rising — proof that money is flowing in. Some fast stocks jump on price first and that proof only shows up later, so the normal rule skips them. ON: a stock with no open-interest proof yet can still qualify — but only if its price has clearly broken above its early-morning range in the trade direction, the trend indicators agree, and its overall strength score is high. OFF (default): open-interest proof is always required. Trade-off: ON catches early breakouts but on thinner proof — keep OFF until the nightly test shows it picks more winners than junk.',
  },
  {
    key: 'USE_TF_BREAKOUT_GATE',
    label: 'TF breakout gate',
    category: 'Trade Suggest',
    default: USE_TF_BREAKOUT_GATE,
    description:
      'An extra-strict filter on top of the normal rules. ON: a stock is suggested only when its Breakout badge (the /live column) says the breakout is CONFIRMED in the trade direction — the morning low held (for buys) or the morning high held (for sells), AND price has already cleared an important level such as the early-morning-range high, yesterday’s high, or a multi-day high. Stocks still forming, looking like a false breakout, or missing data are dropped (the scan shows how many). OFF (default): the badge is shown as information only and never blocks a suggestion. Keep OFF for now — testing showed the breakout signal points the right way at the right time, but filtering on it has NOT yet been shown to produce better trades.',
  },
  {
    key: 'SCAN_FULL_UNIVERSE',
    label: 'Scan the full F&O universe',
    category: 'Trade Suggest',
    default: SCAN_FULL_UNIVERSE,
    description:
      'How many stocks the scanner even looks at. OFF (default): only the stocks already on NSE’s "movers" lists — biggest open-interest jumps, top gainers, top losers, most active — the same names the /nse/movers page shows (usually 50–80). ON: it checks all ~166 tradeable F&O stocks instead. The quality rules are the same either way — this only widens who gets LOOKED at, not who qualifies. ON also records data for every stock, which the nightly test needs.',
  },
  {
    key: 'SCAN_OUTSIDE_WINDOW',
    label: 'Scan outside the 09:40–11:00 window',
    category: 'Trade Suggest',
    default: SCAN_OUTSIDE_WINDOW,
    description:
      'When the scanner may suggest trades. OFF (safe default): only during the proven morning window, 09:40–11:00 — the whole strategy was built and tested on morning entries, when the best moves begin. ON: it suggests trades any time the market is open. Note: out-of-window picks are saved and mixed into the daily scorecard, so they affect your stats. Turn ON only when you really want all-day scanning.',
  },
  {
    key: 'EXCLUDE_EXTENDED',
    label: 'Skip already-extended movers',
    category: 'Trade Suggest',
    default: EXCLUDE_EXTENDED,
    description:
      'ON (safe default): skip any stock that has already moved 3% or more from today’s open. By the time you could enter, most of the move is over, and chasing late has lost every time we tried it (0 wins out of 5). OFF: the scanner may suggest these big early movers too. Keep ON unless you deliberately want to chase.',
  },
  {
    key: 'USE_EXTENDED_TREND_BYPASS',
    label: 'Extended-trend bypass',
    category: 'Trade Suggest',
    default: USE_EXTENDED_TREND_BYPASS,
    description:
      'Works together with “Skip already-extended movers”. That rule drops every stock already 3%+ from the open — but on a real trending day a stock can keep running much further. ON: such a stock is allowed back in, but ONLY while it is still making fresh highs/lows, staying on the right side of the day’s average-price line (VWAP), and its trend indicator agrees with the direction — one that has stalled or slipped back stays out. Any stock let back in still carries a scoring penalty, so it ranks cautiously. OFF (default): every 3%+ mover stays out, no exceptions. Experimental — turn ON only to gather evidence before trusting it. (Only does anything while “Skip already-extended movers” above is ON.)',
  },
  {
    key: 'USE_CHAOTIC_OPEN_GATE',
    label: 'Skip chaotic opens',
    category: 'Trade Suggest',
    default: USE_CHAOTIC_OPEN_GATE,
    description:
      'Skip a stock whose FIRST 15 MINUTES were a wild spike compared to its own normal pace (more than 5× its usual 5-minute bar). Why: a stock that burns all its energy at the open tends to fade right after — both auto-trade losers opened this wildly and faded within 30 minutes, while the winners opened calmer and trended. The 5× line is deliberately not tighter: a 4× line would have wrongly blocked some genuine trend days. ON (default): wild-open stocks are skipped; the scan shows how many. OFF: the open is still noted on each pick as information. Honest note: this rests on only 2 recorded days — the nightly scorecard is still gathering proof, and this switch comes OFF if results turn against it.',
  },
  {
    key: 'USE_RANK_CLIMB_GATE',
    label: 'Rank-climb catch path',
    category: 'Trade Suggest',
    default: USE_RANK_CLIMB_GATE,
    description:
      'A stock with only a small rise in open interest (1–5%, below the usual 5% bar) can still qualify on the options path IF it is actively climbing NSE’s movers leaderboard (top gainers or open-interest board) over the last ~30 minutes and its options activity checks out. This catches the kind of stock we once missed while others made money on it. ON: turns this extra path on. OFF (default): only the plain 5% rule qualifies — exactly like the proven version. It ships OFF for the live-trading start; turn it ON here once live has run cleanly for a few days. Evidence so far is just 1 day, tracked by the nightly test.',
  },
  {
    key: 'USE_MOMENTUM_BREAKOUT',
    label: 'Momentum-breakout path',
    category: 'Trade Suggest',
    default: USE_MOMENTUM_BREAKOUT,
    description:
      'A fourth way for a stock to qualify, built for "short-covering" breakouts — price rising while open interest FALLS (traders who bet against it rushing to exit). These score badly on every normal rule by design, yet can be big winners. ON: a stock with no build-up evidence at all (low strength score, no open-interest build, quiet setup) can still be suggested — but ONLY with a confirmed early-morning-range breakout, BOTH trend tools agreeing, and at least a 1.5% move from the open in the trade direction. Liquidity, activity and direction rules still apply. OFF (default): keep it off until the nightly test proves it catches these winners without letting false breakouts through over several days — one good day is not proof.',
  },
  {
    key: 'PRIORITY_REFRESH_SHADOW',
    label: 'Shadow: reduced priority refresh',
    category: 'Priority Refresh',
    default: PRIORITY_REFRESH_SHADOW,
    description:
      'MEASUREMENT ONLY — never changes trading. Each 5-minute cycle the app also works out a SHORTER “refresh-first” list (your open positions and earlier picks, plus a fair top-40 spread evenly across NSE’s five movers feeds) and records it, along with how many of that cycle’s suggestions fell outside that shorter list. It does NOT reorder anything and does NOT change timing — the app still waits for the full ~50–80 name list in the same order as today. ON (default) to collect this evidence; OFF to stop the extra note-taking.',
  },
  {
    key: 'PRIORITY_ACTIVE_SECTORS_SHADOW',
    label: 'Shadow: active-sector promotion',
    category: 'Priority Refresh',
    default: PRIORITY_ACTIVE_SECTORS_SHADOW,
    description:
      'MEASUREMENT ONLY. Inside the shadow plan above, also try bumping up a few stocks from the day’s strongest sectors — but only names already on a movers feed, and only when the stock’s own move agrees with its sector’s direction. It just records what WOULD have been bumped up so we can judge whether it helps; it never touches the live list. ON (default) to gather the evidence.',
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
      'SAFETY — ON by default. Auto-Trade refuses a NEW entry unless the stock’s latest FINISHED 5-minute candle was refreshed after it closed this cycle. The scanner builds its stop and target from that candle, so entering on an old or half-formed one means acting on a stale picture. Exits, stop moves, and the 15:12 square-off are NEVER affected. Leave ON unless you are deliberately debugging.',
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
      'When the scan window OPENS, in IST minutes from midnight (default 580 = 09:40, the proven morning window). This is when suggestions are normal; the “Scan outside the window” switch overrides it completely when ON.',
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
    label: 'Commentary entry cutoff (min IST)',
    category: 'Entry & Exit Times',
    // Default mirrors COMMENTARY_ENTRY_CUTOFF_MIN_DEFAULT in
    // lib/ai-commentary/generate.ts (kept a literal here to avoid an import
    // cycle: generate.ts reads this module for the runtime value).
    default: 12 * 60 + 30,
    min: 11 * 60,
    max: 15 * 60,
    description:
      'After this IST time (minutes from midnight; default 750 = 12:30) the AI commentary stops suggesting fresh entries and switches to managing and exiting open positions. Set by code, not left to the AI.',
  },
  {
    key: 'PRIORITY_PER_FEED',
    label: 'Priority: names considered per feed',
    category: 'Priority Refresh',
    default: PRIORITY_PER_FEED,
    min: 5,
    max: 24,
    description:
      'How many names from EACH of NSE’s five movers feeds (open-interest build-up, gainers, losers, most active by value, most active by volume) the shorter refresh list considers — the top 1..N. Higher casts a wider net but makes the wait longer. Limited to 5–24 so a stray click can’t set a broken 1-per-feed list. Only matters once the reduced refresh is turned on.',
  },
  {
    key: 'PRIORITY_MAX_UNIQUE',
    label: 'Priority: max unique Tier 1 stocks',
    category: 'Priority Refresh',
    default: PRIORITY_MAX_UNIQUE,
    min: 20,
    max: 80,
    description:
      'The hard limit on the shorter “Tier 1” candidate list (unique stocks). Your open positions and earlier picks are always handled ON TOP of this — they never eat into the limit. Kept between 20 and 80 so a casual change can’t shrink it to a handful.',
  },
  {
    key: 'PRIORITY_SECTOR_RESERVED_SLOTS',
    label: 'Priority: sector-reserved Tier 1 slots',
    category: 'Priority Refresh',
    default: PRIORITY_SECTOR_RESERVED_SLOTS,
    min: 0,
    max: 40,
    description:
      'Of the Tier 1 limit, how many spots are set aside for strong-sector stocks. Can’t be more than “max unique Tier 1”. Any reserved spot that finds no qualifying sector stock falls back to the normal top-of-feed list, so the list is always filled.',
  },
  {
    key: 'PRIORITY_TOP_SECTORS_PER_SIDE',
    label: 'Priority: top sectors per side',
    category: 'Priority Refresh',
    default: PRIORITY_TOP_SECTORS_PER_SIDE,
    min: 0,
    max: 6,
    description:
      'When promoting sector stocks, how many strong sectors to pick on each side — this many bullish AND this many bearish, so both call and put ideas are covered.',
  },
  {
    key: 'PRIORITY_SECTOR_MAX_AGE_SEC',
    label: 'Priority: max sector-snapshot age (sec)',
    category: 'Priority Refresh',
    default: PRIORITY_SECTOR_MAX_AGE_SEC,
    min: 300,
    max: 900,
    description:
      'Ignore the saved sector snapshot if it is older than this many seconds, and fall back to the plain top-of-feed list. The snapshot comes from the PREVIOUS 5-minute cycle, so this must comfortably exceed one cycle — default 420s (one cycle plus a little grace). Set too low, it would reject every fresh read and sector promotion would never run.',
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
 * Toggles that are only ever REACHED from inside another toggle's branch.
 *
 * A switch listed here, turned ON while its parent is OFF, is unreachable code
 * wearing the costume of a live permission. It is not drift — both values may
 * sit at their own defaults — so the drift summary above cannot catch it.
 *
 * Found 2026-07-23: `USE_EXTENDED_TREND_BYPASS` was ON while `EXCLUDE_EXTENDED`
 * had been switched OFF that morning. The bypass only ever runs inside the
 * `excludeExtended && s.extended` branch in trade-suggest/engine.ts, so it did
 * nothing at all — while /config showed it enabled. Nothing in the app said so.
 */
export const TOGGLE_PARENTS: { child: string; parent: string; why: string }[] = [
  {
    child: 'USE_EXTENDED_TREND_BYPASS',
    parent: 'EXCLUDE_EXTENDED',
    why: 'the bypass only re-admits names that “Skip already-extended movers” has excluded — with the parent OFF nothing is excluded, so there is nothing to re-admit',
  },
];

/**
 * PURE: bypass switches that are ON but unreachable because the rule they hang
 * off is OFF. Separate from drift on purpose — this is a *combination* fault,
 * and both halves can be at their own defaults while the pair is meaningless.
 */
export function buildUnreachableToggleWarnings(
  toggles: Pick<ToggleState, 'key' | 'label' | 'value'>[]
): string[] {
  const byKey = new Map(toggles.map((t) => [t.key, t]));
  const out: string[] = [];
  for (const link of TOGGLE_PARENTS) {
    const child = byKey.get(link.child);
    const parent = byKey.get(link.parent);
    if (child == null || parent == null) continue;
    if (child.value && !parent.value) {
      out.push(
        `“${child.label}” is ON but does nothing: it only runs inside “${parent.label}”, which is OFF — ${link.why}. Turn the parent back ON to use it, or turn this OFF so the page reflects what is actually running.`
      );
    }
  }
  return out;
}

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

/** Bypass switches currently ON but unreachable (parent rule OFF). Reported
 *  alongside the drift summary in the pre-open reminder — an operator reading
 *  "bypass ON" deserves to know it is inert. */
export async function unreachableToggleWarnings(): Promise<string[]> {
  return buildUnreachableToggleWarnings(await getAllToggles());
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
