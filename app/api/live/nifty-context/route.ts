import { NextResponse } from 'next/server';
import { getCachedNiftyGammaContext } from '@/lib/signals/nifty-gamma-context';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Cached, display-only NIFTY option-chain context for /live. */
export async function GET() {
  try {
    const context = getCachedNiftyGammaContext();
    const data = context
      ? {
          expiry: context.expiry,
          spot: context.spot,
          lotSize: context.lotSize,
          capturedAt: context.capturedAt,
          proxy: {
            balance: context.proxy.balance,
            netSharePct: context.proxy.netSharePct,
            concentrationStrike: context.proxy.concentrationStrike,
            label: context.proxy.label,
          },
        }
      : null;
    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.warn('[Nifty context] unavailable:', (error as Error).message);
    return NextResponse.json({ success: true, data: null });
  }
}
