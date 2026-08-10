/**
 * Function-calling tools for the assistant. Each tool has (1) a schema the model
 * sees and (2) an executor that returns REAL data from trade-data.ts. The model
 * never sees raw tables — it asks for data via these, keeping answers grounded.
 */

import type OpenAI from 'openai';
import { computeEodLeaderboard } from '@/lib/trade-suggest/eod-leaderboard';
import { runTradeSuggest } from '@/lib/trade-suggest/engine';
import { getStats } from '@/lib/trade-suggest/store';
import { getMarketPulse, getSymbolSnapshot, SELF_ORIGIN } from './live-data';
import { getTradeContext, listTrades, rankTrades } from './trade-data';
import type { ToolTraceEntry } from './types';

/** Tool schemas passed to the Responses API (strict:false — args have optionals). */
export const TOOL_DEFS: OpenAI.Responses.Tool[] = [
  {
    type: 'function',
    name: 'list_trades',
    description:
      'List TradeFinder trades (most recent first) for "which/list/compare/how many" questions. ' +
      'Returns symbol, date, option, expiry, P&L, and whether human-verified.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        verifiedOnly: { type: 'boolean', description: 'Only human-verified trades.' },
        search: { type: 'string', description: 'Filter by symbol or date substring (e.g. "ONGC" or "2026-05").' },
        limit: { type: 'number', description: 'Max rows (default 25, max 100).' },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'rank_trades',
    description:
      'Rank trades by a data metric and return the top N. Use for "strongest / highest / top / weakest / rank by" ' +
      'questions about option OI buildup, OI level, or P&L. Computes the metric for every trade in scope in one call ' +
      '(defaults to human-verified trades). Returns each trade with its metric value, data bias, and P&L.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        metric: {
          type: 'string',
          enum: ['oi_buildup', 'oi_level', 'pnl'],
          description: 'What to rank by. oi_buildup = trade-day option OI buildup % (default); oi_level = OI vs cycle avg; pnl = realised P&L.',
        },
        verifiedOnly: { type: 'boolean', description: 'Rank only human-verified trades (default true).' },
        limit: { type: 'number', description: 'How many to return (default 5, max 20).' },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_live_suggestions',
    description:
      'Run the LIVE near-ATM options scan (the /trade-suggest engine) NOW over the full ~166-name tradeable F&O ' +
      'universe and return up to MAX_PICKS (default 7, /config-tunable) evidence-backed picks: ' +
      'contract (strike/expiry/lot), spot entry/SL/target, real premium + per-lot cost, R-Factor (1–10), OI evidence ' +
      '(futures level or NSE combined), combined-OI build rate (~30 min), opening-range breakout, sector alignment ' +
      '(turnover-weighted), and per-pick reasons. Use for "what should I trade ' +
      'now / today\'s picks / scan the market" questions. Only meaningful during market hours; the 09:40–11:00 IST ' +
      'window is the proven entry zone — outside it the response says so (never force unless the user explicitly asks). ' +
      'NEVER invent numbers beyond what this returns.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        force: { type: 'boolean', description: 'Bypass the 09:40–11:00 window gate (only when the user explicitly asks for an out-of-window scan). Market must still be open.' },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_market_pulse',
    description:
      "Market-wide overview: NSE's live pulse lists (top OI build-ups, F&O gainers/losers, most active by " +
      'value/volume — the exact /nse/movers lists, F&O-gated with sectors) plus price-based sector breadth ' +
      '(gainers vs losers per sector). Use for "how is the market / which sectors are moving / what\'s hot ' +
      'today" questions. Works after hours too (NSE serves the LAST session\'s lists — the note says which). ' +
      "IMPORTANT: on the OI build-up list, `pct` is the OI change, NOT the price move — each list's `pctMeans` says which.",
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        topN: { type: 'number', description: 'Names per list (default 10, max 24).' },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_symbol_snapshot',
    description:
      'Deep-dive ONE stock right now: live quote row (LTP, change from open, spread, order-book imbalance, ' +
      'futures OI + level vs 20-day avg, turnover, intraday OI build/urgency, R-Factor 1–10 with bias/confidence ' +
      'and per-factor breakdown), opening-range price action (above/below/inside the 09:15–09:45 range, day ' +
      'high/low from recorded 5-min bars), NSE combined futures+options OI change, and any /trade-suggest call ' +
      'made on it today. Post-market it returns the recorded closing snapshot (snapshot:true). Use for "how is ' +
      'X looking / should I still hold X / what changed on X" questions about a specific F&O stock.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'NSE symbol, e.g. "RELIANCE".' },
      },
      required: ['symbol'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_suggestion_performance',
    description:
      "Cross-day scorecard of the live suggester's own calls: hit-rate (moved ≥1% favorably before close), " +
      'average favorable/adverse spot excursions, and breakdowns by rank and score bucket, over reviewed ' +
      'suggestions in the trade_suggestions table. Use for "how are the calls doing / hit rate / is the ' +
      'suggester any good" questions. Small sample sizes (reviewed < 10) must be stated as too thin to judge.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Look-back window in days (default 30).' },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_eod_leaderboard',
    description:
      'End-of-day TF-style R-Factor leaderboard from the synced NSE bhavcopy (spread-linear model R = 1.56 × ' +
      "spread ratio, the parent-repo's best TradeFinder match), plus where that day's suggestions ranked on it " +
      '(suggestionRanks; null rank = did not make the board). turnoverRatio is context only — never part of the ' +
      'R score. Use for post-market review: "what would TF have ranked today / how did the picks sit vs the ' +
      'EOD board". Returns an error note if no bhavcopy is synced for the date.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Session date YYYY-MM-DD (default: latest synced bhavcopy).' },
        limit: { type: 'number', description: 'Rows to return (default 15).' },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_trade_context',
    description:
      'Get the full data-backed context for ONE trade: direction (price+OI quadrant), option OI buildup on the ' +
      'traded contract, futures OI level, turnover, P&L, and data coverage. ALWAYS call this before explaining a ' +
      'specific trade. Returns found:false with guidance if the symbol/date is not in the trade log.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Stock symbol, e.g. "PNBHOUSING".' },
        date: { type: 'string', description: 'Trade date, "YYYY-MM-DD" or "29 May 2026".' },
      },
      required: ['symbol', 'date'],
      additionalProperties: false,
    },
  },
];

