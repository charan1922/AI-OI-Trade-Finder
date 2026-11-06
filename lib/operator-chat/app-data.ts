/**
 * `read_app_data` — the operator chat's window onto everything the app's pages
 * show: Live Urgency, the TF Running Race, sector scope, positions, P&L, the
 * stored commentary, and so on. It reads the app's OWN routes (so the chat
 * cites exactly what is on screen, never a parallel computation) through a
 * strict ALLOWLIST.
 *
 * Only GET routes verified side-effect-free are listed, with every parameter
 * validated before a request is built. Deliberately absent: /api/logs (raw
 * logs can hold anything), /api/fyers/poller (its GET starts the poller),
 * /api/market-calendar (writes on GET), /api/live/candles (an unknown symbol
 * enrolls into the Fyers universe), the bare /api/trade-suggest (runs and
 * persists a scan), and every token / cookie / user / DB-explorer route.
 *
 * Live Urgency is the one POST: it replays /live's own path exactly — the
 * section's NSE watchlist, then POST /api/live/quote with those symbols and
 * WITHOUT `fresh`, so while /live is open it shares the 6.5s quote cache and
 * costs no extra broker traffic.
 */

import { todayIST } from '@/lib/ist';
import { GATE_LABEL, GATE_ORDER } from '@/lib/tf-live/board-view';
import { loadMarketSideways } from '@/lib/tf-live/market-sideways-data';
import { internalAuthHeaders, internalOrigin } from '@/lib/trade-suggest/candidates';
import type { NeutralToolDef } from '@/lib/auto-trade/tools/defs';

/** Big boards are trimmed so one call cannot flood the model's context. */
const MAX_RESPONSE_CHARS = 16_000;
const FETCH_TIMEOUT_MS = 15_000;

const SECTIONS = ['nse-oi', 'nse-active-value', 'nse-active-volume', 'nse-gainers', 'nse-losers'] as const;
const BASES = ['gainers', 'losers', 'movers'] as const;

type Args = Record<string, unknown>;

