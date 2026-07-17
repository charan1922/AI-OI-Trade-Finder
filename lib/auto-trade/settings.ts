/**
 * Auto-trade runtime settings — mode / broker / AI provider / kill switch /
 * caps, persisted in SQLite so they are flippable from the /auto-trade page
 * without a redeploy. Same derived-table convention as
 * lib/config/feature-toggles.ts: raw CREATE TABLE IF NOT EXISTS via Prisma,
 * mirrored by the AutoTradeSetting model in schema.prisma so `db push` keeps
 * it. Values are stored as TEXT; the registry below is the allowlist AND the
 * validator — a write to an unknown key or an out-of-range value is rejected.
 *
 * Live mode is TWO-KEY: settings.mode === 'live' is not enough — the env var
 * AUTO_TRADE_LIVE_ENABLED=true must also be set (lib/env.ts). The UI can
 * select live, but orders stay blocked until the second key exists.
 */

import { prisma } from '@/lib/db';
import { DEFAULT_SETTINGS } from './config';
import type { AiProvider, AutoTradeSettings, BrokerId, TradeMode } from './types';

const MODES: TradeMode[] = ['off', 'paper', 'approval', 'live'];
const BROKERS: BrokerId[] = ['fyers', 'dhan'];
const PROVIDERS: AiProvider[] = ['azure', 'mimo'];

interface SettingDef {
  key: keyof AutoTradeSettings;
  /** Validate + parse the raw TEXT value; throw on anything invalid. */
  parse: (raw: string) => AutoTradeSettings[keyof AutoTradeSettings];
  /** Serialize for storage. */
  serialize: (v: AutoTradeSettings[keyof AutoTradeSettings]) => string;
  label: string;
  description: string;
}

function intInRange(raw: string, min: number, max: number, label: string): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return n;
}

function oneOf<T extends string>(raw: string, allowed: T[], label: string): T {
  if (!allowed.includes(raw as T)) throw new Error(`${label} must be one of: ${allowed.join(', ')}`);
  return raw as T;
}

/** IST minute-of-day setting: accepts plain minutes ("585") or "HH:MM" ("09:45"),
 *  clamp-validated like every other numeric setting. */
function minuteInRange(raw: string, min: number, max: number, label: string): number {
  const hhmm = raw.trim().match(/^(\d{1,2}):(\d{2})$/);
  let value: number;
  if (hhmm) {
    const hour = Number(hhmm[1]);
    const minute = Number(hhmm[2]);
    if (hour > 23 || minute > 59) throw new Error(`${label} must be a valid HH:MM clock time (got ${raw})`);
    value = hour * 60 + minute;
  } else {
    value = Number(raw);
  }
  const n = Math.round(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    const f = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    throw new Error(`${label} must be between ${f(min)} and ${f(max)} IST (got "${raw}")`);
  }
  return n;
}