/** Run a tool by name. Returns the data object plus a short trace summary for the UI. */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ result: unknown; trace: ToolTraceEntry }> {
  try {
    if (name === 'list_trades') {
      const result = await listTrades({
        verifiedOnly: Boolean(args.verifiedOnly),
        search: typeof args.search === 'string' ? args.search : undefined,
        limit: typeof args.limit === 'number' ? args.limit : undefined,
      });
      return {
        result,
        trace: { name, args, ok: true, summary: `Listed ${result.shown} of ${result.total} trades`, data: result },
      };
    }
    if (name === 'rank_trades') {
      const metric = args.metric === 'oi_level' || args.metric === 'pnl' ? args.metric : 'oi_buildup';
      const result = await rankTrades({
        metric,
        verifiedOnly: args.verifiedOnly !== false,
        limit: typeof args.limit === 'number' ? args.limit : undefined,
      });
      const label = metric === 'pnl' ? 'P&L' : metric === 'oi_level' ? 'OI level' : 'OI buildup';
      return {
        result,
        trace: { name, args, ok: true, summary: `Ranked top ${result.shown} of ${result.scopeCount} by ${label}`, data: result },
      };
    }
    if (name === 'get_live_suggestions') {
      const result = await runTradeSuggest(SELF_ORIGIN, { force: args.force === true });
      const summary =
        result.suggestions.length > 0 || result.scanned > 0
          ? `Live scan: ${result.suggestions.length} pick(s) from ${result.scanned} candidates`
          : (result.note ?? 'Outside the suggestion window');
      return { result, trace: { name, args, ok: result.success, summary, data: result } };
    }
    if (name === 'get_market_pulse') {
      const topN = typeof args.topN === 'number' ? Math.min(Math.max(Math.round(args.topN), 1), 24) : 10;
      const result = await getMarketPulse(topN);
      const total = result.lists.reduce((a, l) => a + l.names.length, 0);
      return {
        result,
        trace: {
          name,
          args,
          ok: true,
          summary: `Pulse: ${total} names across ${result.lists.length} lists (${result.marketOpen ? 'live' : 'last session'})`,
          data: result,
        },
      };
    }
    if (name === 'get_symbol_snapshot') {
      const result = await getSymbolSnapshot(String(args.symbol ?? ''));
      return {
        result,
        trace: {
          name,
          args,
          ok: result.found,
          summary: result.found
            ? `Snapshot ${result.symbol}: LTP ${result.quote?.ltp ?? '—'}, R ${result.quote?.rFactor ?? '—'} (${result.snapshot ? 'closing snapshot' : 'live'})`
            : `No data for ${result.symbol}: ${result.reason ?? 'unknown'}`,
          data: result,
        },
      };
    }
    if (name === 'get_suggestion_performance') {
      const days = typeof args.days === 'number' && args.days > 0 ? Math.round(args.days) : 30;
      const stats = await getStats(days);
      return {
        result: stats,
        trace: {
          name,
          args,
          ok: true,
          summary: `Stats ${days}d: ${stats.reviewed} reviewed, hit-rate ${stats.hitRatePct ?? '—'}%`,
          data: stats,
        },
      };
    }
    if (name === 'get_eod_leaderboard') {
      const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(Math.round(args.limit), 50) : 15;
      const board = await computeEodLeaderboard(typeof args.date === 'string' ? args.date : undefined, limit);
      if (!board) {
        const result = { error: 'No bhavcopy sessions synced — the EOD board needs the NSE EOD sync (banner on any page).' };
        return { result, trace: { name, args, ok: false, summary: 'EOD board unavailable (no bhavcopy synced)', data: result } };
      }
      return {
        result: board,
        trace: {
          name,
          args,
          ok: true,
          summary: `EOD board ${board.date}: top ${board.rows.length} of ${board.universe} names`,
          data: board,
        },
      };
    }
    if (name === 'get_trade_context') {
      const symbol = String(args.symbol ?? '');
      const date = String(args.date ?? '');
      const result = await getTradeContext(symbol, date);
      const ok = (result as { found?: boolean }).found !== false;
      return {
        result,
        trace: {
          name,
          args,
          ok,
          summary: ok ? `Loaded context for ${symbol} ${date}` : `No trade for ${symbol} ${date}`,
          data: result,
        },
      };
    }
    return {
      result: { error: `Unknown tool: ${name}` },
      trace: { name, args, ok: false, summary: `Unknown tool: ${name}` },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { result: { error: msg }, trace: { name, args, ok: false, summary: `Error: ${msg}` } };
  }
}
