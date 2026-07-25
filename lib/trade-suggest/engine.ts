/**
 * /trade-suggest engine — assembles the daily "max 3 near-ATM option buys"
 * suggestion from signals the app already computes:
 *
 *   candidates (NSE watchlist feeds, F&O-gated, sector attached)
 *     → one batched POST /api/live/quote  (R-Factor + bias, OI urgency, depth)
 *     → setupScore verdict + opening-range state (fyers_candles)
 *     → hard gates (TF fingerprint: OI evidence via futures level ≥1.1× OR
 *       NSE combined ≥5%, spread ≤0.3%, R-Factor ≥3.6 on the 1–8 scale,
 *       direction agreement)
 *     → composite score → top 3 → nearest listed ATM strike from
 *       master_contracts OPTSTK → spot-level entry/SL/target plan → persist.
 *
 * The watchlist + quote steps go through the existing HTTP routes (same
 * origin) on purpose: they carry the Dhan rate gate, F&O gating, OI recording
 * and R-Factor wiring — re-implementing them here would just fork that logic.
 *
 * NOTE: option resolution deliberately does NOT use master-contracts'
 * resolveOptionSecurity() — its ensureSynced() gate throws unless the master
 * was synced today, and this simulator ships pre-loaded contracts (same
 * reasoning as app/api/live/quote/route.ts). We query OPTSTK rows directly.
 */

import { setupScore } from '@/app/live/_lib/setup-score';
import type { LiveQuoteResponse, LiveUrgencyRow } from '@/app/live/_lib/types';
import { prisma } from '@/lib/db';
import { isMarketHours, todayIST } from '@/lib/dhan/market-feed';
import { getEqBucketStatus, getFyersCandles, getNseOiSeries, fyersBucketFor, type StoredFyersBar } from '@/lib/fyers/candle-store';
import { evaluateFreshnessBestEffort, requiredCompletedBucket } from '@/lib/priority-refresh/freshness';
import { getNseOiRowMap } from '@/lib/nse/combined-oi';
import { selectOptionExpiryForEntry } from '@/lib/options/expiry-policy';
import { aggregateSectors, type SectorAggregate } from '@/lib/sector/aggregate';
import { combinedOiSlope } from '@/lib/signals/combined-oi-slope';
import { atr, sessionVwap, supertrend } from '@/lib/signals/indicators';
import { detectRegime } from '@/lib/signals/regime-detector';
import { getRecentRankClimbs } from '@/lib/signals/rank-tracker';
import { deriveSessionContext } from '@/lib/signals/session-context';
import {
  BREAKOUT_BYPASS_MIN_RFACTOR,
  BREAKOUT_BYPASS_REQUIRE_TREND,
  CAPITAL_BUDGET,
  CHAOTIC_OPEN_MAX_RATIO,
  EXCLUDE_EXTENDED,
  EXTENDED_BYPASS_MIN_RFACTOR,
  EXTENDED_BYPASS_REQUIRE_SUPERTREND,
  MAX_PICKS,
  MAX_SPREAD_PCT,
  MIN_CONFIDENCE,
  MIN_NSE_OI_PCT,
  MIN_OI_LEVEL,
  MIN_OPT_PREMIUM_CR,
  MIN_OPT_SHARE,
  MIN_RFACTOR,
  MIN_TURNOVER_SCORE,
  MOMENTUM_MIN_CHANGE_PCT,
  PICK_OVERSAMPLE,
  RANK_CLIMB_MIN_NSE_OI_PCT,
  RANK_CLIMB_MIN_SPOTS,
  SCAN_OUTSIDE_WINDOW,
  SL_ATR_MULT,
  USE_BREAKOUT_BYPASS,
  USE_CHAOTIC_OPEN_GATE,
  USE_EXTENDED_TREND_BYPASS,
  USE_MOMENTUM_BREAKOUT,
  USE_RANK_CLIMB_GATE,
  USE_TF_BREAKOUT_GATE,
  WINDOW_END_MIN,
  WINDOW_START_MIN,
} from '@/lib/trade-suggest/config';
import { getAutoTradeSettings } from '@/lib/auto-trade/settings';
import { getNumberSetting, getToggle } from '@/lib/config/feature-toggles';
import {
  discoverCandidateSnapshot,
  internalAuthHeaders,
  internalOrigin,
  type CandidateSnapshot,
} from '@/lib/trade-suggest/candidates';
import { qualifiesByBreakout } from '@/lib/trade-suggest/breakout-bypass';
import { chaoticOpenRatio } from '@/lib/trade-suggest/chaotic-open';
import { qualifiesExtendedTrend } from '@/lib/trade-suggest/extended-bypass';
import { qualifiesMomentumBreakout } from '@/lib/trade-suggest/momentum-breakout';
import { attachPremiums, type PremiumPolicy } from '@/lib/trade-suggest/premiums';
import { buildSpotPlan, computeCompositeScore } from '@/lib/trade-suggest/scoring';
import { getSuggestions, upsertSuggestions } from '@/lib/trade-suggest/store';
import type { OptionPlan, SuggestResponse, SuggestWindow, TradeSuggestion } from '@/lib/trade-suggest/types';

const TAG = '[TradeSuggest]';

// ─── Time window ─────────────────────────────────────────────────────────────

function istNow(): { minuteOfDay: number; label: string } {
  const ist = new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60_000);
  return {
    minuteOfDay: ist.getHours() * 60 + ist.getMinutes(),
    label: ist.toTimeString().slice(0, 8),
  };
}

/** "HH:MM IST" for an IST minute-of-day — dynamic window labels. */
function istLabel(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')} IST`;
}

function windowState(startMin = WINDOW_START_MIN, endMin = WINDOW_END_MIN): SuggestWindow {
  const { minuteOfDay, label } = istNow();
  return {
    active: isMarketHours() && minuteOfDay >= startMin && minuteOfDay <= endMin,
    opensAt: istLabel(startMin),
    closesAt: istLabel(endMin),
    nowIST: label,
  };
}

// ─── Candidate gathering (existing routes, same origin) ──────────────────────

/**
 * Loopback base for server-side self-fetches. A container CANNOT reach its own
 * PUBLIC URL from inside (Railway doesn't route the public host back to the
 * instance) — using it yields "fetch failed". 127.0.0.1:$PORT always works and
 * still passes through proxy.ts's gate (hence internalAuthHeaders). runTradeSuggest
 * uses THIS for its internal fetches, ignoring the caller's request origin, so no
 * caller (HTTP route or poller) can accidentally pass the unreachable public URL.
 */
// Loopback/auth candidate discovery lives in candidates.ts so the poller and
// scanner consume one frozen snapshot instead of refetching after the Fyers batch.

