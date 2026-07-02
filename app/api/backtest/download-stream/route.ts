import { downloadEquity5min, downloadFutures5min, downloadOption5min } from '@/lib/backtest/data-downloader';
import { getTradeContract, upsertTradeContract } from '@/lib/backtest/backtest-store';
import { ensureSynced, forceSync, MasterContractsNotSyncedError } from '@/lib/historify/master-contracts';

export const dynamic = 'force-dynamic';

/**
 * POST /api/backtest/download-stream
 *
 * Streams download progress via SSE as symbols are downloaded.
 * Body: { symbols: { symbol, optionType, strike }[], fromDate, toDate }
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const items = (body.symbols ?? []) as {
    symbol: string;
    optionType: string;
    strike: number;
    date: string;
    spotPrice?: number;
  }[];

  if (!items.length) {
    return new Response(JSON.stringify({ error: 'No symbols provided' }), { status: 400 });
  }

  const encoder = new TextEncoder();
  // Set when the browser aborts the request (Cancel button / closed tab) — checked
  // between Dhan calls so the server stops working instead of downloading on.
  let clientGone = false;
  req.signal?.addEventListener('abort', () => {
    clientGone = true;
  });
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: Record<string, unknown>) => {
        if (clientGone) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          clientGone = true; // stream already cancelled mid-enqueue
        }
      };
      const close = () => {
        try {
          controller.close();
        } catch {
          /* already cancelled */
        }
      };

      let totalRows = 0;
      const errors: string[] = [];

      // Preserved contract IDs (from previous downloads) — keyed per item.
      // A fully-preserved item needs no master lookup at all, so a re-sync
      // keeps working even when the contract has left today's master.
      const preserved = await Promise.all(items.map((t) => getTradeContract(t.symbol, t.date, t.optionType, t.strike)));
      const allPreserved = preserved.every(
        (p, idx) => p?.eqSecurityId && p?.futSecurityId && (items[idx].strike <= 0 || p?.optSecurityId || p?.optVia),
      );

      // Instrument resolution needs today's master contracts. The user's
      // download click is the explicit trigger — sync Dhan's master CSV first
      // if stale, as a visible step (never silently). Skipped entirely when
      // every item resolves from preserved contract IDs.
      if (!allPreserved) {
        try {
          await ensureSynced();
        } catch (e) {
          if (e instanceof MasterContractsNotSyncedError) {
            try {
              send({ type: 'progress', step: 'master-sync', symbolIndex: 0, totalSymbols: items.length });
              const sync = await forceSync();
              send({ type: 'step-done', step: 'master-sync', rows: sync.count, symbolIndex: 0, totalSymbols: items.length });
            } catch (syncErr) {
              const msg = `Master contracts sync failed: ${(syncErr as Error).message}`;
              send({ type: 'error', step: 'master-sync', message: msg });
              send({ type: 'complete', totalRows: 0, errorCount: 1, errors: [msg] });
              close();
              return;
            }
          } else {
            throw e;
          }
        }
      }

      for (let i = 0; i < items.length; i++) {
        if (clientGone) break;
        const { symbol, optionType, strike, date, spotPrice } = items[i];
        const kept = preserved[i];
        // 45 calendar days back ≈ 30 trading sessions
        const from = new Date(date);
        from.setDate(from.getDate() - 45);
        const fromDate = from.toISOString().slice(0, 10);
        const toDate = date;

        // Equity
        try {
          send({ type: 'progress', symbol, step: 'equity', symbolIndex: i, totalSymbols: items.length });
          const result = await downloadEquity5min(symbol, fromDate, toDate, {
            securityId: kept?.eqSecurityId ?? undefined,
          });
          if (result.error) throw new Error(result.error);
          totalRows += result.rows;
          if (result.securityId) {
            await upsertTradeContract(symbol, date, optionType, strike, { eqSecurityId: result.securityId });
          }
          send({
            type: 'step-done',
            symbol,
            step: 'equity',
            rows: result.rows,
            symbolIndex: i,
            totalSymbols: items.length,
          });
        } catch (e) {
          const msg = `${symbol} equity: ${(e as Error).message}`;
          errors.push(msg);
          send({ type: 'error', symbol, step: 'equity', message: msg });
        }

        // Futures
        if (clientGone) break;
        try {
          send({ type: 'progress', symbol, step: 'futures', symbolIndex: i, totalSymbols: items.length });
          const result = await downloadFutures5min(symbol, fromDate, toDate, {
            securityId: kept?.futSecurityId ?? undefined,
            expiry: kept?.futExpiry ?? undefined,
            lotSize: kept?.futLotSize ?? undefined,
          });
          if (result.error) throw new Error(result.error);
          totalRows += result.rows;
          if (result.securityId) {
            await upsertTradeContract(symbol, date, optionType, strike, {
              futSecurityId: result.securityId,
              futExpiry: result.expiry,
              futLotSize: result.lotSize,
            });
          }
          send({
            type: 'step-done',
            symbol,
            step: 'futures',
            rows: result.rows,
            symbolIndex: i,
            totalSymbols: items.length,
          });
        } catch (e) {
          const msg = `${symbol} futures: ${(e as Error).message}`;
          errors.push(msg);
          send({ type: 'error', symbol, step: 'futures', message: msg });
        }

        // Options (if strike > 0)
        if (clientGone) break;
        if (strike > 0) {
          try {
            send({ type: 'progress', symbol, step: 'options', symbolIndex: i, totalSymbols: items.length });
            const result = await downloadOption5min(symbol, optionType as 'CE' | 'PE', strike, fromDate, toDate, {
              spotPrice,
              securityId: kept?.optSecurityId ?? undefined,
            });
            if (result.error) throw new Error(result.error);
            totalRows += result.rows;
            await upsertTradeContract(symbol, date, optionType, strike, {
              optSecurityId: result.securityId,
              optVia: result.via,
            });
            send({
              type: 'step-done',
              symbol,
              step: 'options',
              rows: result.rows,
              symbolIndex: i,
              totalSymbols: items.length,
            });
          } catch (e) {
            const msg = `${symbol} ${optionType} ${strike}: ${(e as Error).message}`;
            errors.push(msg);
            send({ type: 'error', symbol, step: 'options', message: msg });
          }
        }

        send({ type: 'symbol-done', symbol, symbolIndex: i, totalSymbols: items.length, totalRows });
      }

      // Bhavcopy leg — the OI charts' source: market-wide NSE end-of-day totals
      // (futures OI across all contracts, option OI across all strikes) PLUS each
      // TF-traded strike's own close/OI (what the option-flow read needs). A
      // SEPARATE source from the Dhan legs above, but the user shouldn't have to
      // think about that — one "Get all data" click fills them all. Idempotent: only
      // dates not already on disk are fetched, so it's cheap on repeat and the
      // shared dataset tops up for every trade at once.
      if (!clientGone) {
        try {
          send({ type: 'progress', step: 'bhavcopy', symbolIndex: items.length - 1, totalSymbols: items.length });
          const { syncBhavcopy } = await import('@/lib/historify/bhavcopy-service');
          const { tradedStrikeKeys } = await import('@/lib/backtest/data-downloader');
          // Weekdays from the earliest item's window-start (trade date − 45d)
          // through today, so every downloaded trade's lookback is covered.
          const earliest = items.map((it) => it.date).sort()[0];
          const winStart = new Date(earliest);
          winStart.setDate(winStart.getDate() - 45);
          let weekdays = 0;
          const cur = new Date(winStart);
          const today = new Date();
          while (cur <= today) {
            const dow = cur.getDay();
            if (dow !== 0 && dow !== 6) weekdays++;
            cur.setDate(cur.getDate() + 1);
          }
          const days = Math.min(400, weekdays + 5); // buffer + ~18-month safety cap
          // Capture the TF-traded strikes' daily close/OI on this path too, so the
          // option-flow read is populated whether the user synced from here or from
          // the data-downloader's own "Sync NSE data" button (consistent either way).
          const wantedStrikes = await tradedStrikeKeys();
          const result = await syncBhavcopy(days, { wantedStrikes });
          totalRows += result.rows;
          send({
            type: 'step-done',
            step: 'bhavcopy',
            rows: result.rows,
            symbolIndex: items.length - 1,
            totalSymbols: items.length,
          });
        } catch (e) {
          const msg = `Bhavcopy sync: ${(e as Error).message}`;
          errors.push(msg);
          send({ type: 'error', step: 'bhavcopy', message: msg });
        }
      }

      send({ type: 'complete', totalRows, errorCount: errors.length, errors: errors.slice(0, 20) });
      close();
    },
    cancel() {
      clientGone = true;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
