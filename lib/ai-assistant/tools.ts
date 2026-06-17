/**
 * Function-calling tools for the assistant. Each tool has (1) a schema the model
 * sees and (2) an executor that returns REAL data from trade-data.ts. The model
 * never sees raw tables — it asks for data via these, keeping answers grounded.
 */

import type OpenAI from 'openai';
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