/**
 * Auth header for the internal same-origin fetches below. On the deployed server
 * the whole app is behind proxy.ts (HTTP Basic Auth via APP_PASSWORD); a
 * server-to-self fetch carries no browser credentials, so without this the
 * `/api/live/*` calls 401 and the scan fails. Sends the same password the gate
 * checks. Empty locally (no APP_PASSWORD → gate is off), so dev is unaffected.
 */

/** 20-day bhavcopy baselines for the DISPLAY factors (EQ turnover, combined
 *  fut+opt OI) — loaded only for the shortlist, one query. Mirrors the
 *  rfactor-baselines convention: newest-first, ≤20 positive values, ≥5 min.
 *  Also used by the assistant's symbol-snapshot tool. */
export async function loadFactorBaselines(symbols: string[]): Promise<
  Map<
    string,
    {
      eqTurnover20dAvg: number | null;
      combinedOiPrev: number | null;
      combinedOi20dAvg: number | null;
    }
  >
> {
  const out = new Map<
    string,
    {
      eqTurnover20dAvg: number | null;
      combinedOiPrev: number | null;
      combinedOi20dAvg: number | null;
    }
  >();
  if (symbols.length === 0) return out;
  const avg = (values: number[]): number | null => {
    const xs = values.filter((v) => v > 0).slice(0, 20);
    return xs.length >= 5 ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  };
  try {
    const placeholders = symbols.map(() => '?').join(',');
    const rows = await prisma.$queryRawUnsafe<
      {
        symbol: string;
        eqTurnover: number | null;
        futOi: number | null;
        optOi: number | null;
      }[]
    >(
      `SELECT symbol, eqTurnover, futOi, optOi FROM bhavcopy_days
        WHERE symbol IN (${placeholders}) AND date < ? ORDER BY symbol, date DESC`,
      ...symbols,
      todayIST()
    );
    const bySymbol = new Map<string, typeof rows>();
    for (const r of rows) {
      const arr = bySymbol.get(r.symbol) ?? [];
      if (arr.length < 25) arr.push(r);
      bySymbol.set(r.symbol, arr);
    }
    for (const [symbol, rs] of bySymbol) {
      const prevCombined = Number(rs[0]?.futOi ?? 0) + Number(rs[0]?.optOi ?? 0);
      out.set(symbol, {
        eqTurnover20dAvg: avg(rs.map((r) => Number(r.eqTurnover ?? 0))),
        combinedOiPrev: prevCombined > 0 ? prevCombined : null,
        combinedOi20dAvg: avg(rs.map((r) => Number(r.futOi ?? 0) + Number(r.optOi ?? 0))),
      });
    }
  } catch (err) {
    console.warn(`${TAG} factor baselines failed: ${(err as Error).message}`);
  }
  return out;
}

