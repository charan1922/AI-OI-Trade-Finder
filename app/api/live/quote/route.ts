import { NextResponse } from 'next/server';
import type { LiveUrgencyRow } from '@/app/live/_lib/types';
import { prisma } from '@/lib/db';
import { bestBidAsk, depthImbalance, dhanMarketFeed, isMarketHours, todayIST } from '@/lib/dhan/market-feed';
import { computeRFactor } from '@/lib/r-factor';
import { addToUniverse } from '@/lib/fyers/symbols';
import { computeOiUrgency, getIntradaySeriesForSymbols, recordIntradayOi } from '@/lib/signals/oi-intraday';
import { evaluateBreakout } from '@/lib/breakout';
import { ensureBreakoutContext, getBreakoutContext } from '../_lib/breakout-context';
import { buildClosingSnapshot } from '../_lib/closing-snapshot';
import { classifyFno, excludeReasonLabel, loadFnoUniverse } from '../_lib/fno-universe';
import { ensureMorningContext, getMorningContext } from '../_lib/morning-candles';
import { buildLiveRFactorInput } from '../_lib/rfactor-inputs';
import { loadRFactorBaselines } from '../_lib/rfactor-baselines';

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
    // A section's whole symbol list is quoted in ONE batched Dhan request (built
    // below), so list size never multiplies Dhan calls. The /live page issues one
    // such request per category section, serialized client-side to ≤1 req/sec. This
    // generous guard only stops a pathological input from ballooning a batch
    // (≤200 symbols ≈ ≤400 instruments, well under Dhan's per-request limit).
    const symbols: string[] = Array.isArray(body.symbols)
      ? (body.symbols as unknown[]).slice(0, 200).map((s) => String(s).toUpperCase())
      : [];

    // No hardcoded fallback basket — an empty watchlist returns empty rows (each
    // /live section builds its own list via /api/live/nse-watchlist).
    if (symbols.length === 0) {
      return NextResponse.json({ success: true, marketOpen: isMarketHours(), rows: [], symbols });
    }

    if (!isMarketHours()) {
      // Post-market: serve the last RECORDED state of the most recent session
      // (oi_intraday + Fyers bars) so the page keeps showing that day's numbers
      // until the next open. Falls back to the old empty response when nothing
      // was recorded (e.g. fresh install).
      const snap = await buildClosingSnapshot(symbols);
      if (snap) return NextResponse.json(snap);
      return NextResponse.json({ success: true, marketOpen: false, rows: [], symbols });
    }

    // Live Urgency is F&O-only and never shows the 'avoid' lot-size band. Drop
    // anything that isn't a tradeable F&O name (covers manual entries too) and
    // report what was removed, so the watchlist shrinks visibly, never silently.
    const fno = await loadFnoUniverse(symbols);
    const excluded: { symbol: string; reason: string }[] = [];
    const allowed: string[] = [];
    for (const s of symbols) {
      const cls = classifyFno(fno.get(s));
      if (cls.ok) allowed.push(s);
      else excluded.push({ symbol: s, reason: excludeReasonLabel(cls.reason ?? 'not-fno') });
    }
    if (allowed.length === 0) {
      return NextResponse.json({ success: true, marketOpen: true, rows: [], symbols: allowed, excluded });
    }

    // Resolve equity + near-month futures security IDs DIRECTLY from
    // master_contracts. We deliberately do NOT use batchResolveFutures here:
    // its ensureSynced() gate throws unless the master was synced *today*, but
    // this simulator ships pre-loaded contracts with an older syncDate and has
    // no Master Contracts sync page. Equity IDs are stable, so a slightly stale
    // master still resolves them — and spread/imbalance come from equity depth.
    const eqRows = await prisma.masterContract.findMany({
      where: { symbol: { in: allowed }, segment: 'NSE_EQ' },
      select: { symbol: true, securityId: true },
    });
    const eqMap = new Map(eqRows.map((r) => [r.symbol, r.securityId]));

    const futRows = await prisma.masterContract.findMany({
      where: {
        underlying: { in: allowed },
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
    for (const s of allowed) {
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

    // Per-symbol bhavcopy baselines (20d OI/turnover averages, prev-day OI,
    // prior-day high/low/close) — the fixed EOD anchors the live R-Factor scores
    // against. One query for the whole watchlist.
    const baselines = await loadRFactorBaselines(allowed);

    const today = todayIST();
    const now = new Date();
    const rows: LiveUrgencyRow[] = allowed.map((s) => {
      const eqId = eqMap.get(s);
      const futId = futMap.get(s)?.securityId;
      const eqQ = eqId ? eqSeg[String(eqId)] : undefined;
      const futQ = futId ? futSeg[String(futId)] : undefined;

      const ba = bestBidAsk(eqQ);
      const imbalance = depthImbalance(eqQ);
      const ltp = eqQ?.last_price ?? null;
      const open = eqQ?.ohlc?.open ?? 0;
      const changePctOpen = ltp != null && open > 0 ? ((ltp - open) / open) * 100 : null;

      const base = baselines.get(s);
      const futOi = futQ?.oi ?? null;
      const avg = base?.futOi20dAvg ?? 0;
      const oiLevel = futOi != null && futOi > 0 && avg > 0 ? futOi / avg : null;
      const turnover =
        futQ?.average_price != null && futQ?.volume != null && futQ.average_price > 0
          ? futQ.average_price * futQ.volume
          : null;

      // R-Factor: score the live snapshot against the baselines + whatever morning
      // context is already cached (opening-range breakout). Candles are warmed only
      // for the top-N by R-Factor below — NOT per displayed stock — so candle load
      // stays bounded regardless of universe size.
      const rf = buildLiveRFactorInput(
        {
          symbol: s,
          ltp,
          changePctOpen,
          bid: ba?.bid ?? null,
          ask: ba?.ask ?? null,
          futOi,
          turnover,
          dayHigh: eqQ?.ohlc?.high ?? null,
          dayLow: eqQ?.ohlc?.low ?? null,
        },
        base,
        getMorningContext(s),
        now,
      );
      const r = rf ? computeRFactor(rf) : null;

      // TradeFinder breakout: FAST half — live LTP + live R-Factor against the
      // 5-min-cached morning-test + level ladder. Null until the symbol's
      // candles are recorded (never fabricated). Context warms below.
      const breakout = evaluateBreakout(getBreakoutContext(s), ltp, r?.rFactor ?? null, changePctOpen);

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
        sessionOiChangePct: null,
        oiVelocity: null,
        oiAccel: null,
        oiUrgency: null,
        rFactor: r?.rFactor ?? null,
        rFactorBias: r?.bias ?? null,
        rFactorConfidence: r?.confidence ?? null,
        rFactorAfterEntry: r?.afterEntryWindow ?? null,
        rFactors: r?.factors.map((f) => ({ label: f.label, score: f.score, vote: f.vote, available: f.available, detail: f.detail })) ?? null,
        breakout,
      };
    });

    // Enroll the whole watchlist in the Fyers download universe (fire-and-forget):
    // fyers_candles is the candle source now, and the next 5-min Fyers cycle
    // backfills any newly-seen symbol's full-day series.
    void addToUniverse(allowed, today);

    // Warm the morning-candle context (opening-range breakout reference) for ONLY
    // the top-N names by R-Factor — a fixed cost regardless of how many stocks are
    // displayed. The rest keep using prior-day high/low. Fire-and-forget; the
    // opening range populates once the Fyers poller has recorded the symbol
    // (R-Factor never blocks on candles). ensureMorningContext de-dupes across
    // sections (shared per-day cache) and no-ops when fresh/in-flight.
    const WARM_TOP_N = 12;
    [...rows]
      .filter((r) => r.rFactor != null)
      .sort((a, b) => (b.rFactor ?? 0) - (a.rFactor ?? 0))
      .slice(0, WARM_TOP_N)
      .forEach((r) => ensureMorningContext(r.symbol));

    // Warm the TF breakout context for EVERY displayed symbol (fire-and-forget,
    // local SQLite only, per-symbol 5-min refresh cap — see breakout-context.ts
    // for why this warm is wider than the morning-context one).
    for (const s of allowed) ensureBreakoutContext(s, baselines.get(s));

    // Persist this poll into the per-day OI series, then derive intraday urgency
    // (rate of OI build) from the trailing points. Best-effort: a storage hiccup
    // must never break the live quote response.
    try {
      await recordIntradayOi(
        today,
        rows.map((r) => ({
          symbol: r.symbol,
          ltp: r.ltp,
          futOi: r.futOi,
          futOiAvg20d: baselines.get(r.symbol)?.futOi20dAvg ?? null,
          oiLevel: r.oiLevel,
          futTurnover: r.turnover,
          changePctOpen: r.changePctOpen,
          spreadPct: r.spreadPct,
          imbalance: r.imbalance,
        })),
      );
      const seriesMap = await getIntradaySeriesForSymbols(today, allowed);
      for (const r of rows) {
        const u = computeOiUrgency(seriesMap.get(r.symbol) ?? []);
        if (u.ok) {
          r.sessionOiChangePct = u.sessionOiChangePct;
          r.oiVelocity = u.oiVelocity;
          r.oiAccel = u.oiAccel;
          r.oiUrgency = u.urgencyScore;
        }
      }
    } catch (e) {
      console.warn('[live/quote] intraday OI capture failed:', (e as Error).message);
    }

    return NextResponse.json({
      success: true,
      marketOpen: true,
      asOf: new Date().toISOString(),
      date: today,
      rows,
      symbols: allowed,
      excluded,
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