const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isSymbol = (v: unknown): v is string => typeof v === 'string' && /^[A-Z0-9&-]{1,20}$/.test(v.toUpperCase());
function oneOf<T extends readonly string[]>(v: unknown, allowed: T): T[number] | null {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T[number]) : null;
}
function intIn(v: unknown, min: number, max: number): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}
function qs(params: Record<string, string | number | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

interface Source {
  description: string;
  /** Build the GET path, or return an error string the model sees (bad params). */
  path: (a: Args) => string | { error: string };
}

/** One race-board row as /api/tf/race returns it — only the fields scan_verdicts reads. */
interface RaceRow {
  symbol: string;
  side: 'CE' | 'PE';
  rankNow: number;
  tradeable: boolean;
  blockedBy: string | null;
  needs: string | null;
  gates: Record<string, boolean | null>;
}

/**
 * Pure: every name on TF's board with WHY it was picked or rejected — the
 * selector's own ten checks (gateStrip mirrors selectTfCandidates check for
 * check; verify-tf-selector proves all-green ⇔ picked). This is how the chat can
 * confirm a check like "move started" (quiet/fading) or the Supertrend veto is
 * REJECTING names, not just warning.
 */
export function toScanVerdicts(body: {
  date?: string;
  boardMinuteIST?: number | null;
  stale?: boolean;
  verdictsLive?: boolean;
  verdictNote?: string | null;
  marketSideways?: { stuck: boolean | null; reason: string } | null;
  board?: RaceRow[];
}): unknown {
  const hhmm = (m: number | null | undefined) =>
    m == null ? null : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const rows = (body.board ?? []).map((r) => {
    const entries = Object.entries(r.gates ?? {});
    const failed = entries.filter(([, v]) => v === false).map(([k]) => GATE_LABEL[k as keyof typeof GATE_LABEL] ?? k);
    const unknown = entries.filter(([, v]) => v == null).map(([k]) => GATE_LABEL[k as keyof typeof GATE_LABEL] ?? k);
    return {
      symbol: r.symbol,
      side: r.side,
      tfRank: r.rankNow,
      verdict: r.tradeable ? 'PICKED' : 'REJECTED',
      failedChecks: failed,
      notEvaluable: unknown,
      why: r.tradeable ? null : (r.blockedBy ?? (r.needs ? `needs ${r.needs}` : null)),
    };
  });
  return {
    date: body.date ?? null,
    boardAtIST: hhmm(body.boardMinuteIST),
    stale: body.stale ?? null,
    verdictsLive: body.verdictsLive ?? null,
    verdictNote: body.verdictNote ?? null,
    // Market-wide gate (2026-10-29): when stuck, names can pass every check and still not be taken.
    marketSideways: body.marketSideways ?? null,
    checks: GATE_ORDER.map((k) => GATE_LABEL[k]),
    picked: rows.filter((r) => r.verdict === 'PICKED').length,
    rejected: rows.filter((r) => r.verdict === 'REJECTED').length,
    names: rows,
  };
}

const SOURCES: Record<string, Source> = {
  check_market_sideways: {
    description:
      "Is the WHOLE market sideways right now? NIFTY's 30-min opening-range width and whether NIFTY is still inside it, breadth (share of F&O stocks up), share of stocks still inside their own 30-min range, and stuck true/false/null (true only when all three say sideways: NIFTY inside a < 0.4% range, breadth 40–60%, > 65% inside). Read-only; nothing blocks on it automatically — the trader decides.",
    path: () => 'in-process: loadMarketSideways(today, now)',
  },
  scan_verdicts: {
    description:
      "WHY each name on TF's board was PICKED or REJECTED right now — per stock, which of the selector's ten checks failed (e.g. 'move started' = quiet/fading rejected, 'Supertrend with it' = Supertrend veto), which could not be evaluated, and the plain-English reason. Use this to confirm a check is rejecting names, not just warning. Optional args.date YYYY-MM-DD for a past session.",
    path: (a) => (a.date == null ? '/api/tf/race' : isDate(a.date) ? `/api/tf/race${qs({ date: a.date })}` : { error: 'date must be YYYY-MM-DD' }),
  },
  live_urgency: {
    description:
      'The /live Live Urgency board for one section (args.section: nse-oi = F&O OI build-up, nse-active-value / nse-active-volume = Most Active, nse-gainers, nse-losers): per-stock price, OI, urgency, R-Factor rows exactly as /live shows them. Post-market it is the recorded closing snapshot.',
    path: () => ({ error: 'internal' }), // handled specially below
  },
  nse_watchlist: {
    description: 'The NSE list behind a /live section (args.section, same values as live_urgency), F&O-filtered.',
    path: (a) => {
      const section = oneOf(a.section, SECTIONS);
      return section
        ? `/api/live/nse-watchlist${qs({ source: section })}`
        : { error: `section must be one of ${SECTIONS.join(', ')}` };
    },
  },
  tf_race: {
    description:
      "TradeFinder Running Race / TF Climbers card: TF's top names, R-Factor rise, and the selector's check dots (args.date optional YYYY-MM-DD; omit for live).",
    path: (a) =>
      a.date == null
        ? '/api/tf/race'
        : isDate(a.date)
          ? `/api/tf/race${qs({ date: a.date })}`
          : { error: 'date must be YYYY-MM-DD' },
  },
  tf_rfactor_map: {
    description: "TradeFinder's latest LTP, % change and R-Factor for every symbol on its board (the /live TF column).",
    path: () => '/api/tf/rfactor-map',
  },
  tf_eod: {
    description:
      "TradeFinder's parsed board + sector indices for one day (args.date YYYY-MM-DD; omit to list available dates).",
    path: (a) =>
      a.date == null
        ? '/api/tf/eod?dates=true'
        : isDate(a.date)
          ? `/api/tf/eod${qs({ date: a.date })}`
          : { error: 'date must be YYYY-MM-DD' },
  },
  sector_scope: {
    description:
      "TradeFinder's sector index readings (the /sector-scope page). Use for direction and rank; it is not a plain %.",
    path: () => '/api/sector-scope/indices',
  },
  sector_leaders: {
    description:
      'Top 5-session movers per sector (args.basis: gainers | losers | movers, default gainers; args.perSector 1-4, default 2).',
    path: (a) => {
      const basis = a.basis == null ? null : oneOf(a.basis, BASES);
      const perSector = a.perSector == null ? null : intIn(a.perSector, 1, 4);
      if (a.basis != null && !basis) return { error: `basis must be one of ${BASES.join(', ')}` };
      if (a.perSector != null && perSector == null) return { error: 'perSector must be 1-4' };
      return `/api/live/sector-leaders${qs({ basis, perSector })}`;
    },
  },
  nifty_context: {
    description: 'NIFTY index option / gamma context the /live page shows.',
    path: () => '/api/live/nifty-context',
  },
  oi_series: {
    description:
      "One stock's intraday futures OI series + urgency (args.symbol required; args.date optional YYYY-MM-DD).",
    path: (a) => {
      if (!isSymbol(a.symbol)) return { error: 'symbol is required, e.g. "RELIANCE"' };
      if (a.date != null && !isDate(a.date)) return { error: 'date must be YYYY-MM-DD' };
      return `/api/live/oi-series${qs({ symbol: (a.symbol as string).toUpperCase(), date: a.date as string | undefined })}`;
    },
  },
  urgency_history: {
    description: 'The frozen end-of-day Live Urgency board (args.date optional YYYY-MM-DD; omit for the latest).',
    path: (a) =>
      a.date == null
        ? '/api/live/urgency-history'
        : isDate(a.date)
          ? `/api/live/urgency-history${qs({ date: a.date })}`
          : { error: 'date must be YYYY-MM-DD' },
  },
  movers_history: {
    description:
      'End-of-day NSE movers (price %, turnover, OI %) for a day (args.date YYYY-MM-DD; omit to list dates).',
    path: (a) =>
      a.date == null
        ? '/api/nse/movers-history?dates=true'
        : isDate(a.date)
          ? `/api/nse/movers-history${qs({ date: a.date })}`
          : { error: 'date must be YYYY-MM-DD' },
  },
  heatmap: {
    description: 'End-of-day sector heatmap tiles built from the official bhavcopy.',
    path: () => '/api/heatmap',
  },
  nse_indices: {
    description: 'NSE index levels + market status (slower — live NSE call).',
    path: () => '/api/nse/heatmap',
  },
  auto_trade_today: {
    description:
      "The auto-trader's book for a day: trades, open positions, orders, pending approvals, exposure, P&L, settings, recent decisions (args.date optional; default today).",
    path: (a) =>
      a.date == null
        ? '/api/auto-trade'
        : isDate(a.date)
          ? `/api/auto-trade${qs({ date: a.date })}`
          : { error: 'date must be YYYY-MM-DD' },
  },
  auto_trade_history: {
    description: "One past day's auto-trades with the win / P&L summary (args.date YYYY-MM-DD; omit to list dates).",
    path: (a) =>
      a.date == null
        ? '/api/auto-trade/history?dates=true'
        : isDate(a.date)
          ? `/api/auto-trade/history${qs({ date: a.date })}`
          : { error: 'date must be YYYY-MM-DD' },
  },
  commentary: {
    description: 'Stored /trade-commentary reads + cycle timelines (args.date optional; args.limit 1-30, default 5).',
    path: (a) => {
      if (a.date != null && !isDate(a.date)) return { error: 'date must be YYYY-MM-DD' };
      const limit = a.limit == null ? 5 : intIn(a.limit, 1, 30);
      if (limit == null) return { error: 'limit must be 1-30' };
      return `/api/trade-commentary${qs({ date: a.date as string | undefined, limit })}`;
    },
  },
  suggestion_history: {
    description:
      "The scanner's past suggestions and how they graded (args.days 1-365, default 30). Never runs a new scan.",
    path: (a) => {
      const days = a.days == null ? 30 : intIn(a.days, 1, 365);
      return days == null ? { error: 'days must be 1-365' } : `/api/trade-suggest${qs({ view: 'history', days })}`;
    },
  },
  suggestion_leaderboard: {
    description:
      "Where the scanner's picks ranked on the day's board (args.date optional; args.limit 1-50). Never runs a new scan.",
    path: (a) => {
      if (a.date != null && !isDate(a.date)) return { error: 'date must be YYYY-MM-DD' };
      const limit = a.limit == null ? null : intIn(a.limit, 1, 50);
      if (a.limit != null && limit == null) return { error: 'limit must be 1-50' };
      return `/api/trade-suggest${qs({ view: 'leaderboard', date: a.date as string | undefined, limit })}`;
    },
  },
  bhavcopy_status: {
    description: 'How fresh the official NSE end-of-day (bhavcopy) data is.',
    path: () => '/api/bhavcopy',
  },
};

export const APP_DATA_SOURCES: readonly string[] = Object.keys(SOURCES);

/** Pure: the GET path a source + args resolve to (live_urgency is a two-step read, see liveUrgency). */
export function appDataPath(args: Args): string | { error: string } {
  const source = typeof args.source === 'string' ? args.source : '';
  const spec = SOURCES[source];
  if (!spec) return { error: `Unknown source "${source}"` };
  if (source === 'live_urgency') return '/api/live/nse-watchlist → POST /api/live/quote';
  return spec.path(args);
}

export const READ_APP_DATA_TOOL: NeutralToolDef = {
  name: 'read_app_data',
  description: [
    "Read any page's data from this app, exactly as the operator sees it. Pick a source:",
    ...Object.entries(SOURCES).map(([k, s]) => `- ${k}: ${s.description}`),
    'Read-only: none of these places, changes or cancels anything, and none runs a new scan.',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      source: { type: 'string', enum: Object.keys(SOURCES) },
      section: { type: 'string', enum: [...SECTIONS] },
      symbol: { type: 'string' },
      date: { type: 'string', description: 'YYYY-MM-DD' },
      basis: { type: 'string', enum: [...BASES] },
      perSector: { type: 'number' },
      limit: { type: 'number' },
      days: { type: 'number' },
    },
    required: ['source'],
  },
};

