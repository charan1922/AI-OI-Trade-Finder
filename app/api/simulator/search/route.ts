import { NextResponse } from 'next/server';
import { MasterContractsNotSyncedError, searchSymbols } from '@/lib/historify/master-contracts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/simulator/search?q=REL → symbol suggestions for the picker. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = (url.searchParams.get('q') ?? '').trim();
  if (q.length < 1) {
    return NextResponse.json({ success: true, data: [] });
  }

  try {
    const results = await searchSymbols(q, 'NSE');
    return NextResponse.json({
      success: true,
      data: results.map((r) => ({ symbol: r.symbol, name: r.name, securityId: r.securityId })),
    });
  } catch (err) {
    if (err instanceof MasterContractsNotSyncedError) {
      return NextResponse.json({ error: err.message, code: 'MASTER_NOT_SYNCED' }, { status: 409 });
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
