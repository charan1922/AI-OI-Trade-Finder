import { NextResponse } from 'next/server';
import type { LiveUrgencyRow } from '@/app/live/_lib/types';
import { prisma } from '@/lib/db';
import { bestBidAsk, depthImbalance, dhanMarketFeed, isMarketHours, todayIST } from '@/lib/dhan/market-feed';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/live/quote
 * Body: { symbols?: string[] }
 *
 * Returns real-time bid/ask spread, order-book imbalance, live futures OI level
 * and turnover for a watchlist — the live "urgency" signal. Off-hours it returns
 * { marketOpen: false } and NO rows (the order book only exists when the market
 * is open — never synthesized).
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}) as { symbols?: unknown });
    const symbols: string[] = Array.isArray(body.symbols)
      ? (body.symbols as unknown[]).slice(0, 25).map((s) => String(s).toUpperCase())
      : [];

    // No hardcoded fallback basket — an empty watchlist returns empty rows
    // (the client builds its default via /api/live/sector-leaders).
    if (symbols.length === 0) {
      return NextResponse.json({ success: true, marketOpen: isMarketHours(), rows: [], symbols });
    }

    if (!isMarketHours()) {
      return NextResponse.json({ success: true, marketOpen: false, rows: [], symbols });
    }

    // Resolve equity + near-month futures security IDs DIRECTLY from
    // master_contracts. We deliberately do NOT use batchResolveFutures here:
    // its ensureSynced() gate throws unless the master was synced *today*, but
    // this simulator ships pre-loaded contracts with an older syncDate and has
    // no Master Contracts sync page. Equity IDs are stable, so a slightly stale
    // master still resolves them — and spread/imbalance come from equity depth.
    const eqRows = await prisma.masterContract.findMany({
      where: { symbol: { in: symbols }, segment: 'NSE_EQ' },
      select: { symbol: true, securityId: true },
    });
    const eqMap = new Map(eqRows.map((r) => [r.symbol, r.securityId]));

    const futRows = await prisma.masterContract.findMany({
      where: {
        underlying: { in: symbols },
        instrument: 'FUTSTK',
        segment: 'NSE_FNO',
        expiryDate: { gte: new Date() },
      },
      orderBy: { expiryDate: 'asc' },
      select: { underlying: true, securityId: true },
    });
    const futMap = new Map<string, { securityId: string }>();
    for (const r of futRows) {
      if (r.underlying && !futMap.has(r.underlying)) futMap.set(r.underlying, { securityId: r.securityId });
    }

    // One quote request covers the whole watchlist (equity for depth, futures for OI).
    const eqIds: number[] = [];
    const futIds: number[] = [];
    for (const s of symbols) {
      const eq = eqMap.get(s);
      if (eq) eqIds.push(Number(eq));
      const fut = futMap.get(s);
      if (fut) futIds.push(Number(fut.securityId));
    }
    const securities: Record<string, number[]> = {};
    if (eqIds.length) securities.NSE_EQ = eqIds;
    if (futIds.length) securities.NSE_FNO = futIds;

    const quotes = await dhanMarketFeed('quote', securities);
    const eqSeg = quotes.NSE_EQ ?? {};
    const futSeg = quotes.NSE_FNO ?? {};

    // 20-session futures-OI average per symbol (bhavcopy), for the OI-level ratio.
    const oiAvg = await futOiAverages(symbols);

    const rows: LiveUrgencyRow[] = symbols.map((s) => {
      const eqId = eqMap.get(s);
      const futId = futMap.get(s)?.securityId;
      const eqQ = eqId ? eqSeg[String(eqId)] : undefined;
      const futQ = futId ? futSeg[String(futId)] : undefined;

      const ba = bestBidAsk(eqQ);
      const imbalance = depthImbalance(eqQ);
      const ltp = eqQ?.last_price ?? null;
      const open = eqQ?.ohlc?.open ?? 0;
      const changePctOpen = ltp != null && open > 0 ? ((ltp - open) / open) * 100 : null;

      const futOi = futQ?.oi ?? null;
      const avg = oiAvg.get(s) ?? 0;
      const oiLevel = futOi != null && futOi > 0 && avg > 0 ? futOi / avg : null;
      const turnover =
        futQ?.average_price != null && futQ?.volume != null && futQ.average_price > 0
          ? futQ.average_price * futQ.volume
          : null;

      return {
        symbol: s,
        ltp,
        changePctOpen,
        bid: ba?.bid ?? null,
        ask: ba?.ask ?? null,
        spreadPct: ba?.spreadPct ?? null,
        imbalance,
        futOi,
        oiLevel,
        turnover,
        hasDepth: ba != null,
      };
    });

    return NextResponse.json({ success: true, marketOpen: true, asOf: new Date().toISOString(), date: todayIST(), rows, symbols });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}

/** Mean of the last 20 positive futOi values per symbol (newest sessions). */
async function futOiAverages(symbols: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (symbols.length === 0) return out;
  try {
    const placeholders = symbols.map(() => '?').join(',');
    const rows = await prisma.$queryRawUnsafe<{ symbol: string; futOi: number | null; date: string }[]>(
      `SELECT symbol, futOi, date FROM bhavcopy_days WHERE symbol IN (${placeholders}) ORDER BY date DESC`,
      ...symbols,
    );
    const bySymbol = new Map<string, number[]>();
    for (const r of rows) {
      const v = Number(r.futOi ?? 0);
      if (v <= 0) continue;
      const arr = bySymbol.get(r.symbol) ?? [];
      if (arr.length < 20) arr.push(v);
      bySymbol.set(r.symbol, arr);
    }
    for (const [sym, vals] of bySymbol) {
      if (vals.length >= 5) out.set(sym, vals.reduce((a, b) => a + b, 0) / vals.length);
    }
  } catch {
    // bhavcopy absent — OI level simply won't render
  }
  return out;
}
