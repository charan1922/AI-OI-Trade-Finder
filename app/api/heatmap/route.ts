import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { dhanMarketFeed, isMarketHours, type MarketFeedQuote } from '@/lib/dhan/market-feed';
import { aggregateSectors } from '@/lib/sector/aggregate';
import { loadSectorMap } from '@/lib/sector/sector-map';

export const dynamic = 'force-dynamic';

/**
 * GET /api/heatmap — sector treemap data for the whole F&O universe.
 *
 * Market OPEN → 100% live Dhan, no bhavcopy involved: one quote call covers
 * every mapped F&O stock; % change comes from Dhan's own `net_change` (LTP −
 * previous official close), turnover from VWAP × today's volume.
 *
 * Market CLOSED (or the live call failed) → last synced NSE bhavcopy session
 * vs the one before it, clearly labeled as EOD.
 *
 * Tile size = traded value (₹); tile color = % change. Symbols without a
 * sector mapping are skipped, never guessed.
 */

export interface HeatTile {
  symbol: string;
  sector: string;
  /** % change vs the PREVIOUS close (live: Dhan net_change; closed: EOD vs prior EOD). */
  pct: number;
  /** Intraday % change since TODAY'S OPEN — (LTP − open) / open. The default tile
   *  metric; excludes the overnight gap. Falls back to `pct` if open is missing. */
  intradayPct: number;
  /** Traded value in ₹ (live: VWAP × volume so far today; closed: full-day turnover). */
  turnover: number;
  price: number;
}

/**
 * Server-side shield for Dhan's 1-quote-call/sec limit: the live result is
 * cached briefly, so N browser tabs (or a misbehaving poller) collapse into at
 * most one upstream call per window. Module-level — survives across requests.
 *
 * The cache also doubles as a STALE fallback: if a live call fails mid-session
 * (429 / transient), we keep serving the last good live snapshot flagged
 * `stale: true` rather than yanking the user back to yesterday's EOD. We only
 * fall back to EOD when there's no live snapshot at all (e.g. right at 9:15).
 */
const LIVE_CACHE_MS = 10_000;
let liveCache: { at: number; payload: Record<string, unknown> } | null = null;

export async function GET() {
  try {
    const sectors = await loadSectorMap();

    // ── Live path: pure Dhan, universe from master_contracts ∩ sector map ───
    let liveError: string | null = null;
    if (isMarketHours()) {
      if (liveCache && Date.now() - liveCache.at < LIVE_CACHE_MS) {
        return NextResponse.json(liveCache.payload);
      }
      try {
        const eqRows = await prisma.masterContract.findMany({
          where: { symbol: { in: Object.keys(sectors) }, segment: 'NSE_EQ' },
          select: { symbol: true, securityId: true },
        });
        const ids = eqRows.map((r) => Number(r.securityId));
        if (ids.length > 0) {
          const quotes = await dhanMarketFeed('quote', { NSE_EQ: ids });
          const seg: Record<string, MarketFeedQuote> = quotes.NSE_EQ ?? {};
          const tiles: HeatTile[] = [];
          for (const r of eqRows) {
            const q = seg[r.securityId];
            const ltp = q?.last_price ?? 0;
            const netChange = q?.net_change;
            if (ltp <= 0 || netChange == null) continue;
            const prevClose = ltp - netChange;
            if (prevClose <= 0) continue;
            const vwap = q?.average_price ?? 0;
            const vol = q?.volume ?? 0;
            const turnover = vwap > 0 && vol > 0 ? vwap * vol : ltp * vol;
            if (turnover <= 0) continue; // first seconds of the session — no size yet
            const open = q?.ohlc?.open ?? 0;
            const pct = (netChange / prevClose) * 100;
            tiles.push({
              symbol: r.symbol,
              sector: sectors[r.symbol],
              pct,
              intradayPct: open > 0 ? ((ltp - open) / open) * 100 : pct,
              turnover,
              price: ltp,
            });
          }
          if (tiles.length > 0) {
            const payload = {
              success: true,
              source: 'live',
              marketOpen: true,
              stale: false,
              asOf: new Date().toISOString(),
              tiles,
              sectors: aggregateSectors(tiles),
            };
            liveCache = { at: Date.now(), payload };
            return NextResponse.json(payload);
          }
          liveError = 'quote returned no usable rows';
        } else {
          liveError = 'no equity IDs in master_contracts';
        }
      } catch (e) {
        // Dhan unavailable (429 / creds) — surface the reason so a silent
        // fallback can't masquerade as a healthy feed.
        liveError = (e as Error).message;
        console.error('[Heatmap] live path failed:', liveError);
      }

      // Live failed THIS cycle but we have a prior good snapshot → keep showing
      // it (flagged stale + retrying) instead of jumping to yesterday's EOD.
      // The fast 15s open-market poll keeps trying, so this self-heals.
      if (liveCache) {
        return NextResponse.json({
          ...liveCache.payload,
          stale: true,
          liveError,
        });
      }
      // No live snapshot yet this session → genuine EOD fallback below.
    }

    // ── EOD path (closed market, or live failed): NSE bhavcopy ──────────────
    const dateRows = await prisma.$queryRawUnsafe<{ date: string }[]>(
      `SELECT DISTINCT date FROM bhavcopy_days ORDER BY date DESC LIMIT 2`,
    );
    if (dateRows.length < 2) {
      return NextResponse.json(
        { success: false, error: 'Need at least 2 synced bhavcopy sessions — sync NSE data in Data Downloader first.' },
        { status: 400 },
      );
    }
    const [latest, prev] = [dateRows[0].date, dateRows[1].date];

    const rows = await prisma.$queryRawUnsafe<
      { symbol: string; date: string; eqOpen: number; eqClose: number; eqTurnover: number }[]
    >(
      `SELECT symbol, date, eqOpen, eqClose, eqTurnover FROM bhavcopy_days
       WHERE date IN (?, ?) AND eqClose > 0`,
      latest,
      prev,
    );
    const latestBySym = new Map<string, { open: number; close: number; turnover: number }>();
    const prevBySym = new Map<string, number>();
    for (const r of rows) {
      if (r.date === latest)
        latestBySym.set(r.symbol, { open: r.eqOpen, close: r.eqClose, turnover: r.eqTurnover });
      else prevBySym.set(r.symbol, r.eqClose);
    }

    const tiles: HeatTile[] = [...latestBySym.entries()]
      .filter(([sym]) => sectors[sym] && (prevBySym.get(sym) ?? 0) > 0)
      .map(([sym, cur]) => {
        const base = prevBySym.get(sym) ?? 0;
        const pct = ((cur.close - base) / base) * 100;
        return {
          symbol: sym,
          sector: sectors[sym],
          pct,
          // Session intraday move (open → close of the latest synced day).
          intradayPct: cur.open > 0 ? ((cur.close - cur.open) / cur.open) * 100 : pct,
          turnover: cur.turnover,
          price: cur.close,
        };
      });

    return NextResponse.json({
      success: true,
      source: 'eod',
      marketOpen: isMarketHours(),
      sessionDate: latest,
      baseDate: prev,
      liveError,
      tiles,
      sectors: aggregateSectors(tiles),
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