async function getJson(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${internalOrigin()}${path}`, {
    ...init,
    headers: { ...(init?.headers as Record<string, string> | undefined), ...internalAuthHeaders() },
    cache: 'no-store',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = { nonJson: text.slice(0, 300) };
  }
  if (!res.ok) throw new Error(`${path} answered ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

async function liveUrgency(a: Args): Promise<unknown> {
  const section = oneOf(a.section, SECTIONS);
  if (!section) return { error: `section must be one of ${SECTIONS.join(', ')}` };
  const list = (await getJson(`/api/live/nse-watchlist${qs({ source: section })}`)) as {
    success?: boolean;
    picks?: { symbol: string }[];
    error?: string;
  };
  if (!list.success || !list.picks) return { error: list.error ?? 'Could not build this /live section list.' };
  const symbols = list.picks.map((p) => p.symbol);
  if (symbols.length === 0) return { section, rows: [], note: 'The section list is empty right now.' };
  return getJson('/api/live/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Same body /live sends (no `fresh`) — shares the quote cache with an open /live page.
    body: JSON.stringify({ symbols }),
  });
}

function trimmed(data: unknown): unknown {
  const text = JSON.stringify(data);
  if (text.length <= MAX_RESPONSE_CHARS) return data;
  return {
    truncated: true,
    note: `Response was ${text.length.toLocaleString('en-IN')} chars; only the first ${MAX_RESPONSE_CHARS.toLocaleString('en-IN')} are shown. Never guess the rest — narrow the request (a date, a section, a symbol) if you need more.`,
    partialJson: text.slice(0, MAX_RESPONSE_CHARS),
  };
}

