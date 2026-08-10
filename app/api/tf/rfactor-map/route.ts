import { NextResponse } from 'next/server';

import { getLatestTfRFactorBySymbol, type TfSymbolQuote } from '@/lib/tf-live/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The most recent successful all_sector capture, per symbol — LTP, previous
 *  close, % change and R-Factor, whatever date it was captured. Feeds the Live
 *  Urgency page's TF column AND the whole of /sector-scope, which renders from
 *  nothing else. One indexed row read plus a JSON.parse; never touches a
 *  broker, so it can't be slowed by the Dhan quote gate.
 *
 *  NOT admin-gated: /sector-scope is a viewer-visible page and this is now its
 *  only data source, so gating it would blank the page for viewers. It exposes
 *  the same TradeFinder board any signed-in user already sees rendered there,
 *  and no session/cookie material. */
export async function GET() {
  try {
    const { capturedAt, bySymbol } = await getLatestTfRFactorBySymbol();
    const values: Record<string, TfSymbolQuote> = {};
    for (const [symbol, v] of bySymbol) values[symbol] = v;
    return NextResponse.json({ success: true, capturedAt, values });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
