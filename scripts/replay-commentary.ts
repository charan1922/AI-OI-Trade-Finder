/**
 * Commentary REPLAY BENCH — battle-tests the /trade-commentary pipeline on a
 * REAL recorded session, end to end, exactly as the deployed loop runs it:
 *
 *   recorded scans (oi_intraday + fyers_candles + bhavcopy, point-in-time)
 *     → SuggestResponse per tick (the engine's own gate/score/plan math)
 *       → generateCommentary() — the REAL production function + prompt, real
 *         MiMo calls, prior reads carried exactly like lib/ai-commentary/run.ts
 *         → contract checks (lib/ai-commentary/contract-checks.ts)
 *         → grounding check (every price-scale number vs THIS tick's scan JSON)
 *         → OUTCOME: follow the verdicts literally against the actual bars
 *           (enter on TRADE NOW, move stops on MOVE SL, exit on EXIT NOW /
 *            SL / target / 15:25 square-off) → points + R per trade.
 *
 * Nothing is stored in trade_commentary — runs land in
 * data/replay-commentary/run-<date>-<label>.json for the temp /replay-commentary
 * page, and a summary line is appended to tracking/commentary-replay-log.md
 * (the experiment log). The scan reconstruction mirrors scripts/replay-lib.ts's
 * replayVariant loop with the PRODUCTION config (breakout bypass ON to match
 * the deployed server's toggles; extended ban ON; TF gate OFF).
 *
 * Run from the project root:
 *   npx tsx scripts/replay-commentary.ts --date=2026-07-10 --label=iter1 \
 *       [--cadence=15] [--start=10:20] [--end=15:15] [--limit=N] [--dry]
 *   --dry builds and checks the scans without calling MiMo (free smoke test).
 */
import { mkdirSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import type { SuggestResponse, TradeSuggestion } from '../lib/trade-suggest/types';
import type { LiveUrgencyRow } from '../app/live/_lib/types';

process.loadEnvFile('.env.local');

// Everything that transitively touches lib/env.ts loads AFTER the env file.
const { loadDay } = await import('./replay-lib');
const { setupScore } = await import('../app/live/_lib/setup-score');
const { buildLiveRFactorInput } = await import('../app/api/live/_lib/rfactor-inputs');
const { computeRFactor } = await import('../lib/r-factor');
const { aggregateSectors } = await import('../lib/sector/aggregate');
const { combinedOiSlope } = await import('../lib/signals/combined-oi-slope');
const { atr, sessionVwap, supertrend } = await import('../lib/signals/indicators');
const { computeOiUrgency } = await import('../lib/signals/oi-intraday');
const { deriveSessionContext } = await import('../lib/signals/session-context');
const { deriveBreakoutContext, evaluateBreakout } = await import('../lib/breakout');
const { qualifiesByBreakout } = await import('../lib/trade-suggest/breakout-bypass');
const { qualifiesExtendedTrend } = await import('../lib/trade-suggest/extended-bypass');
const { buildSpotPlan, computeCompositeScore } = await import('../lib/trade-suggest/scoring');
const cfg = await import('../lib/trade-suggest/config');
const { checkContract } = await import('../lib/ai-commentary/contract-checks');

// ─── Args ────────────────────────────────────────────────────────────────────
const arg = (k: string, d: string): string => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const DATE = arg('date', '2026-07-10');
const LABEL = arg('label', 'run');
const CADENCE_MIN = Number(arg('cadence', '15'));
const START = arg('start', '10:20');
const END = arg('end', '15:15');
const LIMIT = Number(arg('limit', '0'));
const DRY = process.argv.includes('--dry');

const day0 = loadDay(DATE);
if (!day0) {
  console.error(`No recorded session for ${DATE} (oi_intraday/fyers_candles empty).`);
  process.exit(2);
}
// Rebind after the guard so closures below see a non-null type.
const day = day0;

const istEpoch = (hhmm: string): number => Math.floor(Date.parse(`${DATE}T${hhmm}:00+05:30`) / 1000);
const fmtIST = (ts: number): string => new Date((ts + 19800) * 1000).toISOString().slice(11, 16);
const bucketOf = (ts: number): number => ts - (ts % 300);

const ticks: number[] = [];
for (let t = istEpoch(START); t <= istEpoch(END); t += CADENCE_MIN * 60) ticks.push(t);
if (!ticks.includes(istEpoch(END))) ticks.push(istEpoch(END));

// ─── Point-in-time scan (mirrors replay-lib replayVariant, prod config) ──────
function scanAtTick(tick: number): SuggestResponse {
  const tickBucket = bucketOf(tick);
  interface Surv {
    row: LiveUrgencyRow;
    sector: string;
    direction: 'bullish' | 'bearish';
    orBreakout: boolean;
    bars: {
      bucketTs: number;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }[];
    or: { openRangeHigh: number | null; openRangeLow: number | null };
    setupLevel: string;
    extended: boolean;
    nseOiPct: number | null;
    nseRows: { bucketTs: number; nseOiPct: number | null }[];
    score: number;
  }
  const survivors: Surv[] = [];
  const gated: Record<string, number> = {};
  const bump = (k: string) => {
    gated[k] = (gated[k] ?? 0) + 1;
  };
  let up = 0;
  let down = 0;
  let flat = 0;
  let scanned = 0;

  const sectorTiles: { sector: string; pct: number; turnover: number }[] = [];
  for (const s of day.symbols) {
    const series = (day.oiSeries.get(s) ?? []).filter((p) => p.bucketTs <= tick);
    const snap = series[series.length - 1];
    const sector = day.sectorBySymbol.get(s);
    if (snap && snap.ltp > 0 && sector)
      sectorTiles.push({
        sector,
        pct: snap.changePctOpen ?? 0,
        turnover: snap.futTurnover > 0 ? snap.futTurnover : 0,
      });
  }
  const sectorAgg = new Map(aggregateSectors(sectorTiles).map((a) => [a.sector, a]));

  for (const s of day.symbols) {
    const series = (day.oiSeries.get(s) ?? []).filter((p) => p.bucketTs <= tick);
    const snap = series[series.length - 1];
    if (!snap || snap.ltp <= 0) continue;
    scanned++;
    const chg0 = snap.changePctOpen ?? 0;
    if (chg0 > 0) up++;
    else if (chg0 < 0) down++;
    else flat++;

    const bars = (day.eqBars.get(s) ?? []).filter((b) => b.bucketTs < tickBucket && b.high > 0);
    const sc = deriveSessionContext(bars);
    const urgency = computeOiUrgency(series);
    const base = day.baselines.get(s);
    const rfIn = buildLiveRFactorInput(
      {
        symbol: s,
        ltp: snap.ltp,
        changePctOpen: snap.changePctOpen,
        bid: null,
        ask: null,
        futOi: snap.futOi > 0 ? snap.futOi : null,
        turnover: snap.futTurnover > 0 ? snap.futTurnover : null,
        dayHigh: sc.dayHigh,
        dayLow: sc.dayLow,
      },
      base,
      sc,
      new Date(tick * 1000)
    );
    const r = rfIn ? computeRFactor(rfIn) : null;
    const row: LiveUrgencyRow = {
      symbol: s,
      ltp: snap.ltp,
      changePctOpen: snap.changePctOpen,
      bid: null,
      ask: null,
      spreadPct: snap.spreadPct,
      imbalance: snap.imbalance,
      futOi: snap.futOi > 0 ? snap.futOi : null,
      oiLevel: snap.oiLevel > 0 ? snap.oiLevel : null,
      turnover: snap.futTurnover > 0 ? snap.futTurnover : null,
      hasDepth: snap.spreadPct != null,
      sessionOiChangePct: urgency.ok ? urgency.sessionOiChangePct : null,
      oiVelocity: urgency.ok ? urgency.oiVelocity : null,
      oiAccel: urgency.ok ? urgency.oiAccel : null,
      oiUrgency: urgency.ok ? urgency.urgencyScore : null,
      rFactor: r?.rFactor ?? null,
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
    };

    // Engine gate sequence, production thresholds.
    const verdict = setupScore(row);
    if (verdict.level === 'illiquid' || row.spreadPct == null || row.spreadPct > cfg.MAX_SPREAD_PCT) {
      bump('illiquid');
      continue;
    }
    if (row.rFactorBias == null || row.rFactorBias === 'neutral') {
      bump('neutralBias');
      continue;
    }
    if ((row.rFactor ?? 0) < cfg.MIN_RFACTOR) {
      bump('weakRFactor');
      continue;
    }
    if ((row.rFactorConfidence ?? 0) < cfg.MIN_CONFIDENCE) {
      bump('lowConfidence');
      continue;
    }
    const direction: 'bullish' | 'bearish' = row.rFactorBias === 'buy' ? 'bullish' : 'bearish';
    const orBreakout =
      sc.openRangeComplete &&
      (direction === 'bullish'
        ? sc.openRangeHigh != null && snap.ltp > sc.openRangeHigh
        : sc.openRangeLow != null && snap.ltp < sc.openRangeLow);
    const futOiOk = (row.oiLevel ?? 0) >= cfg.MIN_OI_LEVEL;
    const nseRows = (day.nseOiByBucket.get(s) ?? []).filter((b) => b.bucketTs <= tick && b.nseOiPct != null);
    const nseOiPct = nseRows.length > 0 ? nseRows[nseRows.length - 1].nseOiPct : null;
    const nseOiOk = nseOiPct != null && nseOiPct >= cfg.MIN_NSE_OI_PCT;
    let breakoutOk = false;
    if (!futOiOk && !nseOiOk && orBreakout) {
      // Deployed server runs USE_BREAKOUT_BYPASS = ON — replay matches it.
      const vw = sessionVwap(bars);
      const st = supertrend(bars);
      breakoutOk = qualifiesByBreakout(
        {
          orBreakout,
          supertrendAligned:
            st == null ? null : direction === 'bullish' ? st.direction === 'up' : st.direction === 'down',
          vwapAligned: vw == null ? null : direction === 'bullish' ? snap.ltp > vw : snap.ltp < vw,
          rFactor: row.rFactor,
        },
        {
          minRFactor: cfg.BREAKOUT_BYPASS_MIN_RFACTOR,
          requireTrendAlign: cfg.BREAKOUT_BYPASS_REQUIRE_TREND,
        }
      );
    }
    if (!futOiOk && !nseOiOk && !breakoutOk) {
      bump('lowOiLevel');
      continue;
    }
    const turnoverFactor = row.rFactors?.find((f) => f.label.startsWith('Turnover'));
    if (!turnoverFactor?.available || turnoverFactor.score < cfg.MIN_TURNOVER_SCORE) {
      bump('lowTurnover');
      continue;
    }
    const chg = snap.changePctOpen ?? 0;
    if (!(direction === 'bullish' ? chg > 0 || orBreakout : chg < 0 || orBreakout)) {
      bump('directionDisagree');
      continue;
    }
    if (verdict.level === 'quiet') {
      bump('quietSetup');
      continue;
    }
    survivors.push({
      row,
      sector: day.sectorBySymbol.get(s) ?? '',
      direction,
      orBreakout,
      bars,
      or: { openRangeHigh: sc.openRangeHigh, openRangeLow: sc.openRangeLow },
      setupLevel: verdict.level,
      extended: verdict.extended,
      nseOiPct,
      nseRows,
      score: 0,
    });
  }

  const breadth = new Map<string, number>();
  for (const sv of survivors) {
    if (sv.sector) breadth.set(`${sv.sector}:${sv.direction}`, (breadth.get(`${sv.sector}:${sv.direction}`) ?? 0) + 1);
  }
  for (const sv of survivors) {
    sv.score = computeCompositeScore({
      rFactor: sv.row.rFactor,
      confidence: sv.row.rFactorConfidence,
      oiUrgency: sv.row.oiUrgency,
      oiLevel: sv.row.oiLevel,
      orBreakout: sv.orBreakout,
      imbalance: sv.row.imbalance,
      direction: sv.direction,
      sectorPeers: breadth.get(`${sv.sector}:${sv.direction}`) ?? 1,
      setupLevel: sv.setupLevel,
      extended: sv.extended,
    });
  }
  survivors.sort((a, b) => b.score - a.score);
  // EXCLUDE_EXTENDED is ON on the deployed server — but so is
  // USE_EXTENDED_TREND_BYPASS: a genuine trend-day continuation (still breaking
  // out, VWAP + Supertrend aligned, R-Factor ≥ floor) is re-admitted with its
  // score penalty intact. Exactly the engine's shortlist rule.
  const eligible = survivors.filter((sv) => {
    if (!sv.extended) return true;
    const ltp = sv.row.ltp ?? 0;
    const vw = sessionVwap(sv.bars);
    const st = supertrend(sv.bars);
    const ok = qualifiesExtendedTrend(
      {
        orBreakout: sv.orBreakout,
        supertrendAligned:
          st == null ? null : sv.direction === 'bullish' ? st.direction === 'up' : st.direction === 'down',
        vwapAligned: vw == null ? null : sv.direction === 'bullish' ? ltp > vw : ltp < vw,
        rFactor: sv.row.rFactor,
      },
      {
        minRFactor: cfg.EXTENDED_BYPASS_MIN_RFACTOR,
        requireSupertrend: cfg.EXTENDED_BYPASS_REQUIRE_SUPERTREND,
      }
    );
    if (!ok) bump('extendedMover');
    return ok;
  });

  const suggestions: TradeSuggestion[] = eligible.slice(0, cfg.MAX_PICKS).map((sv, i) => {
    const side = sv.direction === 'bullish' ? 'CE' : 'PE';
    const plan = buildSpotPlan(side, sv.row.ltp ?? 0, sv.bars, sv.or, tickBucket);
    const vw = sessionVwap(sv.bars);
    const st = supertrend(sv.bars);
    const a = atr(sv.bars);
    const base = day.baselines.get(sv.row.symbol);
    const combinedOiLevel =
      base?.combinedOiPrev != null && base.combinedOi20dAvg != null && sv.nseOiPct != null && base.combinedOi20dAvg > 0
        ? (base.combinedOiPrev * (1 + sv.nseOiPct / 100)) / base.combinedOi20dAvg
        : null;
    const sa = sv.sector ? (sectorAgg.get(sv.sector) ?? null) : null;
    const sectorAligned =
      sa == null || Math.abs(sa.weightedPct) < 0.1
        ? null
        : sv.direction === 'bullish'
          ? sa.weightedPct > 0
          : sa.weightedPct < 0;
    const bctx = deriveBreakoutContext(sv.bars, {
      openRangeHigh: sv.or.openRangeHigh,
      openRangeLow: sv.or.openRangeLow,
      openRangeComplete: sv.bars.length > 0 && deriveSessionContext(sv.bars).openRangeComplete,
      priorDayHigh: base?.priorDayHigh ?? null,
      priorDayLow: base?.priorDayLow ?? null,
      high5d: base?.high5d ?? null,
      low5d: base?.low5d ?? null,
      high20d: base?.high20d ?? null,
      low20d: base?.low20d ?? null,
    });
    const tfBreakout = evaluateBreakout(bctx, sv.row.ltp, sv.row.rFactor, sv.row.changePctOpen);
    return {
      rank: i + 1,
      symbol: sv.row.symbol,
      sector: sv.sector,
      direction: sv.direction,
      score: Math.round(sv.score * 1000) / 1000,
      option: null, // option premiums aren't recorded historically — spot plan only, never fabricated
      plan,
      rFactor: sv.row.rFactor ?? 0,
      rFactorConfidence: sv.row.rFactorConfidence ?? 0,
      oiLevel: sv.row.oiLevel ?? 0,
      oiUrgency: sv.row.oiUrgency,
      changePctOpen: sv.row.changePctOpen,
      spreadPct: sv.row.spreadPct,
      imbalance: sv.row.imbalance,
      orBreakout: sv.orBreakout,
      tfBreakout,
      setupLevel: sv.setupLevel,
      extended: sv.extended,
      factors: {
        vwap: vw,
        vwapAligned: vw == null ? null : sv.direction === 'bullish' ? (sv.row.ltp ?? 0) > vw : (sv.row.ltp ?? 0) < vw,
        supertrend: st?.direction ?? null,
        supertrendLine: st?.line ?? null,
        supertrendAligned:
          st == null ? null : sv.direction === 'bullish' ? st.direction === 'up' : st.direction === 'down',
        atr: a,
        atrPct: a != null && (sv.row.ltp ?? 0) > 0 ? (a / (sv.row.ltp ?? 1)) * 100 : null,
        eqTurnoverRatio: null, // per-tick equity turnover wasn't recorded — honest null
        combinedOiLevel,
        nseOiPct: sv.nseOiPct,
        combinedOiSlope30m: combinedOiSlope(sv.nseRows, tick),
        onOiSpurtList: false, // spurt-list membership isn't recorded historically
        sectorPct: sa?.weightedPct ?? null,
        sectorAdvanceRatio: sa ? sa.advancers / Math.max(1, sa.advancers + sa.decliners) : null,
        sectorAligned,
      },
      reasons: [
        `R-Factor ${sv.row.rFactor?.toFixed(2)} (${sv.direction}, confidence ${(((sv.row.rFactorConfidence ?? 0) as number) * 100).toFixed(0)}%)`,
        `futures OI ${sv.row.oiLevel?.toFixed(2)}× 20-day avg${sv.row.oiUrgency != null ? `, urgency ${sv.row.oiUrgency.toFixed(1)}/10` : ''}`,
        sv.orBreakout
          ? 'trading beyond the opening range (breakout confirmed)'
          : 'inside opening range — breakout not yet confirmed',
        ...(tfBreakout != null && tfBreakout.grade !== 'none'
          ? [`TF breakout check (${tfBreakout.grade}): ${tfBreakout.detail}`]
          : []),
      ],
    };
  });

  const lean = up > down * 1.5 ? 'CE' : down > up * 1.5 ? 'PE' : 'neutral';
  const nowIST = new Date((tick + 19800) * 1000).toISOString().slice(11, 19);
  const activeWindow = tick >= istEpoch('09:40') && tick <= istEpoch('11:00');
  return {
    success: true,
    window: {
      active: activeWindow,
      opensAt: cfg.WINDOW_LABEL.opensAt,
      closesAt: cfg.WINDOW_LABEL.closesAt,
      nowIST,
    },
    marketOpen: true,
    date: DATE,
    scanned,
    gated,
    suggestions,
    tilt: { up, down, flat, basis: 'since-open', lean },
    earlierToday: [],
  };
}

// ─── Grounding: price-scale numbers in the text vs THIS tick's scan JSON ─────
function groundingSuspects(text: string, scan: SuggestResponse, priorTexts: string[]): number[] {
  const allowed: number[] = [];
  for (const m of JSON.stringify(scan).matchAll(/-?\d+(?:\.\d+)?/g)) allowed.push(Math.abs(Number(m[0])));
  for (const t of priorTexts)
    for (const m of t.matchAll(/\d[\d,]*(?:\.\d+)?/g)) allowed.push(Number(m[0].replace(/,/g, '')));
  const cleaned = text.replace(/\d{4}-\d{2}-\d{2}/g, ' ').replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ');
  const out = new Set<number>();
  for (const m of cleaned.matchAll(/(₹\s*)?\d[\d,]*(?:\.\d+)?/g)) {
    const n = Number(m[0].replace(/[₹,\s]/g, ''));
    if (!Number.isFinite(n) || (!m[1] && n < 100)) continue;
    if (!allowed.some((a) => Math.abs(n - a) <= Math.max(0.0101, a * 0.0006))) out.add(n);
  }
  return [...out];
}

// ─── The thread ──────────────────────────────────────────────────────────────
interface ReadRecord {
  tick: number;
  timeIST: string;
  windowActive: boolean;
  scanned: number;
  picks: {
    symbol: string;
    direction: string;
    entrySpot: number;
    slSpot: number | null;
    targetSpot: number | null;
    score: number;
    tfGrade: string | null;
  }[];
  text: string;
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  fails: string[];
  warns: string[];
  suspects: number[];
  verdicts: { ticker: string; verdict: string; slLevel: number | null }[];
}

const allSymbols = new Set(day.symbols);
const reads: ReadRecord[] = [];
const priorTexts: string[] = [];
const contextSymbols = new Set<string>();
/** Mirrors the engine's `tracked` feed: first-suggestion plan levels per name,
 *  refreshed each tick with the live recorded price. */
const trackedBook = new Map<
  string,
  {
    side: 'CE' | 'PE';
    direction: 'bullish' | 'bearish';
    entrySpot: number;
    slSpot: number | null;
    targetSpot: number | null;
    suggestedAt: string;
  }
>();
/** Names an earlier read actually called TRADE NOW — the only legal targets
 *  for HOLD / MOVE SL / EXIT NOW (contract-checks phantom-position rule). */
const openPositions = new Set<string>();
let mimo:
  | ((
      r: SuggestResponse,
      p: string[]
    ) => Promise<{
      text: string;
      promptTokens: number | null;
      completionTokens: number | null;
    }>)
  | null = null;
if (!DRY) {
  const { generateCommentary } = await import('../lib/ai-commentary/generate');
  mimo = (r, p) => generateCommentary(r, p);
}

console.log(
  `Replay ${DATE} · ${ticks.length} ticks (${START}→${END}, every ${CADENCE_MIN}m) · ${DRY ? 'DRY (no MiMo)' : 'REAL MiMo'} · label=${LABEL}`
);
for (const tick of ticks) {
  if (LIMIT > 0 && reads.length >= LIMIT) break;
  const scan = scanAtTick(tick);
  if (scan.scanned === 0) {
    console.log(`  ${fmtIST(tick)} — no recorded data yet, skipped`);
    continue;
  }
  for (const s of scan.suggestions) contextSymbols.add(s.symbol);
  // tracked feed, exactly like the engine: earlier calls first (BEFORE adding
  // this tick's new suggestions), live price from the recorded series.
  scan.tracked = [...trackedBook.entries()].map(([symbol, t]) => {
    const series = (day.oiSeries.get(symbol) ?? []).filter((p) => p.bucketTs <= tick);
    return { symbol, ...t, ltp: series[series.length - 1]?.ltp ?? null };
  });
  for (const s of scan.suggestions) {
    if (!trackedBook.has(s.symbol)) {
      trackedBook.set(s.symbol, {
        side: s.direction === 'bullish' ? 'CE' : 'PE',
        direction: s.direction,
        entrySpot: s.plan.entrySpot,
        slSpot: s.plan.slSpot,
        targetSpot: s.plan.targetSpot,
        suggestedAt: fmtIST(tick),
      });
    }
  }
  let text = '';
  let latencyMs = 0;
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  if (mimo) {
    const t0 = Date.now();
    try {
      const out = await mimo(scan, priorTexts.slice(-6));
      text = out.text;
      promptTokens = out.promptTokens;
      completionTokens = out.completionTokens;
    } catch (e) {
      console.log(`  ${fmtIST(tick)} — MiMo error: ${(e as Error).message}`);
      continue;
    }
    latencyMs = Date.now() - t0;
  }
  const pickSyms = new Set(scan.suggestions.map((s) => s.symbol));
  const contract = text
    ? checkContract(text, pickSyms, contextSymbols, allSymbols, openPositions)
    : { fails: [], warns: [], sections: [] };
  const suspects = text ? groundingSuspects(text, scan, priorTexts) : [];
  reads.push({
    tick,
    timeIST: fmtIST(tick),
    windowActive: scan.window.active,
    scanned: scan.scanned,
    picks: scan.suggestions.map((s) => ({
      symbol: s.symbol,
      direction: s.direction,
      entrySpot: s.plan.entrySpot,
      slSpot: s.plan.slSpot,
      targetSpot: s.plan.targetSpot,
      score: s.score,
      tfGrade: s.tfBreakout?.grade ?? null,
    })),
    text,
    latencyMs,
    promptTokens,
    completionTokens,
    fails: contract.fails,
    warns: contract.warns,
    suspects,
    verdicts: contract.sections
      .filter((s) => s.ticker != null)
      .map((s) => ({
        ticker: s.ticker as string,
        verdict: s.verdict,
        slLevel: s.slLevel,
      })),
  });
  if (text) priorTexts.push(text);
  for (const v of reads[reads.length - 1].verdicts) {
    if (v.verdict === 'TRADE NOW') openPositions.add(v.ticker);
    else if (v.verdict === 'EXIT NOW') openPositions.delete(v.ticker); // exit is final — later HOLD/EXIT on it = phantom
  }
  console.log(
    `  ${fmtIST(tick)} — scanned ${scan.scanned}, picks ${scan.suggestions.length}${text ? ` · ${contract.fails.length ? `✗ ${contract.fails.length} fail` : '✓ structure'} · ${(latencyMs / 1000).toFixed(0)}s` : ''}`
  );
}

// ─── Outcomes: follow the verdicts literally against the real bars ───────────
interface Trade {
  ticker: string;
  direction: 'bullish' | 'bearish';
  entryTime: string;
  entryPx: number;
  sl: number | null;
  target: number | null;
  exitTime: string;
  exitPx: number;
  exitReason: string;
  points: number;
  rMultiple: number | null;
}
const trades: Trade[] = [];
let skippedInvalidEntries = 0;
{
  interface Ev {
    tick: number;
    type: 'enter' | 'moveSl' | 'exit';
    dir?: 'bullish' | 'bearish';
    entryRef?: { sl: number | null; target: number | null };
    sl?: number | null;
  }
  const events = new Map<string, Ev[]>();
  for (const r of reads) {
    for (const v of r.verdicts) {
      const list = events.get(v.ticker) ?? [];
      if (v.verdict === 'TRADE NOW') {
        const pick = r.picks.find((p) => p.symbol === v.ticker);
        if (pick)
          list.push({
            tick: r.tick,
            type: 'enter',
            dir: pick.direction as 'bullish' | 'bearish',
            entryRef: { sl: pick.slSpot, target: pick.targetSpot },
          });
      } else if (v.verdict === 'MOVE SL') list.push({ tick: r.tick, type: 'moveSl', sl: v.slLevel });
      else if (v.verdict === 'EXIT NOW') list.push({ tick: r.tick, type: 'exit' });
      events.set(v.ticker, list);
    }
  }
  const squareOff = istEpoch('15:25');
  for (const [ticker, list] of events) {
    const bars = (day.eqBars.get(ticker) ?? []).filter((b) => b.close > 0);
    let open: {
      dir: 'bullish' | 'bearish';
      entryPx: number;
      entryTick: number;
      sl: number | null;
      target: number | null;
    } | null = null;
    let cursor = 0; // next bar index to check — NEVER re-walks, starts AFTER the entry bar
    const closeAt = (px: number, ts: number, reason: string) => {
      if (!open) return;
      const sign = open.dir === 'bullish' ? 1 : -1;
      const points = (px - open.entryPx) * sign;
      const risk = open.sl != null ? Math.abs(open.entryPx - open.sl) : null;
      trades.push({
        ticker,
        direction: open.dir,
        entryTime: fmtIST(open.entryTick),
        entryPx: open.entryPx,
        sl: open.sl,
        target: open.target,
        exitTime: fmtIST(ts),
        exitPx: px,
        exitReason: reason,
        points: Math.round(points * 100) / 100,
        rMultiple: risk != null && risk > 0 ? Math.round((points / risk) * 100) / 100 : null,
      });
      open = null;
    };
    /** Walk forward (from the bar AFTER entry) applying stop/target touches. */
    const advanceTo = (uptoTick: number) => {
      while (open && cursor < bars.length && bars[cursor].bucketTs <= uptoTick) {
        const b = bars[cursor];
        cursor++;
        if (open.dir === 'bullish' && open.sl != null && b.low <= open.sl) closeAt(open.sl, b.bucketTs, 'stop-hit');
        else if (open.dir === 'bearish' && open.sl != null && b.high >= open.sl)
          closeAt(open.sl, b.bucketTs, 'stop-hit');
        else if (open.dir === 'bullish' && open.target != null && b.high >= open.target)
          closeAt(open.target, b.bucketTs, 'target-hit');
        else if (open.dir === 'bearish' && open.target != null && b.low <= open.target)
          closeAt(open.target, b.bucketTs, 'target-hit');
      }
    };
    for (const ev of list.sort((a, b) => a.tick - b.tick)) {
      advanceTo(ev.tick);
      if (ev.type === 'enter' && !open) {
        const idx = bars.findIndex((b) => b.bucketTs >= bucketOf(ev.tick));
        if (idx >= 0) {
          const bar = bars[idx];
          const sl = ev.entryRef?.sl ?? null;
          const dir = ev.dir as 'bullish' | 'bearish';
          // Literal follower sanity: if the fill price is already at/beyond the
          // stated stop, the call is un-executable — skip, don't fake a fill.
          const invalid = sl != null && (dir === 'bullish' ? bar.close <= sl : bar.close >= sl);
          if (invalid) {
            skippedInvalidEntries++;
          } else {
            open = {
              dir,
              entryPx: bar.close,
              entryTick: bar.bucketTs,
              sl,
              target: ev.entryRef?.target ?? null,
            };
            cursor = idx + 1; // stop/target checks begin on the NEXT bar
          }
        }
      } else if (ev.type === 'moveSl' && open && ev.sl != null) open.sl = ev.sl;
      else if (ev.type === 'exit' && open) {
        const bar = bars.find((b) => b.bucketTs >= bucketOf(ev.tick)) ?? bars[bars.length - 1];
        closeAt(bar.close, bar.bucketTs, 'exit-call');
      }
    }
    if (open) {
      advanceTo(squareOff);
      if (open) {
        const last = bars.filter((b) => b.bucketTs <= squareOff).pop() ?? bars[bars.length - 1];
        closeAt(last.close, last.bucketTs, 'square-off');
      }
    }
  }
}

// ─── Metrics + persist ───────────────────────────────────────────────────────
const readsWithText = reads.filter((r) => r.text);
const tradeNowCount = reads.reduce((s, r) => s + r.verdicts.filter((v) => v.verdict === 'TRADE NOW').length, 0);
const orphans = trades.filter((t) => t.exitReason === 'square-off').length;
const wins = trades.filter((t) => t.points > 0).length;
const totalPoints = Math.round(trades.reduce((s, t) => s + t.points, 0) * 100) / 100;
const totalR = Math.round(trades.reduce((s, t) => s + (t.rMultiple ?? 0), 0) * 100) / 100;
const metrics = {
  reads: readsWithText.length,
  structureFails: readsWithText.reduce((s, r) => s + r.fails.length, 0),
  warns: readsWithText.reduce((s, r) => s + r.warns.length, 0),
  groundingSuspects: readsWithText.reduce((s, r) => s + r.suspects.length, 0),
  tradeNowCalls: tradeNowCount,
  distinctNamesTraded: new Set(trades.map((t) => t.ticker)).size,
  trades: trades.length,
  wins,
  totalPoints,
  totalR,
  skippedInvalidEntries,
  orphanSquareOffs: orphans,
  avgWords: readsWithText.length
    ? Math.round(readsWithText.reduce((s, r) => s + r.text.split(/\s+/).length, 0) / readsWithText.length)
    : 0,
  avgLatencySec: readsWithText.length
    ? Math.round(readsWithText.reduce((s, r) => s + r.latencyMs, 0) / readsWithText.length / 1000)
    : 0,
};

const outDir = 'data/replay-commentary';
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const runName = `run-${DATE}-${LABEL}`;
const payload = {
  runName,
  date: DATE,
  label: LABEL,
  createdAt: new Date().toISOString(),
  dry: DRY,
  config: {
    cadenceMin: CADENCE_MIN,
    start: START,
    end: END,
    breakoutBypass: true,
    excludeExtended: true,
    maxPicks: cfg.MAX_PICKS,
  },
  metrics,
  trades,
  reads,
};
writeFileSync(`${outDir}/${runName}.json`, JSON.stringify(payload, null, 1));

console.log(`\n═══ ${runName} ═══`);
console.log(JSON.stringify(metrics, null, 1));
for (const t of trades)
  console.log(
    `  ${t.ticker} ${t.direction} ${t.entryTime}@${t.entryPx} → ${t.exitTime}@${t.exitPx} (${t.exitReason}) ${t.points >= 0 ? '+' : ''}${t.points} pts${t.rMultiple != null ? ` (${t.rMultiple}R)` : ''}`
  );
console.log(`Saved ${outDir}/${runName}.json — view at /replay-commentary`);

if (!DRY) {
  const logLine = `| ${new Date().toISOString().slice(0, 16)} | ${runName} | ${metrics.reads} | ${metrics.structureFails} | ${metrics.groundingSuspects} | ${metrics.tradeNowCalls} | ${metrics.trades} (${metrics.wins}W) | ${metrics.totalPoints} pts / ${metrics.totalR}R | ${metrics.orphanSquareOffs} | ${metrics.avgWords} |\n`;
  const logFile = 'tracking/commentary-replay-log.md';
  if (!existsSync(logFile)) {
    appendFileSync(
      logFile,
      `# Commentary replay experiment log\n\nOne row per replay run (scripts/replay-commentary.ts) — the autoresearch-style ledger.\nRun with a --label per experiment; view any run at /replay-commentary.\n\n| when (UTC) | run | reads | struct fails | ungrounded | TRADE NOWs | trades (wins) | outcome | orphans | avg words |\n|---|---|---|---|---|---|---|---|---|---|\n`
    );
  }
  appendFileSync(logFile, logLine);
}