export const SETTING_DEFS: SettingDef[] = [
  {
    key: 'mode',
    parse: (raw) => oneOf(raw, MODES, 'mode'),
    serialize: String,
    label: 'Trading mode',
    description:
      'off = dormant · paper = simulated fills at real quotes · approval = AI proposes, you approve each order · live = autonomous real orders (also needs AUTO_TRADE_LIVE_ENABLED=true in env).',
  },
  {
    key: 'broker',
    parse: (raw) => oneOf(raw, BROKERS, 'broker'),
    serialize: String,
    label: 'Active broker',
    description: 'Which account real orders go to. One active at a time; both stay wired.',
  },
  {
    key: 'aiProvider',
    parse: (raw) => oneOf(raw, PROVIDERS, 'aiProvider'),
    serialize: String,
    label: 'Decision AI',
    description: 'azure = the Trade Assistant deployment (proven tool-calling) · mimo = the commentary model.',
  },
  {
    key: 'killSwitch',
    parse: (raw) => raw === '1' || raw === 'true',
    serialize: (v) => (v ? '1' : '0'),
    label: 'Kill switch',
    description: 'ON = no new orders, instantly. Open positions keep being guarded to exit.',
  },
  {
    key: 'maxTradesPerDay',
    parse: (raw) => intInRange(raw, 1, 4, 'maxTradesPerDay'),
    serialize: String,
    label: 'Max trades per day',
    description: 'Hard cap on entries per day. User rule: 2.',
  },
  {
    key: 'maxOpenLots',
    parse: (raw) => intInRange(raw, 1, 4, 'maxOpenLots'),
    serialize: String,
    label: 'Max open lots',
    description: 'Hard cap on simultaneously open lots. User rule: 2.',
  },
  {
    key: 'maxCapitalRupees',
    parse: (raw) => intInRange(raw, 10_000, 200_000, 'maxCapitalRupees'),
    serialize: String,
    label: 'Capital budget (₹)',
    description: 'Cap on premium deployed across open + pending positions. User account: ₹50–60k.',
  },
  {
    key: 'dailyLossHaltRupees',
    parse: (raw) => intInRange(raw, 500, 20_000, 'dailyLossHaltRupees'),
    serialize: String,
    label: 'Daily loss halt (₹)',
    description: 'Realized loss on the day at which new entries stop.',
  },
  {
    key: 'maxSpreadPct',
    parse: (raw) => intInRange(raw, 1, 8, 'maxSpreadPct'),
    serialize: String,
    label: 'Max option spread (%)',
    description:
      'Reject an entry when the option’s bid-ask spread exceeds this % of its price. The spread is what a market order loses instantly at fill — 3% caps that bleed at ~₹600 on a ₹20k lot; 8% would allow more than the ₹1.5k max loss. Exits are never blocked by this.',
  },
  {
    key: 'approvalTtlMin',
    parse: (raw) => intInRange(raw, 5, 60, 'approvalTtlMin'),
    serialize: String,
    label: 'Approval TTL (min)',
    description: 'A pending approval older than this expires (the quote is stale).',
  },
  {
    key: 'telegramAlerts',
    parse: (raw) => raw === '1' || raw === 'true',
    serialize: (v) => (v ? '1' : '0'),
    label: 'Telegram alerts',
    description: 'ON = send auto-trade alerts, approval buttons, and commentary to Telegram. OFF = silent.',
  },
  // ── Entry/exit clock (IST minutes from midnight; accepts "HH:MM" too) ──────
  // Runtime-tunable at the user's request (2026-07-15), previously compile-time
  // rails. Clamps keep any value inside sane market-hours bounds; enforcement
  // stays in code (risk gates + position guard). Cross-field order is checked
  // on every read and write; an invalid persisted triplet falls back safely.
  {
    key: 'entryStartMin',
    parse: (raw) => minuteInRange(raw, 9 * 60 + 30, 12 * 60, 'entryStartMin'),
    serialize: String,
    label: 'Entry window opens',
    description: 'Earliest new entry, IST. Enter minutes-from-midnight or "HH:MM" (default 09:45; clamp 09:30–12:00).',
  },
  {
    key: 'entryEndMin',
    parse: (raw) => minuteInRange(raw, 10 * 60, 14 * 60 + 30, 'entryEndMin'),
    serialize: String,
    label: 'Entry window closes',
    description: 'Latest new entry, IST. Enter minutes-from-midnight or "HH:MM" (default 11:00; clamp 10:00–14:30).',
  },
  {
    key: 'squareOffMin',
    parse: (raw) => minuteInRange(raw, 14 * 60, 15 * 60 + 20, 'squareOffMin'),
    serialize: String,
    label: 'Forced square-off',
    description:
      'Position guard attempts to exit everything open at/after this IST time. Enter minutes or "HH:MM" (default 15:12; clamp 14:00–15:20).',
  },
];

const defByKey = new Map(SETTING_DEFS.map((d) => [d.key, d]));
let tableReady = false;

function assertClockOrder(settings: AutoTradeSettings): void {
  if (settings.entryStartMin >= settings.entryEndMin) {
    throw new Error('entry window open must be earlier than entry window close');
  }
  if (settings.entryEndMin >= settings.squareOffMin) {
    throw new Error('entry window close must be earlier than forced square-off');
  }
}

async function ensureTable(): Promise<void> {
  if (tableReady) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS auto_trade_settings (
      key       TEXT PRIMARY KEY,
      value     TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )
  `);
  tableReady = true;
}

/** Effective settings: stored overrides on top of DEFAULT_SETTINGS. Best-effort —
 *  a DB hiccup returns the defaults (mode 'off' fails SAFE: nothing trades). */
export async function getAutoTradeSettings(): Promise<AutoTradeSettings> {
  try {
    await ensureTable();
    const rows = (await prisma.$queryRawUnsafe(`SELECT key, value FROM auto_trade_settings`)) as {
      key: string;
      value: string;
    }[];
    const out: AutoTradeSettings = { ...DEFAULT_SETTINGS };
    for (const row of rows) {
      const def = defByKey.get(row.key as keyof AutoTradeSettings);
      if (!def) continue;
      try {
        // Assigning through the keyof union needs one widening cast.
        (out as unknown as Record<string, unknown>)[def.key] = def.parse(row.value);
      } catch {
        // Invalid stored value → keep the default for that key
      }
    }
    try {
      assertClockOrder(out);
    } catch {
      out.entryStartMin = DEFAULT_SETTINGS.entryStartMin;
      out.entryEndMin = DEFAULT_SETTINGS.entryEndMin;
      out.squareOffMin = DEFAULT_SETTINGS.squareOffMin;
    }
    return out;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Persist one setting. Unknown keys / invalid values throw (the registry is
 *  the allowlist). Returns the full effective settings after the write. */
export async function setAutoTradeSetting(key: string, value: string): Promise<AutoTradeSettings> {
  const def = defByKey.get(key as keyof AutoTradeSettings);
  if (!def) throw new Error(`unknown auto-trade setting: ${key}`);
  const parsed = def.parse(value); // throws on invalid
  const candidate = await getAutoTradeSettings();
  (candidate as unknown as Record<string, unknown>)[def.key] = parsed;
  assertClockOrder(candidate);
  await ensureTable();
  await prisma.$executeRawUnsafe(
    `INSERT INTO auto_trade_settings (key, value, updatedAt) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
    key,
    def.serialize(parsed),
    new Date().toISOString()
  );
  return getAutoTradeSettings();
}
