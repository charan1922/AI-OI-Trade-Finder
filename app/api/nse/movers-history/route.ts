import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/nse/movers-history — EOD movers reconstructed from NSE bhavcopy.
 *
 *   ?dates=true        → { dates: [...] } the available session dates (desc)
 *   ?date=YYYY-MM-DD   → per-stock close-to-close stats for that session
 *
 * Pure DB read of `bhavcopy_days` (NSE official end-of-day) — no NSE/Dhan calls.
 * For session D vs the prior session: pctChange = (close[D]−close[D−1])/close[D−1];
 * turnover/volume = D's values.
 *
 * oiPct = change in TOTAL derivatives OI (futures + options) vs the prior session,
 * counted in CONTRACTS — matching NSE's live "OI spurts" metric. NSE counts
 * contracts; bhavcopy OI is in shares. The two are identical UNLESS a stock is
 * mid lot-size revision, when OI rolling into the next expiry (a different lot)
 * makes the shares total move opposite to the contracts total (e.g. MCX 625→225).
 * So we reconstruct contracts per expiry: Σ (expiry OI ÷ that expiry's lot), using
 * the per-expiry OI in `bhavcopy_{option,fut}_expiry` and the three-month lots in
 * `fno_stocks`. When per-expiry data is missing for a symbol (not yet backfilled),
 * we fall back to the shares-based fut+opt total — never fabricate.
 */

interface HistRow {
  symbol: string;
  date: string;
  eqClose: number;
  eqTurnover: number;
  eqVolume: number;
  futOi: number;
  optOi: number;
}

interface ExpiryOiRow {
  symbol: string;
  date: string;
  expiry: string;
  oi: number;
}

interface LotRow {
  symbol: string;
  lotSize: number;
  lotSizeNext: number;
  lotSizeFar: number;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);

    const dateRows = await prisma.$queryRawUnsafe<{ date: string }[]>(
      `SELECT DISTINCT date FROM bhavcopy_days ORDER BY date DESC`,
    );
    const dates = dateRows.map((r) => r.date);

    if (url.searchParams.get('dates') === 'true') {
      return NextResponse.json({ success: true, dates });
    }
    if (dates.length < 2) {
      return NextResponse.json(
        { success: false, error: 'Need at least 2 synced bhavcopy sessions — sync NSE data first.' },
        { status: 400 },
      );
    }

    const requested = url.searchParams.get('date');
    const date = requested && dates.includes(requested) ? requested : dates[0];
    const prevDate = dates[dates.indexOf(date) + 1]; // dates are DESC → next index is the older session
    if (!prevDate) {
      return NextResponse.json(
        { success: false, error: `No prior session before ${date} to compute change.` },
        { status: 400 },
      );
    }

    const rows = await prisma.$queryRawUnsafe<HistRow[]>(
      `SELECT symbol, date, eqClose, eqTurnover, eqVolume, futOi, optOi
       FROM bhavcopy_days WHERE date IN (?, ?) AND eqClose > 0`,
      date,
      prevDate,
    );

    // Per-expiry OI (options + futures) for both sessions, plus the three-month
    // lot table — the inputs to count OI in contracts across a lot-size revision.
    // Tables/rows may be absent (not yet backfilled) → we degrade to shares.
    const [optExp, futExp, lotRows] = await Promise.all([
      prisma
        .$queryRawUnsafe<ExpiryOiRow[]>(
          `SELECT symbol, date, expiry, optOi AS oi FROM bhavcopy_option_expiry WHERE date IN (?, ?)`,
          date,
          prevDate,
        )
        .catch(() => [] as ExpiryOiRow[]),
      prisma
        .$queryRawUnsafe<ExpiryOiRow[]>(
          `SELECT symbol, date, expiry, futOi AS oi FROM bhavcopy_fut_expiry WHERE date IN (?, ?)`,
          date,
          prevDate,
        )
        .catch(() => [] as ExpiryOiRow[]),
      prisma
        .$queryRawUnsafe<LotRow[]>(`SELECT symbol, lotSize, lotSizeNext, lotSizeFar FROM fno_stocks`)
        .catch(() => [] as LotRow[]),
    ]);

    const lotBySymbol = new Map(lotRows.map((l) => [l.symbol, l]));

    // symbol|date -> Map(expiry -> summed OI in shares), merging opt + fut legs.
    const oiByKeyExpiry = new Map<string, Map<string, number>>();
    const addExpiry = (r: ExpiryOiRow) => {
      const k = `${r.symbol}|${r.date}`;
      let m = oiByKeyExpiry.get(k);
      if (!m) {
        m = new Map();
        oiByKeyExpiry.set(k, m);
      }
      m.set(r.expiry, (m.get(r.expiry) ?? 0) + r.oi);
    };
    for (const r of optExp) addExpiry(r);
    for (const r of futExp) addExpiry(r);

    // Total OI in CONTRACTS for a symbol on a date: Σ (expiry OI ÷ that expiry's
    // lot). Expiries sorted ascending map to [lotSize, lotSizeNext, lotSizeFar]
    // (the exchange's three nearest contract months). Returns null when we lack
    // per-expiry data or lots — caller then falls back to the shares total.
    const contractsOi = (symbol: string, d: string): number | null => {
      const m = oiByKeyExpiry.get(`${symbol}|${d}`);
      const lot = lotBySymbol.get(symbol);
      if (!m || m.size === 0 || !lot) return null;
      const cols = [lot.lotSize, lot.lotSizeNext || lot.lotSize, lot.lotSizeFar || lot.lotSize];
      const expiriesAsc = [...m.keys()].sort();
      let total = 0;
      expiriesAsc.forEach((e, i) => {
        const l = cols[i] || cols[cols.length - 1] || 1;
        total += (m.get(e) ?? 0) / l;
      });
      return total;
    };

    const prevClose = new Map<string, number>();
    const prevTotalOiShares = new Map<string, number>();
    for (const r of rows) {
      if (r.date === prevDate) {
        prevClose.set(r.symbol, r.eqClose);
        prevTotalOiShares.set(r.symbol, r.futOi + r.optOi);
      }
    }

    const stocks = [];
    for (const r of rows) {
      if (r.date !== date) continue;
      const pc = prevClose.get(r.symbol);
      if (pc === undefined || pc <= 0) continue; // need both sessions for a real change — never fabricate

      // Prefer the contracts basis (matches NSE through lot revisions); fall back
      // to the shares total when per-expiry data isn't available for this symbol.
      const cNow = contractsOi(r.symbol, date);
      const cPrev = contractsOi(r.symbol, prevDate);
      let oiPct = 0;
      let oiBasis: 'contracts' | 'shares' = 'shares';
      if (cNow !== null && cPrev !== null && cPrev > 0) {
        oiPct = ((cNow - cPrev) / cPrev) * 100;
        oiBasis = 'contracts';
      } else {
        const priorOi = prevTotalOiShares.get(r.symbol) ?? 0;
        const totalOi = r.futOi + r.optOi;
        oiPct = priorOi > 0 ? ((totalOi - priorOi) / priorOi) * 100 : 0;
      }

      stocks.push({
        symbol: r.symbol,
        close: r.eqClose,
        pctChange: ((r.eqClose - pc) / pc) * 100,
        turnover: r.eqTurnover,
        volume: r.eqVolume,
        oiPct,
        oiBasis,
        hasFno: r.futOi > 0,
      });
    }

    return NextResponse.json({ success: true, date, prevDate, count: stocks.length, stocks });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
