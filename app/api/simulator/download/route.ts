import { NextResponse } from 'next/server';
import { MasterContractsNotSyncedError } from '@/lib/historify/master-contracts';
import { listDatasets, loadTimeline, resolveConfig, type SimulatorConfig } from '@/lib/simulator';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET → catalog of already-downloaded real datasets. */
export async function GET() {
  return NextResponse.json({ success: true, data: listDatasets() });
}

/**
 * POST → download exact real intraday data (with OI for F&O) from Dhan for a
 * particular F&O stock + date window, persist it to the on-disk cache, and
 * register it in the catalog so the simulator can replay it for backtesting.
 */
export async function POST(req: Request) {
  let body: Partial<SimulatorConfig>;
  try {
    body = (await req.json()) as Partial<SimulatorConfig>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  try {
    const config = resolveConfig(body);
    const { candles, config: resolved } = await loadTimeline(config);
    return NextResponse.json({
      success: true,
      data: {
        symbol: resolved.symbol,
        instrumentKind: resolved.instrumentKind,
        securityId: resolved.securityId,
        segment: resolved.segment,
        interval: resolved.interval,
        fromDate: resolved.fromDate,
        toDate: resolved.toDate,
        candles: candles.length,
        firstTime: candles[0]?.time ?? 0,
        lastTime: candles[candles.length - 1]?.time ?? 0,
      },
    });
  } catch (err) {
    if (err instanceof MasterContractsNotSyncedError) {
      return NextResponse.json({ error: err.message, code: 'MASTER_NOT_SYNCED' }, { status: 409 });
    }
    const message = (err as Error).message;

    // Dhan's charts endpoints need a paid Data API subscription on the account.
    if (/data api|not subscribed|DH-902|status 451/i.test(message)) {
      return NextResponse.json(
        {
          error:
            'Your Dhan account is not subscribed to Data APIs, which are required to download historical intraday candles. Subscribe to Dhan Data APIs, then retry.',
          detail: message,
          code: 'DATA_API_NOT_SUBSCRIBED',
        },
        { status: 402 },
      );
    }
    if (/auth|token|unauthor/i.test(message)) {
      return NextResponse.json({ error: message, code: 'DHAN_AUTH' }, { status: 502 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
