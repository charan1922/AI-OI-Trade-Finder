import { NextResponse } from 'next/server';

import { adminOnly } from '@/lib/auth/server';
import { getLatestTfRFactorBySymbol } from '@/lib/tf-live/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Lightweight lookup for the Live Urgency page's TF column — the most recent
 *  successful all_sector capture's per-symbol R-Factor/%/prev-close, whatever
 *  date that was. Never blocks or slows the live quote path: this is a
 *  separate, independent read. */
export async function GET(req: Request) {
  const denied = adminOnly(req);
  if (denied) return denied;
  try {
    const { capturedAt, bySymbol } = await getLatestTfRFactorBySymbol();
    const values: Record<string, { rFactor: number | null; pctChange: number | null; previousClose: number | null }> = {};
    for (const [symbol, v] of bySymbol) values[symbol] = v;
    return NextResponse.json({ success: true, capturedAt, values });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
