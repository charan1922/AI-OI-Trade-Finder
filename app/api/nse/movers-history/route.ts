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
 * So we reconstruct contracts per expiry: Σ (expiry OI ÷ that expiry's lot). The
 * lot is the per-contract board lot (NewBrdLotQty) captured from the bhavcopy file
 * itself and stored per row in `bhavcopy_{option,fut}_expiry` — so it is correct
 * for every date and every expiry cycle (no dependence on a current lot snapshot).
 * When a symbol lacks per-expiry data or a stored lot for that session, we fall
 * back to the shares-based fut+opt total — never fabricate.
 */

interface HistRow {
  symbol: string;
  date: string;
  eqClose: number; // NSE official VWAP close — denominator for % change (prior session)
  eqLastPrice: number; // final traded price — what the movers UI shows (matches live/Google)
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
  lotSize: number;
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
      `SELECT symbol, date, eqClose, eqLastPrice, eqTurnover, eqVolume, futOi, optOi
       FROM bhavcopy_days WHERE date IN (?, ?) AND eqClose > 0`,
      date,
      prevDate,
    );

    // Per-expiry OI (options + futures) for both sessions, each row carrying the
    // contract's own board lot (NewBrdLotQty, captured from the bhavcopy file).
    // Tables/rows/lots may be absent (older data not yet backfilled) → degrade to shares.
    const [optExp, futExp] = await Promise.all([
      prisma
        .$queryRawUnsafe<ExpiryOiRow[]>(
          `SELECT symbol, date, expiry, optOi AS oi, lotSize FROM bhavcopy_option_expiry WHERE date IN (?, ?)`,
          date,
          prevDate,
        )
        .catch(() => [] as ExpiryOiRow[]),
      prisma
        .$queryRawUnsafe<ExpiryOiRow[]>(
          `SELECT symbol, date, expiry, futOi AS oi, lotSize FROM bhavcopy_fut_expiry WHERE date IN (?, ?)`,
          date,
          prevDate,
        )
        .catch(() => [] as ExpiryOiRow[]),
    ]);

    // symbol|date -> Map(expiry -> { oi (shares, opt+fut), lot }). Futures and
    // options of the same expiry share one board lot, so we keep the positive one.
    const oiByKeyExpiry = new Map<string, Map<string, { oi: number; lot: number }>>();
    const addExpiry = (r: ExpiryOiRow) => {
      const k = `${r.symbol}|${r.date}`;
      let m = oiByKeyExpiry.get(k);
      if (!m) {
        m = new Map();
        oiByKeyExpiry.set(k, m);
      }
      const cur = m.get(r.expiry);
      m.set(r.expiry, {
        oi: (cur?.oi ?? 0) + r.oi,
        lot: r.lotSize > 0 ? r.lotSize : (cur?.lot ?? 0),
      });
    };
    for (const r of optExp) addExpiry(r);
    for (const r of futExp) addExpiry(r);

    // Total OI in CONTRACTS for a symbol on a date: Σ (expiry OI ÷ that expiry's
    // own board lot). Returns null if we lack per-expiry data, or any expiry is
    // missing its stored lot — the caller then falls back to the shares total.
    const contractsOi = (symbol: string, d: string): number | null => {
      const m = oiByKeyExpiry.get(`${symbol}|${d}`);
      if (!m || m.size === 0) return null;
      let total = 0;
      for (const { oi, lot } of m.values()) {
        if (!(lot > 0)) return null; // no trustworthy lot for this expiry → bail to shares
        total += oi / lot;
      }
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

      // Show the last-traded price and a %change off it — matching the live page,
      // Google, and brokers. Denominator stays the prior session's official close
      // (= NSE's PrvsClsgPric reference). Fall back to the official close when the
      // last price hasn't been backfilled for this row.
      const last = r.eqLastPrice > 0 ? r.eqLastPrice : r.eqClose;

      stocks.push({
        symbol: r.symbol,
        close: last,
        pctChange: ((last - pc) / pc) * 100,
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
