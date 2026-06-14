import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

import { getDailyContext, getTradeDetail, runFullBacktest, simulateTrade } from '@/lib/backtest/backtest-evaluator';
import { downloadAllTFData, downloadSymbols, loadAllTFTrades, TF_TRADES } from '@/lib/backtest/data-downloader';
import {
  getBhavcopyDateMap,
  getOptionDateMap,
  getRowCount,
  getSymbolDateMap,
  getTradeContract,
} from '@/lib/backtest/backtest-store';
import type { FixAction, LegCoverage } from '@/app/data-downloader/_lib/types';

/**
 * POST /api/backtest/tf-validate
 *
 * Downloads 5-min data for all 20 TF trade stocks and runs backtest.
 * Body: { action: 'download' | 'status' | 'backtest' }
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action ?? 'status';

    if (action === 'download') {
      const logs: string[] = [];
      const result = await downloadAllTFData((msg) => {
        logs.push(msg);
        console.log(`[TF Backtest] ${msg}`);
      });

      return NextResponse.json({
        success: true,
        action: 'download',
        totalRows: result.total,
        errors: result.errors,
        logs,
      });
    }

    if (action === 'status') {
      const equityRows = await getRowCount('backtest_equity');
      const futuresRows = await getRowCount('backtest_futures');
      const optionsRows = await getRowCount('backtest_options');

      return NextResponse.json({
        success: true,
        action: 'status',
        data: {
          equityRows,
          futuresRows,
          optionsRows,
          totalRows: equityRows + futuresRows + optionsRows,
          trades: TF_TRADES.length,
          uniqueSymbols: [...new Set(TF_TRADES.map((t) => t.symbol))].length,
        },
      });
    }

    if (action === 'backtest') {
      console.log('[TF Backtest] Running full backtest...');
      const { results, summary } = await runFullBacktest();
      return NextResponse.json({
        success: true,
        action: 'backtest',
        results,
        summary,
      });
    }

    if (action === 'all-tf-trades') {
      // Load ALL trades from tradefinder_platform_trades.json
      const allTF = await loadAllTFTrades();
      // Check which symbols are already downloaded
      const downloadedSymbols = new Set<string>();
      for (const sym of allTF.symbols) {
        const count = await getRowCount('backtest_equity', sym);
        if (count > 0) downloadedSymbols.add(sym);
      }
      return NextResponse.json({
        success: true,
        totalTrades: allTF.trades.length,
        totalSymbols: allTF.symbols.length,
        downloadedSymbols: downloadedSymbols.size,
        missingSymbols: allTF.symbols.filter((s) => !downloadedSymbols.has(s)).length,
        dateRange: allTF.dateRange,
        symbols: allTF.symbols.map((s) => ({
          symbol: s,
          downloaded: downloadedSymbols.has(s),
          trades: allTF.trades.filter((t) => t.symbol === s).length,
        })),
      });
    }

    if (action === 'symbol-status') {
      const allTF = await loadAllTFTrades();
      // Batch: pull symbol→dates for every source ONCE (not per trade), then check
      // window coverage in memory. Bhavcopy is a separate source (Sync button) from
      // the Dhan legs (Download button) — both are reported so the gap says which.
      const [eqMap, futMap, optMap, bhavMap] = await Promise.all([
        getSymbolDateMap('backtest_equity'),
        getSymbolDateMap('backtest_futures'),
        getOptionDateMap(),
        getBhavcopyDateMap(),
      ]);

      // ~30 sessions of lookback ≈ 45 calendar days — matches the downloader window.
      const WINDOW_DAYS = 45;
      const datesInWindow = (dates: Set<string> | undefined, from: string, to: string): string[] => {
        if (!dates) return [];
        // Date strings are YYYY-MM-DD, so lexical comparison is chronological.
        const out: string[] = [];
        for (const d of dates) if (d >= from && d <= to) out.push(d);
        return out;
      };

      let readyCount = 0;
      let partialCount = 0;
      let missingCount = 0;
      const trades = allTF.trades.map((t) => {
        const from = new Date(t.date);
        from.setDate(from.getDate() - WINDOW_DAYS);
        const windowStart = from.toISOString().slice(0, 10);
        const windowEnd = t.date;

        const eqDates = datesInWindow(eqMap.get(t.symbol), windowStart, windowEnd);
        const futDates = datesInWindow(futMap.get(t.symbol), windowStart, windowEnd);
        const bhavDates = datesInWindow(bhavMap.get(t.symbol), windowStart, windowEnd);
        // Honest denominator: sessions we have any DISPLAYED data for. Only equity
        // (Dhan) and bhavcopy feed the charts — Dhan single-contract futures only
        // yields futClose/futVolume, neither of which is charted (the Futures OI &
        // Turnover charts use bhavcopy totals across ALL contracts). So Dhan futures
        // is excluded from the denominator and is NOT a tracked leg below.
        const sessionsKnown = new Set<string>([...eqDates, ...bhavDates]).size;
        // A few sessions Dhan/NSE simply don't serve (e.g. a contract that didn't
        // trade that day) are UNFILLABLE — re-downloading can't recover them. So
        // near-complete coverage reads as 'ok', not a permanent warning the user
        // can never clear. The detail panel's CalendarNote still lists exact gaps.
        const gapTolerance = Math.max(1, Math.floor(sessionsKnown * 0.1));

        const cov = (
          key: LegCoverage['key'],
          short: string,
          label: string,
          present: number,
          fixedBy: FixAction,
        ): LegCoverage => ({
          key,
          short,
          label,
          daysPresent: present,
          sessionsKnown,
          status: present === 0 ? 'missing' : sessionsKnown - present <= gapTolerance ? 'ok' : 'partial',
          fixedBy,
          applicable: true,
        });

        // Traded option (single strike, Dhan): powers the trade-day premium + flow,
        // so it's a trade-DAY presence check, not window coverage.
        const hasOptDay =
          t.strike > 0 && (optMap.get(`${t.symbol}|${t.optionType}|${t.strike}`)?.has(t.date) ?? false);

        const legs: LegCoverage[] = [
          cov('equity', 'EQ', 'Equity (Dhan)', eqDates.length, 'download'),
          cov('bhavcopy', 'OI', 'Futures + Option OI (NSE bhavcopy)', bhavDates.length, 'sync'),
          {
            key: 'tradedOption',
            short: 'OPT',
            label: 'Traded option (Dhan)',
            daysPresent: hasOptDay ? 1 : 0,
            sessionsKnown: 1,
            status: t.strike > 0 ? (hasOptDay ? 'ok' : 'missing') : 'ok',
            fixedBy: 'download',
            applicable: t.strike > 0,
          },
        ];

        const applicable = legs.filter((l) => l.applicable);
        const status: 'ready' | 'partial' | 'missing' = applicable.every((l) => l.status === 'ok')
          ? 'ready'
          : applicable.every((l) => l.status === 'missing')
            ? 'missing'
            : 'partial';
        if (status === 'ready') readyCount++;
        else if (status === 'partial') partialCount++;
        else missingCount++;

        return {
          symbol: t.symbol,
          date: t.date,
          optionType: t.optionType,
          strike: t.strike,
          spotPrice: t.spotPrice,
          pnl: t.pnl,
          humanReview: t.humanReview ?? false,
          entryTime: t.entryTime,
          entryPrice: t.entryPrice,
          exitTime: t.exitTime,
          exitPrice: t.exitPrice,
          quantity: t.quantity,
          expiry: t.expiry,
          // Back-compat booleans — leg present anywhere in the window.
          hasEquity: eqDates.length > 0,
          hasFutures: futDates.length > 0,
          hasOptions: t.strike > 0 ? hasOptDay : true,
          legs,
          status,
        };
      });
      return NextResponse.json({
        success: true,
        trades,
        summary: { totalTrades: trades.length, readyCount, partialCount, missingCount, dateRange: allTF.dateRange },
      });
    }

    if (action === 'download-symbols') {
      // Download specific symbols: { symbols: string[], fromDate, toDate, options?: [...] }
      const symbols = body.symbols as string[];
      const fromDate = body.fromDate ?? '2024-12-01';
      const toDate = body.toDate ?? '2026-03-22';
      const options = body.options ?? [];
      if (!symbols || symbols.length === 0) {
        return NextResponse.json({ success: false, error: 'No symbols provided' }, { status: 400 });
      }
      const logs: string[] = [];
      const result = await downloadSymbols(symbols, fromDate, toDate, options, (msg) => {
        logs.push(msg);
        console.log(`[TF Download] ${msg}`);
      });
      return NextResponse.json({ success: true, ...result, logs });
    }

    if (action === 'download-all-tf') {
      // Download ALL 158 TF symbols (equity + futures)
      const allTF = await loadAllTFTrades();
      // Filter out already downloaded
      const downloadedSymbols = new Set<string>();
      for (const sym of allTF.symbols) {
        const count = await getRowCount('backtest_equity', sym);
        if (count > 0) downloadedSymbols.add(sym);
      }
      const missing = allTF.symbols.filter((s) => !downloadedSymbols.has(s));
      if (missing.length === 0) {
        return NextResponse.json({ success: true, message: 'All symbols already downloaded', totalRows: 0 });
      }

      // Build options list from trades
      const optionsList = allTF.trades
        .filter((t) => t.strike > 0 && missing.includes(t.symbol))
        .map((t) => ({ symbol: t.symbol, optionType: t.optionType, strike: t.strike, spotPrice: t.spotPrice }));
      // Dedupe — one option per symbol
      const optionsMap = new Map<string, (typeof optionsList)[0]>();
      for (const o of optionsList) {
        if (!optionsMap.has(o.symbol)) optionsMap.set(o.symbol, o);
      }

      const logs: string[] = [];
      const result = await downloadSymbols(
        missing,
        allTF.dateRange.from,
        allTF.dateRange.to,
        Array.from(optionsMap.values()),
        (msg) => {
          logs.push(msg);
          console.log(`[TF Download] ${msg}`);
        },
      );
      return NextResponse.json({ success: true, downloaded: missing.length, ...result, logs });
    }

    if (action === 'trade-detail') {
      const detail = await getTradeDetail({
        symbol: body.symbol,
        date: body.date,
        optionType: body.optionType,
        strike: body.strike,
        spotPrice: body.spotPrice,
        tfPnl: body.tfPnl,
        tfExpiry: body.tfExpiry,
        tfEntryTime: body.entryTime,
        tfEntryPrice: body.entryPrice,
        tfExitTime: body.exitTime,
        tfExitPrice: body.exitPrice,
        tfQuantity: body.quantity,
      });
      return NextResponse.json({ success: true, detail });
    }

    if (action === 'trade-context') {
      const context = await getDailyContext({
        symbol: body.symbol,
        date: body.date,
        optionType: body.optionType,
        strike: body.strike,
        days: body.days ?? 30,
        expiry: body.expiry,
      });
      // Preserved Dhan contract IDs from download time — shown in the UI and
      // reused on re-sync (no fresh master lookup needed).
      const contracts = await getTradeContract(body.symbol, body.date, body.optionType, body.strike);
      return NextResponse.json({ success: true, context, contracts });
    }

    if (action === 'simulate') {
      const result = await simulateTrade({
        symbol: body.symbol,
        date: body.date,
        optionType: body.optionType,
        strike: body.strike,
        entryTimestamp: body.entryTimestamp,
        exitTimestamp: body.exitTimestamp,
        tfPnl: body.tfPnl,
      });
      return NextResponse.json({ success: true, result });
    }

    if (action === 'tf-trades-list') {
      const allTF = await loadAllTFTrades();
      // Check data availability per trade (quick count)
      const tradesWithStatus = await Promise.all(
        allTF.trades.slice(0, 100).map(async (t) => {
          const count = await getRowCount('backtest_options', t.symbol);
          return { ...t, hasData: count > 0 };
        }),
      );
      return NextResponse.json({ success: true, trades: tradesWithStatus, total: allTF.trades.length });
    }

    if (action === 'debug') {
      const { queryRows: qr } = await import('@/lib/backtest/backtest-store');
      const eqDates = await qr(
        "SELECT DISTINCT symbol, date FROM backtest_equity WHERE symbol='NATIONALUM' ORDER BY date DESC LIMIT 5",
      );
      const optDates = await qr(
        "SELECT DISTINCT symbol, option_type, date FROM backtest_options WHERE symbol='NATIONALUM' ORDER BY date DESC LIMIT 5",
      );
      const sample = await qr(
        "SELECT symbol, date, timestamp, close FROM backtest_equity WHERE symbol='NATIONALUM' ORDER BY timestamp DESC LIMIT 3",
      );
      return NextResponse.json({ success: true, eqDates, optDates, sample });
    }

    return NextResponse.json({ success: false, error: `Unknown action: ${action}` }, { status: 400 });
  } catch (error) {
    console.error('[TF Backtest] Error:', error);
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}

/**
 * GET /api/backtest/tf-validate
 *
 * Returns current status of downloaded data.
 */
export async function GET() {
  try {
    const equityRows = await getRowCount('backtest_equity');
    const futuresRows = await getRowCount('backtest_futures');
    const optionsRows = await getRowCount('backtest_options');

    return NextResponse.json({
      success: true,
      data: {
        equityRows,
        futuresRows,
        optionsRows,
        totalRows: equityRows + futuresRows + optionsRows,
        hasData: equityRows > 0,
        trades: TF_TRADES,
      },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