async function fetchQuotes(origin: string, symbols: string[]): Promise<LiveQuoteResponse> {
  const res = await fetch(`${origin}/api/live/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...internalAuthHeaders() },
    // fresh: the scanner feeds real trade decisions — always bypass the /live
    // shared response cache (app/api/live/_lib/quote-response-cache.ts) so it
    // sees quotes exactly as fresh as before that cache existed.
    body: JSON.stringify({ symbols, fresh: true }),
    cache: 'no-store',
  });
  return (await res.json()) as LiveQuoteResponse;
}

// ─── Near-ATM contract resolution (direct OPTSTK query, no sync gate) ────────

async function resolveAtmOption(
  symbol: string,
  spot: number,
  side: 'CE' | 'PE',
  tradeDate: string
): Promise<OptionPlan | null> {
  const expiryRows = await prisma.$queryRawUnsafe<{ expiryDate: string | Date }[]>(
    `SELECT DISTINCT expiryDate FROM master_contracts
      WHERE underlying = ? AND instrument = 'OPTSTK' AND segment = 'NSE_FNO' AND optionType = ?
        AND substr(expiryDate, 1, 10) >= ?
      ORDER BY expiryDate ASC`,
    symbol,
    side,
    tradeDate
  );
  const availableExpiries = expiryRows.map((row) => {
    const expiry = new Date(row.expiryDate);
    return Number.isNaN(expiry.getTime())
      ? String(row.expiryDate).slice(0, 10)
      : expiry.toISOString().slice(0, 10);
  });
  const selectedExpiry = selectOptionExpiryForEntry(tradeDate, availableExpiries);
  if (!selectedExpiry) return null;
  const rows = await prisma.$queryRawUnsafe<
    {
      securityId: string;
      symbol: string;
      lotSize: number;
      strikePrice: number;
      expiryDate: string | Date;
    }[]
  >(
    `SELECT securityId, symbol, lotSize, CAST(strikePrice AS REAL) AS strikePrice, expiryDate
       FROM master_contracts
      WHERE underlying = ? AND instrument = 'OPTSTK' AND segment = 'NSE_FNO' AND optionType = ?
        AND substr(expiryDate, 1, 10) = ?
      ORDER BY ABS(CAST(strikePrice AS REAL) - ?) ASC
      LIMIT 1`,
    symbol,
    side,
    selectedExpiry,
    spot
  );
  const row = rows[0];
  if (!row) return null;
  // master_contracts.expiryDate is DateTime in Prisma — raw queries hand it
  // back as a JS Date, whose String() is "Tue Jul 28 …". Normalize to ISO.
  const expiry = new Date(row.expiryDate);
  return {
    optionType: side,
    strike: row.strikePrice,
    expiryDate: Number.isNaN(expiry.getTime())
      ? String(row.expiryDate).slice(0, 10)
      : expiry.toISOString().slice(0, 10),
    lotSize: Number(row.lotSize),
    optSecurityId: row.securityId,
    optSymbol: row.symbol,
    premium: null, // filled by attachPremiums when a live quote exists
  };
}

// ─── The run ─────────────────────────────────────────────────────────────────
// (Composite score + spot-plan math live in scoring.ts, shared with the
//  offline replay harness — scripts/replay-window.ts.)

export async function runTradeSuggest(
  _origin: string,
  opts: { force?: boolean; candidateSnapshot?: CandidateSnapshot } = {}
): Promise<SuggestResponse> {
  // Internal fetches always go to loopback (the container can't reach its own
  // public URL) — the caller's origin is accepted for signature compat but ignored.
  const origin = internalOrigin();
  const date = todayIST();
  // Scanner window bounds: runtime-tunable from /config (minutes-of-day IST),
  // defaults = the strategy's proven 09:40–11:00.
  let [windowStartMin, windowEndMin] = await Promise.all([
    getNumberSetting('WINDOW_START_MIN', WINDOW_START_MIN),
    getNumberSetting('WINDOW_END_MIN', WINDOW_END_MIN),
  ]);
  if (windowStartMin >= windowEndMin) {
    windowStartMin = WINDOW_START_MIN;
    windowEndMin = WINDOW_END_MIN;
  }
  const window = windowState(windowStartMin, windowEndMin);
  const base: SuggestResponse = {
    success: true,
    window,
    marketOpen: isMarketHours(),
    date,
    scanned: 0,
    gated: {},
    suggestions: [],
    earlierToday: await getSuggestions(date),
  };

  // SCAN_OUTSIDE_WINDOW turns the 09:40–11:00 gate advisory: scans run any
  // time the market is open. Resolved before the early return; the market-
  // closed guard below still applies (no live quotes = no suggestions).
  const scanOutsideWindow = await getToggle('SCAN_OUTSIDE_WINDOW', SCAN_OUTSIDE_WINDOW);
  if (!window.active && !opts.force && !(scanOutsideWindow && base.marketOpen)) {
    base.note = base.marketOpen
      ? `Outside the suggestion window (${window.opensAt}–${window.closesAt}).`
      : 'Market is closed.';
    return base;
  }
  if (!window.active && base.marketOpen) {
    base.note = `Out-of-window scan (${scanOutsideWindow ? 'SCAN_OUTSIDE_WINDOW is ON' : 'forced'}) — entries outside ${window.opensAt}–${window.closesAt} are unproven for this strategy.`;
  }
  if (!base.marketOpen) {
    base.note = 'Market is closed — live quotes unavailable, no suggestions possible.';
    return base;
  }

  // Runtime feature toggles (flipped from /config; config.ts values are the
  // defaults/fallback). Resolved once here, not per-candidate.
  const useBreakoutBypass = await getToggle('USE_BREAKOUT_BYPASS', USE_BREAKOUT_BYPASS);
  const excludeExtended = await getToggle('EXCLUDE_EXTENDED', EXCLUDE_EXTENDED);
  const useExtendedTrendBypass = await getToggle('USE_EXTENDED_TREND_BYPASS', USE_EXTENDED_TREND_BYPASS);
  const useTfBreakoutGate = await getToggle('USE_TF_BREAKOUT_GATE', USE_TF_BREAKOUT_GATE);
  const useMomentumBreakout = await getToggle('USE_MOMENTUM_BREAKOUT', USE_MOMENTUM_BREAKOUT);
  const useChaoticOpenGate = await getToggle('USE_CHAOTIC_OPEN_GATE', USE_CHAOTIC_OPEN_GATE);
  const useRankClimbGate = await getToggle('USE_RANK_CLIMB_GATE', USE_RANK_CLIMB_GATE);
  const maxPicks = await getNumberSetting('MAX_PICKS', MAX_PICKS);
  // Capital budget = the auto-trade page's editable maxCapitalRupees (one source
  // of truth). A pick whose single lot costs more than this is skipped, so the
  // scanner only surfaces contracts THIS account can actually afford (e.g. ₹30k
  // Dhan balance -> only ≤₹30k/lot picks). getAutoTradeSettings never throws —
  // falls back to its default (= CAPITAL_BUDGET) on a DB hiccup.
  const capitalBudget = (await getAutoTradeSettings()).maxCapitalRupees || CAPITAL_BUDGET;

  // 1. Candidates from the live NSE feeds (F&O-gated, sector attached),
  //    widened to the full tracked universe when SCAN_FULL_UNIVERSE is on
  const candidateSnapshot = opts.candidateSnapshot ?? (await discoverCandidateSnapshot());
  const sectorBySymbol = new Map(candidateSnapshot.sectorEntries);
  const oiSpurtSymbols = new Set(candidateSnapshot.oiSpurtSymbols);
  // Names suggested EARLIER today stay in the quote batch even after they drop
  // off the movers lists / below the gates: an open position needs its live
  // price all day so the commentary can call HOLD / EXIT with real numbers
  // (Jul-10 lesson: "OFSS, KPITTECH — DROPPED from screen entirely" left the
  // narrator blind on open calls). ≤ a handful of extra symbols in the same
  // single batched Dhan request — no extra API calls.
  const earlierToday = await getSuggestions(date);
  for (const e of earlierToday) {
    if (!sectorBySymbol.has(e.symbol)) sectorBySymbol.set(e.symbol, e.sector ?? '');
  }
  const symbols = [...sectorBySymbol.keys()];
  base.scanned = symbols.length;
  if (symbols.length === 0) {
    base.note = 'No candidates from the NSE watchlist feeds (feeds may be throttled — retry next iteration).';
    return base;
  }

  // 2. One batched live snapshot
  const quotes = await fetchQuotes(origin, symbols);
  const marketDataAsOfMs = Date.parse(quotes.asOf ?? '');
  base.marketDataAsOfMs = Number.isFinite(marketDataAsOfMs) ? marketDataAsOfMs : undefined;
  if (!quotes.success || quotes.rows.length === 0) {
    base.note = `Live quote path returned no rows${quotes.error ? ` (${quotes.error})` : ''} — check /api/dhan/token.`;
    return base;
  }

  // NSE oi-spurts rows — one shared-cache call; the alternate OI-evidence path
  // for options-led builds. Full rows (not just the %-change) so the gate can
  // check the build is GENUINELY options-led (optShare) and the options
  // tradeable (premValue), not just infer it from combined-OI %-change.
  const nseOiRowMap = await getNseOiRowMap();

  // Rank-climb catch path input (USE_RANK_CLIMB_GATE): best ~30-min leaderboard
  // climb per symbol (gainers/OI boards) from today's rank_snapshots. One local
  // query per scan; empty map when the toggle is off or history is thin — a
  // name absent here simply cannot qualify via the climb path.
  const rankClimbBySymbol = useRankClimbGate ? await getRecentRankClimbs(date) : new Map<string, number>();

  // Position-management feed: every earlier-today call with its live price,
  // regardless of whether the name still clears any gate this scan.
  base.tracked = earlierToday.map((e) => ({
    symbol: e.symbol,
    side: e.optionType,
    direction: e.optionType === 'CE' ? ('bullish' as const) : ('bearish' as const),
    entrySpot: e.spotAtSuggest,
    slSpot: e.slSpot,
    targetSpot: e.targetSpot,
    ltp: quotes.rows.find((r) => r.symbol === e.symbol)?.ltp ?? null,
    suggestedAt: e.suggestedAt,
  }));

  // Market tilt + sector flow among the scanned candidates — CONTEXT ONLY,
  // never a gate (replay 2026-07-03: a tilt gate would have blocked the day's
  // one winner). Basis is change-from-OPEN (what the live rows carry).
  let tiltUp = 0;
  let tiltDown = 0;
  let tiltFlat = 0;
  const flowBySector = new Map<string, { names: number; chgSum: number; chgN: number; oiSpurts: number }>();
  for (const row of quotes.rows) {
    const chg = row.changePctOpen;
    if (chg == null || chg === 0) tiltFlat++;
    else if (chg > 0) tiltUp++;
    else tiltDown++;
    const sector = sectorBySymbol.get(row.symbol) ?? '';
    if (sector) {
      const f = flowBySector.get(sector) ?? {
        names: 0,
        chgSum: 0,
        chgN: 0,
        oiSpurts: 0,
      };
      f.names++;
      if (chg != null) {
        f.chgSum += chg;
        f.chgN++;
      }
      if (oiSpurtSymbols.has(row.symbol)) f.oiSpurts++;
      flowBySector.set(sector, f);
    }
  }
  base.tilt = {
    up: tiltUp,
    down: tiltDown,
    flat: tiltFlat,
    basis: 'since-open',
    lean: tiltUp > tiltDown * 1.5 ? 'CE' : tiltDown > tiltUp * 1.5 ? 'PE' : 'neutral',
  };
  base.sectorFlow = [...flowBySector.entries()]
    .map(([sector, f]) => ({
      sector,
      names: f.names,
      avgChgPct: f.chgN > 0 ? Math.round((f.chgSum / f.chgN) * 100) / 100 : null,
      oiSpurts: f.oiSpurts,
    }))
    .sort((a, b) => (b.avgChgPct ?? 0) - (a.avgChgPct ?? 0));

  // Sector ACTIVITY rank (SHADOW evidence, NOT a gate/score): order sectors by
  // how many of their names sit on NSE's OI build-up list — the big-player-
  // activity proxy the whole strategy keys on — tie-broken by the size of the
  // sector's turnover move. Each pick is stamped with its sector's rank so we
  // can later MEASURE whether picks from low-activity sectors underperform
  // (the COLPAL/FMCG complaint, 2026-07-20) before sector strength ever gates.
  // 1 = most active.
  const sectorActivityRank = new Map<string, number>();
  [...base.sectorFlow]
    .sort((a, b) => b.oiSpurts - a.oiSpurts || Math.abs(b.avgChgPct ?? 0) - Math.abs(a.avgChgPct ?? 0))
    .forEach((f, i) => sectorActivityRank.set(f.sector, i + 1));

  // Sector STRENGTH per the heatmap's own aggregation (turnover-weighted move
  // + advance/decline breadth — lib/sector/aggregate.ts), from the quote rows
  // already in hand. DISPLAY EVIDENCE on picks, deliberately not a gate or
  // score input until the replay benchmark proves it (same rule as the
  // combined-OI slope; a market-wide tilt gate already failed that test).
  const sectorAgg = new Map<string, SectorAggregate>(
    aggregateSectors(
      quotes.rows
        .map((r) => ({
          sector: sectorBySymbol.get(r.symbol) ?? '',
          pct: r.changePctOpen ?? 0,
          turnover: r.turnover ?? 0,
        }))
        .filter((t) => t.sector)
    ).map((a) => [a.sector, a])
  );

  // 3. Detect market regime (once per scan, using first available symbol as
  //    proxy for the broad market). The regime adjusts the confidence threshold
  //    dynamically: relax in good regimes, tighten in bad ones.
  let regimeMultiplier = 1.0;
  let regimeLabel = 'no regime data';
  try {
    // Pick the first symbol with candles for regime detection
    for (const sym of symbols.slice(0, 5)) {
      const regimeBars = await getFyersCandles(sym, date, 'EQ');
      if (regimeBars.length >= 30) {
        const regime = detectRegime(regimeBars);
        regimeMultiplier = regime.confidenceMultiplier;
        regimeLabel = regime.label;
        console.log(`${TAG} regime: ${regimeLabel} → confidence×${regimeMultiplier.toFixed(2)}`);
        break;
      }
    }
  } catch {
    // Regime detection is best-effort
  }
  const dynamicMinConfidence = MIN_CONFIDENCE * regimeMultiplier;

  // Gate + enrich
  const gated: Record<string, number> = {
    noPrice: 0,
    illiquid: 0,
    neutralBias: 0,
    weakRFactor: 0,
    lowConfidence: 0,
    lowOiLevel: 0,
    lowTurnover: 0,
    directionDisagree: 0,
    quietSetup: 0,
  };

  interface Enriched {
    row: LiveUrgencyRow;
    sector: string;
    direction: 'bullish' | 'bearish';
    orBreakout: boolean;
    bars: StoredFyersBar[];
    or: { openRangeHigh: number | null; openRangeLow: number | null };
    setupLevel: string;
    setupReasons: string[];
    extended: boolean;
    /** True when an extended name was re-admitted by the trend-aligned bypass. */
    extendedBypassed?: boolean;
    nseOiPct: number | null;
    /** Options share of fut+opt value (NSE oi-spurts) — how options-led the build is. */
    optShare: number | null;
    /** True when admitted via the momentum-breakout path (accumulation gates bypassed). */
    momentumPath: boolean;
    /** True when the OI gate passed ONLY via the breakout bypass (price broke out,
     *  no OI evidence). Recorded so these admissions are visible in the Trade Log
     *  — every other permissive path already stamps a reason, this one did not,
     *  which made the toggle impossible to evaluate (audit 2026-07-23). */
    breakoutBypassPath: boolean;
    /** Opening 15-min range ÷ settled 5-min ATR (chaotic-open.ts); null = not yet computable. */
    chaosRatio: number | null;
    /** Best ~30-min leaderboard climb (gainers/OI boards); null = no board history. */
    rankClimb: number | null;
    /** True when the OI gate passed via the rank-climb catch path (NSE 1–5% + climbing). */
    climbPath: boolean;
    score: number;
  }
  const survivors: Enriched[] = [];

  for (const row of quotes.rows) {
    const ltp = row.ltp ?? 0;
    if (ltp <= 0) {
      gated.noPrice++;
      continue;
    }
    const verdict = setupScore(row);
    if (verdict.level === 'illiquid' || row.spreadPct == null || row.spreadPct > MAX_SPREAD_PCT) {
      gated.illiquid++;
      continue;
    }
    if (row.rFactorBias == null || row.rFactorBias === 'neutral') {
      gated.neutralBias++;
      continue;
    }
    // Direction + candles + breakout + trend indicators are computed BEFORE the
    // R-Factor/confidence gates so the momentum-breakout path (and the OI-gate
    // breakout bypass below) can use them; the same values feed the Supertrend/
    // VWAP hard gates and the pick's plan — one computation, no duplicates.
    // (Costs a candle read for names the R gate would have dropped — local
    // SQLite, same order the replay harness already uses.)
    const direction = row.rFactorBias === 'buy' ? 'bullish' : 'bearish';
    const bars = await getFyersCandles(row.symbol, date, 'EQ');
    const sc = deriveSessionContext(bars);
    const orBreakout =
      sc.openRangeComplete &&
      (direction === 'bullish'
        ? sc.openRangeHigh != null && ltp > sc.openRangeHigh
        : sc.openRangeLow != null && ltp < sc.openRangeLow);
    const st = supertrend(bars);
    const vw = sessionVwap(bars);
    const supertrendAligned =
      st == null ? null : direction === 'bullish' ? st.direction === 'up' : st.direction === 'down';
    const vwapAligned = vw == null ? null : direction === 'bullish' ? ltp > vw : ltp < vw;

    // Momentum-breakout path (USE_MOMENTUM_BREAKOUT, off by default): a
    // confirmed OR breakout with BOTH trend indicators agreeing and a real move
    // behind it clears the R-Factor, confidence, OI and quiet-setup gates — the
    // short-covering class every accumulation factor rejects by design
    // (ADANIGREEN 2026-07-14; see momentum-breakout.ts). All other gates apply.
    const momentumOk =
      useMomentumBreakout &&
      qualifiesMomentumBreakout(
        {
          orBreakout,
          supertrendAligned,
          vwapAligned,
          changePctOpen: row.changePctOpen,
          direction,
        },
        { minChangePct: MOMENTUM_MIN_CHANGE_PCT }
      );
    if (momentumOk) gated.momentumAdmitted = (gated.momentumAdmitted ?? 0) + 1;

    if (!momentumOk && (row.rFactor ?? 0) < MIN_RFACTOR) {
      gated.weakRFactor++;
      continue;
    }
    if (!momentumOk && (row.rFactorConfidence ?? 0) < dynamicMinConfidence) {
      gated.lowConfidence++;
      continue;
    }

    // OI evidence, three paths: sustained futures positioning (level vs 20-day
    // avg) OR an options-led build futures-only OI misses (NSE combined OI
    // change — the SUNPHARMA lesson, 2026-07-03) OR, when USE_BREAKOUT_BYPASS
    // is on, a confirmed trend-aligned breakout with no OI yet (the price leads
    // its OI — ADANIENSOL/NAUKRI; see breakout-bypass.ts).
    const futOiOk = (row.oiLevel ?? 0) >= MIN_OI_LEVEL;
    const oiRow = nseOiRowMap.get(row.symbol) ?? null;
    const nseOiPct = oiRow?.changeInOiPct ?? null;
    const optShare = oiRow?.optShare ?? null;
    const premValueCr = oiRow?.premValueCr ?? null;
    // Options-led path: the combined-OI build must be real (%-change), actually
    // options-led (optShare above the single-stock norm) AND tradeable (premium
    // pool above the thin-liquidity floor) — see MIN_OPT_SHARE / MIN_OPT_PREMIUM_CR.
    const nseOptionsLegsOk =
      optShare != null && optShare >= MIN_OPT_SHARE && premValueCr != null && premValueCr >= MIN_OPT_PREMIUM_CR;
    // Rank-climb CATCH path (USE_RANK_CLIMB_GATE): today's ≥MIN_NSE_OI_PCT rule
    // is untouched; ADDITIONALLY a smaller build (≥RANK_CLIMB_MIN_NSE_OI_PCT)
    // qualifies when the name is actively climbing the gainers/OI leaderboard —
    // the ADANIENSOL profile (config.ts doc). A name with no board history has
    // no climb evidence and does NOT qualify via this path.
    const rankClimbSpots = rankClimbBySymbol.get(row.symbol) ?? null;
    const climbCatchOk =
      useRankClimbGate &&
      nseOiPct != null &&
      nseOiPct >= RANK_CLIMB_MIN_NSE_OI_PCT &&
      nseOiPct < MIN_NSE_OI_PCT &&
      nseOptionsLegsOk &&
      rankClimbSpots != null &&
      rankClimbSpots >= RANK_CLIMB_MIN_SPOTS;
    const nseOiOk = (nseOiPct != null && nseOiPct >= MIN_NSE_OI_PCT && nseOptionsLegsOk) || climbCatchOk;
    if (climbCatchOk) gated.climbAdmitted = (gated.climbAdmitted ?? 0) + 1;
    let breakoutOk = false;
    if (useBreakoutBypass && !futOiOk && !nseOiOk && orBreakout) {
      breakoutOk = qualifiesByBreakout(
        { orBreakout, supertrendAligned, vwapAligned, rFactor: row.rFactor },
        {
          minRFactor: BREAKOUT_BYPASS_MIN_RFACTOR,
          requireTrendAlign: BREAKOUT_BYPASS_REQUIRE_TREND,
        }
      );
    }
    if (!futOiOk && !nseOiOk && !breakoutOk && !momentumOk) {
      gated.lowOiLevel++;
      continue;
    }
    // Third TF pillar: turnover ≥1.2× its time-adjusted 20-day average. The
    // R-Factor turnover score encodes the ratio (score = (ratio−1)/2), so the
    // gate reads the factor instead of re-deriving the ratio.
    const turnoverFactor = row.rFactors?.find((f) => f.label.startsWith('Turnover'));
    if (!turnoverFactor?.available || turnoverFactor.score < MIN_TURNOVER_SCORE) {
      gated.lowTurnover++;
      continue;
    }

    // Price must agree with the bias: moving the right way since open, or an OR breakout.
    const chg = row.changePctOpen ?? 0;
    const priceAgrees = direction === 'bullish' ? chg > 0 || orBreakout : chg < 0 || orBreakout;
    if (!priceAgrees) {
      gated.directionDisagree++;
      continue;
    }

    // Supertrend(10,3) alignment gate — replay benchmark (July 10-13) showed
    // 0/3 wins for Supertrend-misaligned picks. Enforce as a hard gate
    // (computed once above; null = not yet computable = gate skipped).
    if (supertrendAligned === false) {
      gated.supertrendDisagree = (gated.supertrendDisagree ?? 0) + 1;
      continue;
    }

    // Session VWAP alignment gate — price must be on the correct side of VWAP.
    if (vwapAligned === false) {
      gated.vwapDisagree = (gated.vwapDisagree ?? 0) + 1;
      continue;
    }

    if (verdict.level === 'quiet' && !momentumOk) {
      gated.quietSetup++;
      continue;
    }

    // EXPERIMENTAL TF-breakout gate (USE_TF_BREAKOUT_GATE, off by default):
    // require the TF 3-check verdict — morning level held + ≥1 named level
    // cleared — in the trade's direction. The verdict rides in on the live row
    // (computed by /api/live/quote from lib/breakout); null (candles not
    // recorded yet) fails the gate, transparently counted. Evidence status in
    // config.ts — do not enable without a replay A/B.
    if (useTfBreakoutGate) {
      const b = row.breakout;
      const tfOk = b != null && (b.grade === 'confirmed' || b.grade === 'strong') && b.direction === direction;
      if (!tfOk) {
        gated.tfBreakoutGate = (gated.tfBreakoutGate ?? 0) + 1;
        continue;
      }
    }

    // EXPERIMENTAL chaotic-open gate (USE_CHAOTIC_OPEN_GATE): skip a name whose
    // opening 15 min was a violent spike vs its own settled 5-min ATR — the
    // HYUNDAI/SRF "blow the energy at the open, then fade" loser profile
    // (evidence + caveat in chaotic-open.ts). Null ratio (early session, thin
    // bars) skips the gate, never blocks.
    const chaosRatio = chaoticOpenRatio(bars);
    if (useChaoticOpenGate && chaosRatio != null && chaosRatio > CHAOTIC_OPEN_MAX_RATIO) {
      gated.chaoticOpen = (gated.chaoticOpen ?? 0) + 1;
      continue;
    }

    survivors.push({
      row,
      sector: sectorBySymbol.get(row.symbol) ?? '',
      direction,
      orBreakout,
      bars,
      or: { openRangeHigh: sc.openRangeHigh, openRangeLow: sc.openRangeLow },
      setupLevel: verdict.level,
      setupReasons: verdict.reasons,
      extended: verdict.extended,
      nseOiPct,
      optShare,
      momentumPath: momentumOk,
      // Credit the bypass only when it is what actually opened the door: if the
      // momentum path also qualified this name, the bypass was not load-bearing
      // and marking it would overstate the toggle's contribution.
      breakoutBypassPath: breakoutOk && !momentumOk,
      chaosRatio,
      rankClimb: rankClimbSpots,
      climbPath: climbCatchOk,
      score: 0,
    });
  }

  // 4. Sector breadth among survivors (same sector, same direction = confirmation)
  const breadth = new Map<string, number>();
  for (const s of survivors) {
    if (!s.sector) continue;
    const key = `${s.sector}:${s.direction}`;
    breadth.set(key, (breadth.get(key) ?? 0) + 1);
  }

  // 5. Composite score (shared math — scoring.ts; extended movers penalized
  //    inside, evidence: 2026-07-03 window reconstruction)
  for (const s of survivors) {
    const r = s.row;
    s.score = computeCompositeScore({
      rFactor: r.rFactor,
      confidence: r.rFactorConfidence,
      oiUrgency: r.oiUrgency,
      oiLevel: r.oiLevel,
      orBreakout: s.orBreakout,
      imbalance: r.imbalance,
      direction: s.direction,
      sectorPeers: breadth.get(`${s.sector}:${s.direction}`) ?? 1,
      setupLevel: s.setupLevel,
      extended: s.extended,
    });
  }
  survivors.sort((a, b) => b.score - a.score);

  // 6. Resolve contracts + live premiums for the top candidates (oversampled so
  //    an unaffordable contract can be replaced by the next qualified name),
  //    then keep the first MAX_PICKS that fit the capital budget.
  //    Extended movers (≥3% from open) are hard-skipped here when
  //    EXCLUDE_EXTENDED — 0-for-5 evidence, see config.
  const shortlist = survivors
    .filter((s) => {
      // Not gated (not extended, or the hard ban is off) → keep.
      if (!(excludeExtended && s.extended)) return true;
      // Extended AND the hard ban is on. Trend-aligned bypass (opt-in): a genuine
      // trend-day continuation — breakout still extending, price holding VWAP,
      // Supertrend aligned — is re-admitted; a spent spike that lost VWAP/Supertrend
      // is not (the 0-for-5 chase profile). The score still carries the extended
      // ×0.6 penalty (computed above), so a bypassed name ranks conservatively.
      if (useExtendedTrendBypass) {
        const ltp = s.row.ltp ?? 0;
        const vw = sessionVwap(s.bars);
        const st = supertrend(s.bars);
        const vwapAligned = vw == null ? null : s.direction === 'bullish' ? ltp > vw : ltp < vw;
        const supertrendAligned =
          st == null ? null : s.direction === 'bullish' ? st.direction === 'up' : st.direction === 'down';
        if (
          qualifiesExtendedTrend(
            {
              orBreakout: s.orBreakout,
              supertrendAligned,
              vwapAligned,
              rFactor: s.row.rFactor,
            },
            {
              minRFactor: EXTENDED_BYPASS_MIN_RFACTOR,
              requireSupertrend: EXTENDED_BYPASS_REQUIRE_SUPERTREND,
            }
          )
        ) {
          s.extendedBypassed = true;
          return true;
        }
      }
      gated.extendedMover = (gated.extendedMover ?? 0) + 1;
      return false;
    })
    .slice(0, maxPicks + PICK_OVERSAMPLE);
  const factorBaselines = await loadFactorBaselines(shortlist.map((s) => s.row.symbol));
  const sessionFrac = Math.min(1, Math.max(0.02, (istNow().minuteOfDay - (9 * 60 + 15)) / 375));
  const optionBySymbol = new Map<string, OptionPlan | null>();
  for (const s of shortlist) {
    const side: 'CE' | 'PE' = s.direction === 'bullish' ? 'CE' : 'PE';
    optionBySymbol.set(s.row.symbol, await resolveAtmOption(s.row.symbol, s.row.ltp ?? 0, side, date));
  }
  // Display the stop/risk policy that will ACTUALLY fire, not the coded default:
  // both values are runtime-editable on /auto-trade, and the scanner previously
  // hard-coded them, so changing the setting silently desynced what the page
  // showed from what the guard enforced (PR#18 review). Best-effort — a settings
  // read must never break a scan, and getAutoTradeSettings already fails safe.
  let premiumPolicy: PremiumPolicy | undefined;
  try {
    const at = await getAutoTradeSettings();
    premiumPolicy = { stopPct: at.optionStopPct, maxRiskPerLot: at.maxRiskPerLotRupees };
  } catch {
    premiumPolicy = undefined; // fall back to the coded defaults inside attachPremiums
  }
  await attachPremiums(
    [...optionBySymbol.values()].filter((o): o is OptionPlan => o !== null),
    premiumPolicy
  );

  const picks: TradeSuggestion[] = [];
  let skippedUnaffordable = 0;
  // One informational requirement for the whole scan, so picks cannot receive
  // different bucket stamps if construction crosses a five-minute boundary.
  const informationalRequiredBucketTs = requiredCompletedBucket(Date.now());
  for (const s of shortlist) {
    if (picks.length >= maxPicks) break;
    const r = s.row;
    const ltp = r.ltp ?? 0;
    const side: 'CE' | 'PE' = s.direction === 'bullish' ? 'CE' : 'PE';
    const option = optionBySymbol.get(r.symbol) ?? null;
    if (!option) console.warn(`${TAG} no OPTSTK contract for ${r.symbol} — suggesting without contract details`);
    if (option?.premium && option.premium.perLotCost > capitalBudget) {
      skippedUnaffordable++;
      console.log(
        `${TAG} ${r.symbol} skipped: one lot costs ₹${Math.round(option.premium.perLotCost).toLocaleString('en-IN')} > ₹${capitalBudget.toLocaleString('en-IN')} budget`
      );
      continue;
    }
    const a14 = atr(s.bars);
    const plan = buildSpotPlan(side, ltp, s.bars, s.or, fyersBucketFor(Date.now()), {
      atr: a14,
      atrMult: SL_ATR_MULT,
    });

    // Display factors — evidence for the trader, deliberately not gates (see
    // types.PickFactors for the replay findings behind that call).
    const vw = sessionVwap(s.bars);
    const st = supertrend(s.bars);
    const fb = factorBaselines.get(r.symbol);
    const eqTurnNow = s.bars.reduce((acc, b) => acc + b.close * b.volume, 0);
    const eqTurnoverRatio =
      fb?.eqTurnover20dAvg != null && eqTurnNow > 0
        ? Math.round((eqTurnNow / (fb.eqTurnover20dAvg * sessionFrac)) * 100) / 100
        : null;
    const combinedOiLevel =
      fb?.combinedOiPrev != null && fb.combinedOi20dAvg != null && s.nseOiPct != null
        ? Math.round(((fb.combinedOiPrev * (1 + s.nseOiPct / 100)) / fb.combinedOi20dAvg) * 1000) / 1000
        : null;
    // Combined-OI build RATE over the trailing ~30 min, from the per-5-min
    // nseOiPct series the poller persists — distinguishes "building right now"
    // from a stale morning print (the snapshot above can't). Display evidence,
    // not a gate, until the replay benchmark says otherwise.
    let combinedOiSlope30m: number | null = null;
    try {
      combinedOiSlope30m = combinedOiSlope(await getNseOiSeries(r.symbol, date), Math.floor(Date.now() / 1000));
    } catch (err) {
      console.warn(`${TAG} combined-OI slope failed for ${r.symbol}: ${(err as Error).message}`);
    }
    // Sector alignment: is the pick swimming with its sector's turnover-weighted
    // move? Null when the sector is missing or too flat (<0.1%) to call.
    const sa = sectorAgg.get(s.sector) ?? null;
    const sectorPct = sa == null ? null : Math.round(sa.weightedPct * 100) / 100;
    const sectorAligned =
      sa == null || Math.abs(sa.weightedPct) < 0.1
        ? null
        : s.direction === 'bullish'
          ? sa.weightedPct > 0
          : sa.weightedPct < 0;
    const factors = {
      vwap: vw == null ? null : Math.round(vw * 100) / 100,
      vwapAligned: vw == null ? null : side === 'CE' ? ltp > vw : ltp < vw,
      supertrend: st?.direction ?? null,
      supertrendLine: st == null ? null : Math.round(st.line * 100) / 100,
      supertrendAligned: st == null ? null : side === 'CE' ? st.direction === 'up' : st.direction === 'down',
      atr: a14 == null ? null : Math.round(a14 * 100) / 100,
      atrPct: a14 == null || ltp <= 0 ? null : Math.round((a14 / ltp) * 10000) / 100,
      eqTurnoverRatio,
      combinedOiLevel,
      combinedOiSlope30m,
      nseOiPct: s.nseOiPct,
      onOiSpurtList: oiSpurtSymbols.has(r.symbol),
      sectorPct,
      sectorAdvanceRatio: sa?.advanceRatio == null ? null : Math.round(sa.advanceRatio * 100) / 100,
      sectorAligned,
    };

    // SHADOW sector-activity evidence (not a gate/score): where this pick's
    // sector ranks among all scanned sectors by OI activity. Evidence only.
    const sectorRank = sectorActivityRank.get(s.sector) ?? null;
    const sectorRankTotal = sectorActivityRank.size;
    const sectorTopN = Math.min(5, sectorRankTotal);
    const sectorActivityReason =
      sectorRank != null && sectorRankTotal > 0
        ? sectorRank <= sectorTopN
          ? `sector activity (shadow): ${s.sector} is a top-${sectorTopN} sector by OI activity (#${sectorRank} of ${sectorRankTotal})`
          : `⚠ sector activity (shadow): ${s.sector} ranks #${sectorRank} of ${sectorRankTotal} by OI activity — not a leading sector (evidence only, not gated)`
        : null;

    const reasons = [
      ...(s.extended
        ? [
            s.extendedBypassed
              ? `⚠ extended ${(r.changePctOpen ?? 0) >= 0 ? '+' : ''}${(r.changePctOpen ?? 0).toFixed(1)}% from open but trend-aligned (breakout + Supertrend + VWAP) — extended-trend bypass admitted it, score still penalized`
              : `⚠ already moved ${(r.changePctOpen ?? 0) >= 0 ? '+' : ''}${(r.changePctOpen ?? 0).toFixed(1)}% from open — late to chase, score penalized`,
          ]
        : []),
      ...(s.momentumPath
        ? [
            '⚡ MOMENTUM-BREAKOUT path: no accumulation evidence (low R-Factor / no OI build) — entered on confirmed OR breakout + Supertrend + VWAP + move ≥1.5%. Short-covering profile; expect speed, respect the stop.',
          ]
        : []),
      ...(s.breakoutBypassPath
        ? [
            '🚪 BREAKOUT-BYPASS path: both OI gates failed (no futures build, no qualifying NSE combined build) — admitted on a confirmed OR breakout with Supertrend + VWAP agreeing and R-Factor ≥ 3.6. Price led, open interest did not confirm.',
          ]
        : []),
      `R-Factor ${r.rFactor?.toFixed(2)} (${s.direction}, confidence ${((r.rFactorConfidence ?? 0) * 100).toFixed(0)}%)`,
      `futures OI ${r.oiLevel?.toFixed(2)}× 20-day avg${r.oiUrgency != null && r.oiUrgency > 0 ? `, urgency ${r.oiUrgency.toFixed(1)}/10` : ''}`,
      ...(s.nseOiPct != null && (s.nseOiPct >= MIN_NSE_OI_PCT || s.climbPath)
        ? [
            `NSE combined OI ${s.nseOiPct >= 0 ? '+' : ''}${s.nseOiPct.toFixed(1)}% (futures+options${(r.oiLevel ?? 0) < MIN_OI_LEVEL ? ' — options-led build' : ''}${s.optShare != null ? `, opt-share ${(s.optShare * 100).toFixed(0)}%` : ''})`,
          ]
        : []),
      // Rank-climb catch path (USE_RANK_CLIMB_GATE): flag the admission loudly —
      // the OI build is BELOW the usual 5% bar and the leaderboard trajectory is
      // what let it in. Plus the plain climb evidence on every pick that has
      // board history, so the nightly scorecard accrues per-climb outcomes.
      ...(s.climbPath
        ? [
            `🪜 RANK-CLIMB catch path: combined OI below the ${MIN_NSE_OI_PCT}% norm, but the name is climbing the movers board +${s.rankClimb} spots/~30 min with qualifying options flow (ADANIENSOL profile) — smaller evidence base, respect the stop.`,
          ]
        : s.rankClimb != null
          ? [
              `leaderboard ${s.rankClimb > 0 ? `climbing +${s.rankClimb}` : s.rankClimb < 0 ? `slipping ${s.rankClimb}` : 'holding ±0'} spots/~30 min (best of gainers/OI boards)`,
            ]
          : []),
      ...(combinedOiLevel != null && combinedOiLevel >= 1.1
        ? [`combined fut+opt OI ≈${combinedOiLevel.toFixed(2)}× 20-day avg (derived from bhavcopy + NSE live %)`]
        : []),
      ...(combinedOiSlope30m != null && combinedOiSlope30m >= 1
        ? [`combined OI +${combinedOiSlope30m.toFixed(1)} pts in the last ~30 min — build is live, not a stale print`]
        : combinedOiSlope30m != null && combinedOiSlope30m <= -1
          ? [`⚠ combined OI ${combinedOiSlope30m.toFixed(1)} pts in the last ~30 min — the build is unwinding`]
          : []),
      s.orBreakout
        ? 'trading beyond the opening range (breakout confirmed)'
        : 'inside opening range — breakout not yet confirmed',
      // Open character (chaotic-open.ts): stamped on every pick so the nightly
      // scorecard accrues win/loss evidence per opening profile.
      ...(s.chaosRatio != null
        ? [
            s.chaosRatio > CHAOTIC_OPEN_MAX_RATIO
              ? `⚠ chaotic open: first 15 min ranged ${s.chaosRatio.toFixed(1)}× the stock's settled 5-min ATR (gate threshold ${CHAOTIC_OPEN_MAX_RATIO}×)`
              : `calm open: first 15 min ranged ${s.chaosRatio.toFixed(1)}× the stock's settled 5-min ATR`,
          ]
        : []),
      ...(r.breakout != null && r.breakout.grade !== 'none'
        ? [
            r.breakout.grade === 'fakeout-risk'
              ? `⚠ TF breakout check: ${r.breakout.detail}`
              : `TF breakout check (${r.breakout.grade}): ${r.breakout.detail}`,
          ]
        : []),
      ...(st != null
        ? [
            factors.supertrendAligned
              ? `Supertrend(10,3) agrees: ${st.direction === 'up' ? 'uptrend' : 'downtrend'} on the 5-min, line ${st.line.toFixed(2)}`
              : `⚠ Supertrend(10,3) disagrees (${st.direction === 'up' ? 'uptrend' : 'downtrend'} on the 5-min) — misaligned picks went 0/3 on the replay benchmark`,
          ]
        : []),
      ...(vw != null
        ? [
            `${side === 'CE' ? (ltp > vw ? 'above' : '⚠ below') : ltp < vw ? 'below' : '⚠ above'} session VWAP ${vw.toFixed(2)}`,
          ]
        : []),
      ...(eqTurnoverRatio != null && eqTurnoverRatio >= 3
        ? [
            `equity turnover ≈${eqTurnoverRatio.toFixed(1)}× its time-adjusted 20-day pace (mornings naturally over-read ~2×)`,
          ]
        : []),
      ...(factors.onOiSpurtList ? ["on NSE's OI build-up list (big-player positioning)"] : []),
      ...(sa != null && sectorAligned != null
        ? [
            sectorAligned
              ? `sector agrees: ${s.sector} ${sectorPct! >= 0 ? '+' : ''}${sectorPct!.toFixed(2)}% (turnover-weighted), ${sa.advancers}↑/${sa.decliners}↓`
              : `⚠ fighting its sector: ${s.sector} ${sectorPct! >= 0 ? '+' : ''}${sectorPct!.toFixed(2)}% (turnover-weighted), ${sa.advancers}↑/${sa.decliners}↓`,
          ]
        : []),
      ...((breadth.get(`${s.sector}:${s.direction}`) ?? 1) > 1
        ? [`sector confirmation: ${breadth.get(`${s.sector}:${s.direction}`)} ${s.sector} names moving ${s.direction}`]
        : []),
      ...(sectorActivityReason ? [sectorActivityReason] : []),
      ...s.setupReasons,
    ];

    // Candle freshness stamp: prove the REQUIRED completed bucket was FINALIZED
    // (written after it closed), matching the placement-time gate — the forming
    // bar being present is not proof. Informational here (the auto-trade gate
    // re-checks from the store at placement); priority/sector fields stay empty
    // until the priority-refresh planner is wired into the scanner.
    const freshness = await evaluateFreshnessBestEffort(
      informationalRequiredBucketTs,
      () => getEqBucketStatus(r.symbol, date, informationalRequiredBucketTs),
      (error) =>
        console.warn(
          `${TAG} candle freshness metadata failed for ${r.symbol}: ${error instanceof Error ? error.message : String(error)}`
        )
    );

    picks.push({
      rank: picks.length + 1,
      symbol: r.symbol,
      sector: s.sector,
      direction: s.direction,
      score: Math.round(s.score * 1000) / 1000,
      option,
      plan,
      rFactor: r.rFactor ?? 0,
      rFactorConfidence: r.rFactorConfidence ?? 0,
      oiLevel: r.oiLevel ?? 0,
      oiUrgency: r.oiUrgency,
      changePctOpen: r.changePctOpen,
      spreadPct: r.spreadPct,
      imbalance: r.imbalance,
      orBreakout: s.orBreakout,
      tfBreakout: r.breakout ?? null,
      setupLevel: s.setupLevel,
      extended: s.extended,
      factors,
      reasons,
      candleContext: {
        requiredBucketTs: freshness.requiredBucketTs,
        latestBucketTs: freshness.latestBucketTs,
        fresh: freshness.fresh,
        priorityTier: null,
        priorityReasons: [],
        feedRanks: {},
        sectorPromoted: false,
        sectorDirection: null,
      },
    });
  }

  if (skippedUnaffordable > 0) gated.unaffordableLot = skippedUnaffordable;
  base.gated = gated;
  base.suggestions = picks;
  // Expose the per-sector aggregation (already computed above) so the poller's
  // priority-refresh shadow can store a sector snapshot without any new call.
  base.sectorAggregates = [...sectorAgg.values()];
  // 7. Persist (first sighting keeps its original spot/time; repeats bump timesSeen)
  try {
    await upsertSuggestions(date, picks);
    base.earlierToday = await getSuggestions(date);
  } catch (err) {
    console.warn(`${TAG} persist failed: ${(err as Error).message}`);
  }

  console.log(
    `${TAG} scanned ${base.scanned}, survivors ${survivors.length}, picks ${picks.length}: ${picks.map((p) => `${p.symbol} ${p.option?.strike ?? '?'}${p.option?.optionType ?? ''}`).join(', ') || '—'}`
  );
  return base;
}
