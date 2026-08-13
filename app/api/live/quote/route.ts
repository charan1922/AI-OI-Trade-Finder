import { NextResponse } from 'next/server';
import type { LiveUrgencyRow } from '@/app/live/_lib/types';
import { prisma } from '@/lib/db';
import { bestBidAsk, depthImbalance, dhanMarketFeed, isMarketHours, todayIST } from '@/lib/dhan/market-feed';
import { approximateTfRFactor, computeRFactor } from '@/lib/r-factor';
import { getNseOiLatestForSymbols } from '@/lib/fyers/candle-store';
import { getNseOiRowMap, LIVE_PATH_NSE_WAIT_MS } from '@/lib/nse/combined-oi';
import type { OiStock } from '@/lib/nse/pulse';
import { addToUniverse } from '@/lib/fyers/symbols';
import {
  changeSinceEntryWindow,
  computeOiUrgency,
  getIntradaySeriesForSymbols,
  recordIntradayOi,
} from '@/lib/signals/oi-intraday';
import { evaluateBreakout } from '@/lib/breakout';
import { ensureBreakoutContext, getBreakoutContext } from '../_lib/breakout-context';
import { buildClosingSnapshot } from '../_lib/closing-snapshot';
import { classifyFno, excludeReasonLabel, loadFnoUniverse } from '../_lib/fno-universe';
import { ensureMorningContext, getMorningContext } from '../_lib/morning-candles';
import { cachedQuoteResponse } from '../_lib/quote-response-cache';
import { buildLiveRFactorInput, MIN_SESSION_FRACTION, sessionFractionElapsed } from '../_lib/rfactor-inputs';
import { loadRFactorBaselines } from '../_lib/rfactor-baselines';
import { scheduleOptionEvidenceShadow } from '@/lib/option-chain';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/live/quote
 * Body: { symbols?: string[], fresh?: boolean }
 *
 * Returns real-time bid/ask spread, order-book imbalance, live futures OI level
 * and turnover for a watchlist — the live "urgency" signal. Off-hours it returns
 * { marketOpen: false } and NO rows (the order book only exists when the market
 * is open — never synthesized).
 *
 * Identical concurrent/near-simultaneous requests (multiple windows or users on
 * /live) share ONE computation through quote-response-cache.ts — a single
 * window's 7s polls always outlive the 6.5s TTL and recompute exactly as
 * before. `fresh: true` (the page's "Refresh all" button) bypasses the cache.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(
      () => ({}) as { symbols?: unknown; fresh?: unknown; scope?: unknown },
    );
    // A section's whole symbol list is quoted in ONE batched Dhan request (built
    // below), so list size never multiplies Dhan calls. The /live page issues one
    // such request per category section, serialized client-side to ≤1 req/sec. This
    // generous guard only stops a pathological input from ballooning a batch
    // (≤200 symbols ≈ ≤400 instruments, well under Dhan's per-request limit).
    // Deduplicated at the boundary. A repeated name buys nothing downstream (the
    // engine keys everything by symbol) but WOULD inflate the V2 universe size,
    // letting a list of 200 copies of one symbol claim the minute over a genuine
    // 166-name scanner universe (PR#15 re-review).
    const includeAllFno = body.scope === 'sector-scope';
    // TradeFinder's Sector Scope has 210 unique members (including OTHERS).
    // Keep its batch intact; other live watchlists retain their 200-name guard.
    const symbolLimit = includeAllFno ? 220 : 200;
    const symbols: string[] = Array.isArray(body.symbols)
      ? [
          ...new Set(
            (body.symbols as unknown[])
              .slice(0, symbolLimit)
              .map((s) => String(s).trim().toUpperCase())
              .filter(Boolean),
          ),
        ]
      : [];
    const fresh = body.fresh === true;

    // No hardcoded fallback basket — an empty watchlist returns empty rows (each
    // /live section builds its own list via /api/live/nse-watchlist).
    if (symbols.length === 0) {
      return NextResponse.json({
        success: true,
        marketOpen: isMarketHours(),
        rows: [],
        symbols,
      });
    }

    // Sort for cache-key normalization — two windows passing the same symbols
    // in different order must share the same cache entry.
    const sortedSymbols = [...symbols].sort();
    const cacheKey = `${includeAllFno ? 'sector-scope:' : ''}${sortedSymbols.join(',')}`;
    const payload = await cachedQuoteResponse(cacheKey, fresh, () => computeQuotePayload(symbols, includeAllFno));
    return NextResponse.json(payload);
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}

