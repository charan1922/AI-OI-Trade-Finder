import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { expiryRowsToContracts } from '@/lib/historify/oi-contracts';
import { getPulseFeed } from '@/lib/nse/pulse-cache';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/nse/oi-audit — data-integrity check for open-interest.
 *
 * Compares, per F&O stock, our EOD day-over-day OI% (reconstructed from the last
 * two synced bhavcopy sessions, counted in CONTRACTS — the identical basis as
 * /api/nse/movers-history) against NSE's LIVE oi-spurts feed (`avgInOI`). The two
 * agree to ~0.00% for almost every stock; a large `deltaPct` flags a divergence
 * worth eyeballing.
 *
 *   ?threshold=5   → flag stocks where |ours − NSE| exceeds this many points (default 5)
 *
 * A divergence is NOT proof our data is wrong — it is usually a quirk in NSE's
 * live feed (e.g. TECHM 2026-07-02→03: live +38.47% vs our verified +1.26%, where
 * the live feed's previous-day baseline had dropped the options side). This audit
 * only surfaces the outliers; confirm each against the official bhavcopy file
 * (sum OpnIntrst over STO/STF rows per XpryDt) before treating it as an import bug.
 */

interface ExpiryOiRow {
  symbol: string;
  date: string;
  oi: number;
  lotSize: number;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const threshold = Math.max(0, Number(url.searchParams.get('threshold') ?? '5') || 5);

    const dateRows = await prisma.$queryRawUnsafe<{ date: string }[]>(
      `SELECT DISTINCT date FROM bhavcopy_days ORDER BY date DESC LIMIT 2`,
    );
    if (dateRows.length < 2) {
      return NextResponse.json(
        { success: false, error: 'Need at least 2 synced bhavcopy sessions to audit — sync NSE data first.' },
        { status: 400 },
      );
    }
    const [date, prevDate] = [dateRows[0].date, dateRows[1].date];

    // Shares totals (fallback when a symbol lacks lot-backed per-expiry rows).
    const dayRows = await prisma.$queryRawUnsafe<{ symbol: string; date: string; futOi: number; optOi: number }[]>(
      `SELECT symbol, date, futOi, optOi FROM bhavcopy_days WHERE date IN (?, ?)`,
      date,
      prevDate,
    );

    // Per-expiry OI + board lot (options + futures) for both sessions.
    const [optExp, futExp] = await Promise.all([
      prisma
        .$queryRawUnsafe<ExpiryOiRow[]>(
          `SELECT symbol, date, optOi AS oi, lotSize FROM bhavcopy_option_expiry WHERE date IN (?, ?)`,
          date,
          prevDate,
        )
        .catch(() => [] as ExpiryOiRow[]),
      prisma
        .$queryRawUnsafe<ExpiryOiRow[]>(
          `SELECT symbol, date, futOi AS oi, lotSize FROM bhavcopy_fut_expiry WHERE date IN (?, ?)`,
          date,
          prevDate,
        )
        .catch(() => [] as ExpiryOiRow[]),
    ]);

    // symbol|date -> flat list of { oi (shares), lot } across all fut+opt expiries.
    const rowsByKey = new Map<string, { oi: number; lot: number }[]>();
    const push = (r: ExpiryOiRow) => {
      const k = `${r.symbol}|${r.date}`;
      const list = rowsByKey.get(k) ?? [];
      list.push({ oi: r.oi, lot: r.lotSize });
      rowsByKey.set(k, list);
    };
    for (const r of optExp) push(r);
    for (const r of futExp) push(r);

    const contractsOi = (symbol: string, d: string): number | null => {
      const list = rowsByKey.get(`${symbol}|${d}`);
      return list ? expiryRowsToContracts(list) : null;
    };

    // Shares totals per symbol/date (fallback basis).
    const sharesOi = new Map<string, number>();
    for (const r of dayRows) sharesOi.set(`${r.symbol}|${r.date}`, r.futOi + r.optOi);

    // Our EOD day-over-day OI% per symbol (contracts where possible, else shares).
    const ourPct = new Map<string, number>();
    const symbols = new Set(dayRows.map((r) => r.symbol));
    for (const sym of symbols) {
      const cNow = contractsOi(sym, date);
      const cPrev = contractsOi(sym, prevDate);
      if (cNow !== null && cPrev !== null && cPrev > 0) {
        ourPct.set(sym, ((cNow - cPrev) / cPrev) * 100);
      } else {
        const now = sharesOi.get(`${sym}|${date}`) ?? 0;
        const prev = sharesOi.get(`${sym}|${prevDate}`) ?? 0;
        if (prev > 0) ourPct.set(sym, ((now - prev) / prev) * 100);
      }
    }

    // NSE live oi-spurts feed (shared 30s cache). Degrade gracefully if unreachable.
    let feed: { symbol: string; changeInOiPct: number }[] = [];
    let feedFetchedAt: number | null = null;
    let feedStale = false;
    let feedError: string | null = null;
    try {
      const r = await getPulseFeed('oiSpurts');
      feed = (r.data as { symbol: string; changeInOiPct: number }[]) ?? [];
      feedFetchedAt = r.fetchedAt;
      feedStale = r.stale;
    } catch (e) {
      feedError = (e as Error).message;
    }

    const rows = [];
    for (const { symbol, changeInOiPct } of feed) {
      const ours = ourPct.get(symbol);
      if (ours === undefined) continue; // not in our F&O universe / no baseline
      const deltaPct = ours - changeInOiPct;
      rows.push({
        symbol,
        ourPct: Number(ours.toFixed(2)),
        nsePct: Number(changeInOiPct.toFixed(2)),
        deltaPct: Number(deltaPct.toFixed(2)),
        flagged: Math.abs(deltaPct) > threshold,
      });
    }
    rows.sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct));

    const flagged = rows.filter((r) => r.flagged);
    return NextResponse.json({
      success: true,
      date,
      prevDate,
      threshold,
      compared: rows.length,
      flaggedCount: flagged.length,
      feed: { fetchedAt: feedFetchedAt, stale: feedStale, error: feedError },
      note: feedStale
        ? 'NSE feed is stale (market closed) — showing its last live snapshot; a flagged stock may be an NSE-side feed quirk, not our data. Verify against the bhavcopy file before treating as an import bug.'
        : 'ours = EOD contracts basis (last 2 sessions); NSE = live oi-spurts avgInOI. Verify flagged stocks against the bhavcopy file.',
      flagged,
      all: rows,
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
