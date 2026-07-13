import { NextResponse } from 'next/server';
import { getDhanTokenStatus, hasDhanAuth } from '@/lib/dhan/auth';
import { prisma } from '@/lib/db';
import { dhanMarketFeed, isMarketHours } from '@/lib/dhan/market-feed';
import { getFyersPollerStatus } from '@/lib/fyers/poller';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_CREDS =
  'No Dhan credentials configured. Set DHAN_PIN + DHAN_TOTP_SECRET (for TOTP auto-generation), or DHAN_ACCESS_TOKEN.';

/**
 * GET /api/dhan/status — STRICTLY PASSIVE Dhan status for the /dhan panel's
 * 10s poll: in-memory token state + the poller's pre-open warm-up outcome. No
 * external call, no DB, and — unlike GET /api/dhan/token — NO token-generation
 * side effect, so polling it never spends quota or mints tokens.
 */
export function GET(): Response {
  return NextResponse.json({
    success: true,
    marketOpen: isMarketHours(),
    configured: hasDhanAuth(),
    token: getDhanTokenStatus(),
    lastWarmup: getFyersPollerStatus().lastWarmup,
  });
}

/** RELIANCE NSE_EQ — Dhan's stable well-known id, the master-contracts fallback. */
const RELIANCE_FALLBACK_ID = 2885;

/**
 * POST /api/dhan/status — body { action: 'test-call' }: prove the token works
 * end-to-end with ONE real quote (RELIANCE equity) through the normal
 * rate-gated dhanMarketFeed path. Works off-hours too (returns the last
 * session's close). On a 400/401 dhanMarketFeed itself clears the cached token,
 * so a failed test also self-heals the cache for the next attempt. Mutating →
 * rbac default-denies to 'app:write' (admin-only), which is right for a
 * quota-spending action.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { action?: string };
  if (body.action !== 'test-call') {
    return NextResponse.json({ success: false, error: "action must be 'test-call'" }, { status: 400 });
  }
  if (!hasDhanAuth()) {
    return NextResponse.json({ success: false, configured: false, error: NO_CREDS }, { status: 400 });
  }
  try {
    const row = await prisma.masterContract
      .findFirst({ where: { symbol: 'RELIANCE', segment: 'NSE_EQ' }, select: { securityId: true } })
      .catch(() => null);
    const id = Number(row?.securityId ?? RELIANCE_FALLBACK_ID);
    const t0 = Date.now();
    const quotes = await dhanMarketFeed('quote', { NSE_EQ: [id] });
    const ltp = quotes.NSE_EQ?.[String(id)]?.last_price ?? null;
    return NextResponse.json({
      success: ltp != null,
      symbol: 'RELIANCE',
      ltp,
      tookMs: Date.now() - t0,
      at: new Date().toISOString(),
      error:
        ltp == null
          ? 'no data returned — token invalid/expired, Dhan rate-limit cooldown, or empty feed (token cache self-heals on auth errors; retry in ~1 min)'
          : undefined,
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 502 });
  }
}