export async function readAppData(args: Args): Promise<{ result: unknown; ok: boolean; summary: string }> {
  const source = typeof args.source === 'string' ? args.source : '';
  const spec = SOURCES[source];
  if (!spec) {
    return {
      result: { error: `Unknown source "${source}". Use one of: ${Object.keys(SOURCES).join(', ')}` },
      ok: false,
      summary: 'unknown source',
    };
  }
  try {
    if (source === 'check_market_sideways') {
      // Same loader and rule the trader's check_market_sideways tool uses — in-process, no HTTP hop.
      const ist = new Date(Date.now() + 330 * 60_000);
      const regime = await loadMarketSideways(todayIST(), ist.getUTCHours() * 60 + ist.getUTCMinutes());
      return { result: regime, ok: true, summary: `check_market_sideways: ${regime.reason}` };
    }
    if (source === 'live_urgency') {
      const data = await liveUrgency(args);
      return { result: trimmed(data), ok: true, summary: `live_urgency ${String(args.section)}` };
    }
    const path = appDataPath(args);
    if (typeof path !== 'string') return { result: path, ok: false, summary: `${source}: ${path.error}` };
    const data = await getJson(path);
    if (source === 'scan_verdicts') {
      return { result: trimmed(toScanVerdicts(data as Parameters<typeof toScanVerdicts>[0])), ok: true, summary: `${source} ${path}` };
    }
    return { result: trimmed(data), ok: true, summary: `${source} ${path}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { result: { error: msg }, ok: false, summary: `${source} failed: ${msg.slice(0, 120)}` };
  }
}