/** The full (uncached) quote computation — exactly the former handler body. */
async function computeQuotePayload(symbols: string[], includeAllFno = false): Promise<object> {
  if (!isMarketHours()) {
    // Post-market: serve the last RECORDED state of the most recent session
    // (oi_intraday + Fyers bars) so the page keeps showing that day's numbers
    // until the next open. Falls back to the old empty response when nothing
    // was recorded (e.g. fresh install).
    const snap = await buildClosingSnapshot(symbols, { includeAvoid: includeAllFno });
    if (snap) return snap;
    return { success: true, marketOpen: false, rows: [], symbols };
  }

  // Live Urgency is F&O-only and never shows the 'avoid' lot-size band. Drop
  // anything that isn't a tradeable F&O name (covers manual entries too) and
  // report what was removed, so the watchlist shrinks visibly, never silently.
  const fno = await loadFnoUniverse(symbols);
  const excluded: { symbol: string; reason: string }[] = [];
  const allowed: string[] = [];
  for (const s of symbols) {
    const cls = classifyFno(fno.get(s));
    if (cls.ok || (includeAllFno && fno.has(s) && cls.reason === 'avoid')) allowed.push(s);
    else
      excluded.push({
        symbol: s,
        reason: excludeReasonLabel(cls.reason ?? 'not-fno'),
      });
  }
  if (allowed.length === 0) {
    return {
      success: true,
      marketOpen: true,
      rows: [],
      symbols: allowed,
      excluded,
    };
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
  // Canonical market-data observation time: capture it immediately after the
  // Dhan snapshot returns, before baseline/SQLite/context work adds latency.
  const quoteObservedAtMs = Date.now();
  const quoteObservedAt = new Date(quoteObservedAtMs);
  const eqSeg = quotes.NSE_EQ ?? {};
  const futSeg = quotes.NSE_FNO ?? {};

  // Per-symbol bhavcopy baselines (20d OI/turnover averages, prev-day OI,
  // prior-day high/low/close) — the fixed EOD anchors the live R-Factor scores
  // against. One query for the whole watchlist.
  const baselines = await loadRFactorBaselines(allowed);

  const today = todayIST();
  const now = quoteObservedAt;
  // NSE's combined (fut+opt) OI % per symbol — recorded per 5-min FUT bar by the
  // Fyers poller from the oi-spurts feed. DB-only, one batched query; names not
  // in that feed are simply absent (shown as "—", never faked).
  const nseOi = await getNseOiLatestForSymbols(allowed, today).catch(() => new Map<string, never>());
  // Rich oi-spurts row per symbol (options premium, fut/opt value split, options
  // share, absolute combined OI) — live-feed snapshot through the shared 30s NSE
  // cache. Display columns for the F&O OI Build-up view; missing → "—", never faked.
  //
  // Bounded by LIVE_PATH_NSE_WAIT_MS: an NSE miss from a datacentre IP can stall
  // for tens of seconds (cookie warm-up + API timeout + one retry), and this
  // route must answer well inside the client's 8s abort. Past the cap we take
  // the last captured rows and the fetch finishes in the background — these are
  // display-only columns, so a couple of seconds of age beats a dead request.
  const nseOiRows = await getNseOiRowMap({ maxWaitMs: LIVE_PATH_NSE_WAIT_MS }).catch(
    () => new Map<string, OiStock>(),
  );
  // Fraction of the session elapsed — the Turn-Lvl divisor (same math the
  // R-Factor turnover factor uses, surfaced as its own column).
  const sessionFrac = sessionFractionElapsed(now);
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
    const previousClose = base?.priorDayClose ?? null;
    const changePctPrevClose =
      ltp != null && previousClose != null && previousClose > 0
        ? ((ltp - previousClose) / previousClose) * 100
        : changePctOpen;
    const futOi = futQ?.oi ?? null;
    const avg = base?.futOi20dAvg ?? 0;
    const oiLevel = futOi != null && futOi > 0 && avg > 0 ? futOi / avg : null;
    const turnover =
      futQ?.average_price != null && futQ?.volume != null && futQ.average_price > 0
        ? futQ.average_price * futQ.volume
        : null;
    // Turnover pace: cumulative turnover ÷ (20d full-day avg × session fraction).
    // Decays through the day if the flow dies — unlike raw cumulative turnover.
    const turnoverLvl =
      turnover != null &&
      base?.futTurnover20dAvg != null &&
      base.futTurnover20dAvg > 0 &&
      sessionFrac > MIN_SESSION_FRACTION
        ? turnover / (base.futTurnover20dAvg * sessionFrac)
        : null;
    const oiFeed = nseOi.get(s);
    const oiRow = nseOiRows.get(s);

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
      now
    );
    const r = rf ? computeRFactor(rf) : null;

    // TradeFinder breakout: FAST half — live LTP + live R-Factor against the
    // 5-min-cached morning-test + level ladder. Null until the symbol's
    // candles are recorded (never fabricated). Context warms below.
    // Breakout keeps the engine's internal 1-10 strength threshold. The App
    // R-Factor shown below is separately calibrated to TF's board and remains
    // display-only, so it cannot alter this evidence grade or order decisions.
    const breakout = evaluateBreakout(getBreakoutContext(s), ltp, r?.rFactor ?? null, changePctOpen);

    return {
      symbol: s,
      ltp,
      previousClose,
      changePctPrevClose,
      changePctOpen,
      bid: ba?.bid ?? null,
      ask: ba?.ask ?? null,
      spreadPct: ba?.spreadPct ?? null,
      imbalance,
      futOi,
      oiLevel,
      turnover,
      dayHigh: eqQ?.ohlc?.high ?? null,
      dayLow: eqQ?.ohlc?.low ?? null,
      hasDepth: ba != null,
      sinceEntryPct: null, // filled from the recorded intraday series below
      turnoverLvl,
      nseOiPct: oiFeed?.nseOiPct ?? null,
      nseOiSlope30m: oiFeed?.slope30m ?? null,
      // NSE-native columns — straight from the LIVE oi-spurts feed so they match
      // NSE's site exactly (the DB-recorded nseOiPct above lags by up to one poll).
      nseChgOiPct: oiRow?.changeInOiPct ?? null,
      nseChangeInOi: oiRow?.changeInOi ?? null,
      nseVolume: oiRow?.volume ?? null,
      nseUnderlyingValue: oiRow?.underlyingValue ?? null,
      nsePremValueCr: oiRow?.premValueCr ?? null,
      nseFutValueCr: oiRow?.futValueCr ?? null,
      nseOptValueCr: oiRow?.optValueCr ?? null,
      nseTotalValueCr: oiRow?.totalValueCr ?? null,
      nseOptShare: oiRow?.optShare ?? null,
      nseLatestOi: oiRow?.latestOi ?? null,
      nsePrevOi: oiRow?.prevOi ?? null,
      sessionOiChangePct: null,
      oiVelocity: null,
      oiAccel: null,
      oiUrgency: null,
      rFactor: r ? approximateTfRFactor(r.factors) : null,
      rFactorBias: r?.bias ?? null,
      rFactorConfidence: r?.confidence ?? null,
      rFactorAfterEntry: r?.afterEntryWindow ?? null,
      rFactors:
        r?.factors.map((f) => ({
          label: f.label,
          score: f.score,
          vote: f.vote,
          available: f.available,
          detail: f.detail,
        })) ?? null,
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
        optShare: r.nseOptShare ?? null,
        premValueCr: r.nsePremValueCr ?? null,
      }))
    );
    const seriesMap = await getIntradaySeriesForSymbols(today, allowed);
    for (const r of rows) {
      const series = seriesMap.get(r.symbol) ?? [];
      const u = computeOiUrgency(series);
      if (u.ok) {
        r.sessionOiChangePct = u.sessionOiChangePct;
        r.oiVelocity = u.oiVelocity;
        r.oiAccel = u.oiAccel;
        r.oiUrgency = u.urgencyScore;
      }
      // Move freshness: price change since the entry window opened (09:45 IST).
      r.sinceEntryPct = changeSinceEntryWindow(series, r.ltp);
    }
  } catch (e) {
    console.warn('[live/quote] intraday OI capture failed:', (e as Error).message);
  }

  // Keep the Dhan option-chain evidence flowing. This is the ONLY thing left of
  // the retired R-Factor V2 shadow (removed 2026-08-11): the score, its
  // snapshots and its /live column are gone, but the chain read survives because
  // /live and the commentary narration consume it. It gates nothing — see
  // scripts/measure-option-evidence.ts for the measurement that says why.
  //
  // Nothing here may block the response. The scanner calls this route with
  // `fresh: true` (it must never read a stale cache), so every millisecond spent
  // here lands on the path that produces real trade decisions.
  // scheduleOptionEvidenceShadow never awaits network I/O — it enqueues and
  // returns, and a background worker does the Dhan calls on the low-priority
  // gate lane.
  try {
    // Priority = the app's own R-Factor, i.e. participation. This used to rank
    // by V2's comparableActivity; with V2 gone, R-Factor is the activity measure
    // the page itself ranks by, so enrichment follows the same names the
    // operator is actually looking at. Symbols with no R-Factor sort last rather
    // than being dropped, so a thin board still enriches something.
    //
    // Offers up to MAX_TRACKED candidates (20), not the old 6: the shadow queue
    // keeps the strongest MAX_TRACKED, and the binding constraint on ever
    // answering "does the chain predict anything" is how many names get a
    // snapshot at all.
    scheduleOptionEvidenceShadow(
      [...rows]
        .sort((a, b) => (b.rFactor ?? -1) - (a.rFactor ?? -1))
        .slice(0, 20)
        .map((row) => ({ symbol: row.symbol, priority: row.rFactor ?? 0 })),
    );
  } catch (error) {
    console.warn(`[OptionChain] shadow scheduling failed: ${(error as Error).message}`);
  }

  return {
    success: true,
    marketOpen: true,
    asOf: quoteObservedAt.toISOString(),
    date: today,
    rows,
    symbols: allowed,
    excluded,
  };
}
