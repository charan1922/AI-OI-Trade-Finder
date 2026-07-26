/**
 * Point-in-time replay of the /trade-suggest window over a RECORDED session —
 * the fixed benchmark of the autoresearch loop (github.com/karpathy/autoresearch,
 * transplanted: our "train.py" is the engine config, our "val_bpb" is the ΣR
 * this replay produces).
 *
 * At each 5-min tick from 09:40 to 11:00 IST it reconstructs what the live
 * engine would have seen using ONLY rows with bucketTs ≤ tick (zero
 * lookahead), runs the REAL production code (computeRFactor via the live
 * input builder, setupScore, computeOiUrgency, computeCompositeScore,
 * buildSpotPlan — all imported, not re-implemented), takes the top picks, and
 * then scores each first sighting bar-by-bar to the close (SL/target
 * first-touch; both in one bar counts as SL — conservative).
 *
 * Universe = the point-in-time NSE candidate slices when rank snapshots exist
 * (otherwise the recorded oi_intraday universe), baselines = bhavcopy STRICTLY
 * BEFORE the date. Known fidelity gap vs live, stated not hidden: option
 * premiums were not recorded, so the affordability gate is skipped. The exact
 * recorded spread percentage reconstructs the R-Factor liquidity input.
 *
 * CLIs on top of this library:
 *   npx tsx scripts/replay-window.ts [date]      — named-variant grid
 *   npx tsx scripts/autoresearch.ts [n] [seed]   — autonomous experiment loop
 */
// Node's built-in env loader — no `dotenv` dependency (it is not in package.json
// and was never installed). try/catch preserves dotenv's silent no-op when the
// file is absent; process.loadEnvFile throws.
try {
  process.loadEnvFile('.env.local');
} catch {
  // no .env.local — fall through to whatever is already in the environment
}

import Database from 'better-sqlite3';
import { setupScore } from '../app/live/_lib/setup-score';
import type { LiveUrgencyRow } from '../app/live/_lib/types';
import { buildLiveRFactorInput } from '../app/api/live/_lib/rfactor-inputs';
import type { RFactorBaseline } from '../app/api/live/_lib/rfactor-baselines';
import { computeRFactor, DEFAULT_WEIGHTS as RF_DEFAULT_WEIGHTS, type RFactorWeights } from '../lib/r-factor';
import { aggregateSectors, type SectorAggregate } from '../lib/sector/aggregate';
import { combinedOiSlope } from '../lib/signals/combined-oi-slope';
import { rankClimb, type RankPoint } from '../lib/signals/rank-climb';
import { atr, sessionVwap, supertrend } from '../lib/signals/indicators';
import { computeOiUrgency, type OiPoint } from '../lib/signals/oi-intraday';
import { deriveSessionContext } from '../lib/signals/session-context';
import {
  BREAKOUT_BYPASS_MIN_RFACTOR,
  BREAKOUT_BYPASS_REQUIRE_TREND,
  EXCLUDE_EXTENDED,
  EXTENDED_BYPASS_MIN_RFACTOR,
  EXTENDED_BYPASS_REQUIRE_SUPERTREND,
  EXTENDED_SCORE_MULT,
  MAX_PICKS,
  SUGGESTION_MAX_SPREAD_PCT,
  MIN_CONFIDENCE,
  MIN_NSE_OI_PCT,
  MIN_OI_LEVEL,
  MIN_OPT_PREMIUM_CR,
  MIN_OPT_SHARE,
  MIN_RFACTOR,
  MIN_TURNOVER_SCORE,
  MOMENTUM_MIN_CHANGE_PCT,
  RANK_CLIMB_MIN_NSE_OI_PCT,
  RANK_CLIMB_MIN_SPOTS,
  SL_ATR_MULT,
  TARGET_RR,
  USE_BREAKOUT_BYPASS,
  USE_EXTENDED_TREND_BYPASS,
  USE_MOMENTUM_BREAKOUT,
  USE_RANK_CLIMB_GATE,
  WEIGHTS,
} from '../lib/trade-suggest/config';
import { qualifiesByBreakout } from '../lib/trade-suggest/breakout-bypass';
import { qualifiesExtendedTrend } from '../lib/trade-suggest/extended-bypass';
import { qualifiesMomentumBreakout } from '../lib/trade-suggest/momentum-breakout';
import { buildSpotPlan, computeCompositeScore, type ScoreWeights } from '../lib/trade-suggest/scoring';

const db = new Database('./data/project-r.db', { readonly: true });
const REPLAY_DAILY_TRADE_CAP = 2;

/** Harness modes (NOT strategy knobs — those live on Variant).
 *  allFires: drop the daily trade cap so EVERY first-seen qualified fire is
 *  scored, not just the first REPLAY_DAILY_TRADE_CAP. The cap fills early on
 *  busy mornings (2026-07-17: both slots gone by 09:40), which blinds the grid
 *  to exactly the admissions under study — late-morning catch-path fires like
 *  AXISBANK 10:25 never got scored by ANY variant. Capped mode stays the
 *  production-fidelity read; all-fires is the evidence read for comparing
 *  variant admission quality. Per-scan MAX_PICKS still applies — a name outside
 *  a scan's top picks would never be surfaced live either. */
export interface ReplayOptions {
  allFires?: boolean;
}

// ─── Experiment configuration (what the loop is allowed to mutate) ──────────
export interface Variant {
  name: string;
  atrMult: number; // risk floor = max(0.35%, atrMult × ATR14)
  extendedMult: number; // score multiplier for ≥3%-moved names (flag-off path)
  banExtended: boolean; // hard-skip extended movers at pick time (EXCLUDE_EXTENDED)
  /** Trend-aligned bypass of the extended ban (see extended-bypass.ts). Optional;
   *  undefined = off, so existing variant literals need no change. */
  extendedTrendBypass?: boolean;
  extendedBypassMinRFactor?: number;
  extendedBypassRequireSupertrend?: boolean;
  weights: ScoreWeights;
  /** The R-Factor engine's INTERNAL 12-factor blend — searchable per variant
   *  (the engine renormalizes over available factors, so no sum constraint). */
  rfWeights: RFactorWeights;
  // Gate overrides — default to the production config values.
  minRFactor: number;
  minConfidence: number;
  minOiLevel: number;
  minNseOiPct: number;
  /** Price/base-breakout bypass of the OI gate (see breakout-bypass.ts). */
  breakoutBypass: boolean;
  /** R-Factor floor for the bypass (higher than minRFactor since OI is absent). */
  breakoutMinRFactor: number;
  /** Require trend agreement (Supertrend/VWAP) for the bypass. */
  breakoutRequireTrend: boolean;
  /** Momentum-breakout path (momentum-breakout.ts): confirmed OR breakout +
   *  BOTH Supertrend and VWAP agreeing + move ≥ momentumMinChangePct clears the
   *  R-Factor, confidence, OI and quiet-setup gates — the short-covering class
   *  every accumulation factor rejects by design (ADANIGREEN 2026-07-14). */
  momentumBreakout: boolean;
  momentumMinChangePct: number;
  /** When non-null, the options-led OI path (nseOiPct ≥ minNseOiPct) ALSO
   *  requires the combined-OI slope over the trailing ~30 min to be ≥ this
   *  (pct-points; lib/signals/combined-oi-slope.ts) — "the build must be
   *  live, not a stale morning print". Null = off (prod has no slope gate). */
  minNseOiSlope: number | null;
  /** Rank-climb CATCH path (USE_RANK_CLIMB_GATE, live since 2026-07-17) —
   *  mirrors engine.ts exactly: the ≥minNseOiPct rule is untouched, and
   *  ADDITIONALLY a smaller build (≥ rankClimbMinNsePct, < minNseOiPct) with
   *  qualifying options legs passes IF the name is CLIMBING the gainers/OI
   *  leaderboard ≥ rankClimbMinSpots over ~30 min (lib/signals/rank-climb.ts).
   *  Evidence 2026-07-16: winners climbing 5/8 vs losers 1/7; ADANIENSOL
   *  climbed gainers #15→#7, OI #50→#26. No board history = no climb evidence
   *  = NOT admitted via this path (admission needs positive evidence). */
  rankClimbCatch: boolean;
  rankClimbMinSpots: number;
  rankClimbMinNsePct: number;
  /** When true, only a climb on the 'gainers' (price) board qualifies — the OI
   *  board alone doesn't. The 16-Jul winner led with price (ADANIENSOL gainers
   *  #15→#7) while the 17-Jul live loser (AXISBANK, −₹1,344, admitted at NSE
   *  +2.1%) climbed only the OI board 41→35 and was SLIPPING on gainers 18→19.
   *  False in prod (engine.ts takes best of both boards). */
  rankClimbGainersOnly: boolean;
  /** When non-null, the climb must also ARRIVE: the latest rank on the
   *  qualifying board must be ≤ this ("climbing and arriving", not mid-pack
   *  drift — ADANIENSOL's gainers climb ended at #7; AXISBANK's OI climb ended
   *  at #35). Null in prod (engine.ts has no rank ceiling). */
  rankClimbMaxRank: number | null;
  /** When true, drop candidates fighting their sector's turnover-weighted move
   *  (lib/sector/aggregate.ts; flat sectors <0.1% pass). False in prod —
   *  sector alignment is display evidence until this variant earns its place. */
  requireSectorAlign: boolean;
  /** Research-only entry confirmations. Production remains represented by the
   * shipped defaults (false/undefined/true respectively). */
  requireConfirmedOrb?: boolean;
  minBreakoutVolumeRatio?: number;
  requireSupertrendAlign?: boolean;
}

/** Mirrors the production config — the loop's baseline. */
export const SHIPPED_VARIANT: Variant = {
  name: 'shipped',
  atrMult: SL_ATR_MULT,
  extendedMult: EXTENDED_SCORE_MULT,
  banExtended: EXCLUDE_EXTENDED,
  extendedTrendBypass: USE_EXTENDED_TREND_BYPASS,
  extendedBypassMinRFactor: EXTENDED_BYPASS_MIN_RFACTOR,
  extendedBypassRequireSupertrend: EXTENDED_BYPASS_REQUIRE_SUPERTREND,
  weights: WEIGHTS,
  rfWeights: RF_DEFAULT_WEIGHTS,
  minRFactor: MIN_RFACTOR,
  minConfidence: MIN_CONFIDENCE,
  minOiLevel: MIN_OI_LEVEL,
  minNseOiPct: MIN_NSE_OI_PCT,
  breakoutBypass: USE_BREAKOUT_BYPASS,
  breakoutMinRFactor: BREAKOUT_BYPASS_MIN_RFACTOR,
  breakoutRequireTrend: BREAKOUT_BYPASS_REQUIRE_TREND,
  momentumBreakout: USE_MOMENTUM_BREAKOUT,
  momentumMinChangePct: MOMENTUM_MIN_CHANGE_PCT,
  minNseOiSlope: null,
  rankClimbCatch: USE_RANK_CLIMB_GATE,
  rankClimbMinSpots: RANK_CLIMB_MIN_SPOTS,
  rankClimbMinNsePct: RANK_CLIMB_MIN_NSE_OI_PCT,
  rankClimbGainersOnly: false,
  rankClimbMaxRank: null,
  requireSectorAlign: false,
};

// ─── Day data ────────────────────────────────────────────────────────────────
export interface Bar {
  bucketTs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
interface BaselinePlus extends RFactorBaseline {
  eqTurnover20dAvg: number | null;
  combinedOiPrev: number | null;
  combinedOi20dAvg: number | null;
}
export interface DayData {
  date: string;
  symbols: string[];
  ticks: number[];
  oiSeries: Map<string, OiPoint[]>;
  eqBars: Map<string, Bar[]>;
  nseOiByBucket: Map<string, { bucketTs: number; nseOiPct: number | null }[]>;
  sectorBySymbol: Map<string, string>;
  baselines: Map<string, BaselinePlus>;
  candidateSymbolsByTick: Map<number, Set<string>> | null;
  /** Per-symbol, per-feed ('gainers'/'oi') leaderboard rank series — the
   *  point-in-time input of the minRankClimb gate. Null when rank_snapshots
   *  has nothing for the day. */
  rankHistoryBySymbol: Map<string, Map<string, RankPoint[]>> | null;
  coverage: {
    rankSnapshots: boolean;
    scanModeRecorded: boolean;
    optionsLedFields: boolean;
  };
}

/** All sessions with recorded intraday OI (each is a usable benchmark day). */
export function listRecordedDates(): string[] {
  return (db.prepare(`SELECT DISTINCT date FROM oi_intraday ORDER BY date ASC`).all() as { date: string }[]).map(
    (r) => r.date
  );
}

const avg = (values: number[]): number | null => {
  const xs = values.filter((v) => v > 0).slice(0, 20);
  return xs.length >= 5 ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
};
const pos = (v: unknown): number | null => (v != null && Number(v) > 0 ? Number(v) : null);
const bucketOf = (ts: number): number => ts - (ts % 300);
/** Extreme of the newest ≤n positive values (rows are newest-first); null when none. */
const extremeOf = (values: number[], n: number, mode: 'max' | 'min'): number | null => {
  const xs = values.filter((v) => v > 0).slice(0, n);
  if (xs.length === 0) return null;
  return mode === 'max' ? Math.max(...xs) : Math.min(...xs);
};

/** Load one recorded session; null when nothing was recorded for the date. */
export function loadDay(date: string): DayData | null {
  const oiColumns = new Set(
    (db.prepare(`PRAGMA table_info(oi_intraday)`).all() as { name: string }[]).map((column) => column.name)
  );
  const hasOptionsLedColumns = oiColumns.has('optShare') && oiColumns.has('premValueCr');
  const hasOptionsLedFields =
    hasOptionsLedColumns &&
    (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM oi_intraday
           WHERE date=? AND optShare IS NOT NULL AND premValueCr IS NOT NULL`
        )
        .get(date) as { c: number }
    ).c > 0;
  const symbols = (
    db.prepare(`SELECT DISTINCT symbol FROM oi_intraday WHERE date=?`).all(date) as { symbol: string }[]
  ).map((r) => r.symbol);
  if (symbols.length === 0) return null;
  // DATA-COVERAGE GUARD: the replay needs 5-min candles (opening range, ATR,
  // SL, outcome scoring). The Fyers recorder only started 2026-07-03; earlier
  // dates have oi_intraday but ZERO fyers_candles — replaying them yields
  // zero picks as an artifact, which poisons the experiment metric (found
  // 2026-07-04: the loop "improved" by loosening gates against 8 empty days).
  // A day without candle coverage is not a benchmark day.
  const eqBarCount = (
    db.prepare(`SELECT COUNT(*) AS c FROM fyers_candles WHERE date=? AND instrument='EQ'`).get(date) as { c: number }
  ).c;
  if (eqBarCount === 0) return null;
  const sectorBySymbol = new Map(
    (
      db.prepare(`SELECT symbol, sector FROM fno_stocks`).all() as {
        symbol: string;
        sector: string;
      }[]
    ).map((r) => [r.symbol, r.sector])
  );
  const oiSeries = new Map<string, OiPoint[]>();
  const eqBars = new Map<string, Bar[]>();
  const nseOiByBucket = new Map<string, { bucketTs: number; nseOiPct: number | null }[]>();
  for (const s of symbols) {
    oiSeries.set(
      s,
      db
        .prepare(
          `SELECT bucketTs, ltp, futOi, oiLevel, futTurnover, changePctOpen, spreadPct, imbalance,
                  ${oiColumns.has('optShare') ? 'optShare' : 'NULL'} AS optShare,
                  ${oiColumns.has('premValueCr') ? 'premValueCr' : 'NULL'} AS premValueCr
           FROM oi_intraday WHERE symbol=? AND date=? ORDER BY bucketTs ASC`
        )
        .all(s, date) as OiPoint[]
    );
    eqBars.set(
      s,
      db
        .prepare(
          `SELECT bucketTs, open, high, low, close, volume FROM fyers_candles WHERE symbol=? AND date=? AND instrument='EQ' ORDER BY bucketTs ASC`
        )
        .all(s, date) as Bar[]
    );
    nseOiByBucket.set(
      s,
      db
        .prepare(
          `SELECT bucketTs, nseOiPct FROM fyers_candles WHERE symbol=? AND date=? AND instrument='FUT' ORDER BY bucketTs ASC`
        )
        .all(s, date) as { bucketTs: number; nseOiPct: number | null }[]
    );
  }

  // Baselines: bhavcopy STRICTLY BEFORE the replay date (what live saw that
  // morning). Mirrors app/api/live/_lib/rfactor-baselines.ts.
  const baselines = new Map<string, BaselinePlus>();
  for (const s of symbols) {
    const rs = db
      .prepare(
        `SELECT futOi, optOi, futTurnover, futVolume, eqTurnover, eqHigh, eqLow, eqClose
         FROM bhavcopy_days WHERE symbol=? AND date<? ORDER BY date DESC LIMIT 25`
      )
      .all(s, date) as Record<string, number | null>[];
    if (rs.length === 0) continue;
    const prev = rs[0];
    baselines.set(s, {
      futOiPrev: pos(prev.futOi),
      futOi20dAvg: avg(rs.map((r) => Number(r.futOi ?? 0))),
      futTurnover20dAvg: avg(rs.map((r) => Number(r.futTurnover ?? 0))),
      futVolume20dAvg: avg(rs.map((r) => Number(r.futVolume ?? 0))),
      priorDayHigh: pos(prev.eqHigh),
      priorDayLow: pos(prev.eqLow),
      priorDayClose: pos(prev.eqClose),
      rangeSpread20dAvg: avg(
        rs.map((r) => {
          const c = Number(r.eqClose ?? 0);
          const h = Number(r.eqHigh ?? 0);
          const l = Number(r.eqLow ?? 0);
          return c > 0 && h >= l && h > 0 ? (h - l) / c : 0;
        })
      ),
      high5d: extremeOf(
        rs.map((r) => Number(r.eqHigh ?? 0)),
        5,
        'max'
      ),
      low5d: extremeOf(
        rs.map((r) => Number(r.eqLow ?? 0)),
        5,
        'min'
      ),
      high20d: extremeOf(
        rs.map((r) => Number(r.eqHigh ?? 0)),
        20,
        'max'
      ),
      low20d: extremeOf(
        rs.map((r) => Number(r.eqLow ?? 0)),
        20,
        'min'
      ),
      eqTurnover20dAvg: avg(rs.map((r) => Number(r.eqTurnover ?? 0))),
      combinedOiPrev: pos(Number(prev.futOi ?? 0) + Number(prev.optOi ?? 0)),
      combinedOi20dAvg: avg(rs.map((r) => Number(r.futOi ?? 0) + Number(r.optOi ?? 0))),
    });
  }

  const tickEpoch = (hhmm: string): number => Math.floor(Date.parse(`${date}T${hhmm}:00+05:30`) / 1000);
  const ticks: number[] = [];
  for (let m = 9 * 60 + 40; m <= 11 * 60; m += 5) {
    ticks.push(tickEpoch(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`));
  }
  const rankTableExists =
    (
      db.prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='rank_snapshots'`).get() as {
        c: number;
      }
    ).c > 0;
  let candidateSymbolsByTick: Map<number, Set<string>> | null = null;
  let rankHistoryBySymbol: Map<string, Map<string, RankPoint[]>> | null = null;
  let scanModeRecorded = false;
  if (rankTableExists) {
    const rankColumns = new Set(
      (
        db.prepare(`PRAGMA table_info(rank_snapshots)`).all() as {
          name: string;
        }[]
      ).map((column) => column.name)
    );
    const rankRows = db
      .prepare(
        `SELECT bucketTs, feed, symbol, rank,
                ${rankColumns.has('fullUniverse') ? 'fullUniverse' : 'NULL'} AS fullUniverse
         FROM rank_snapshots
         WHERE date=? ORDER BY feed, bucketTs, rank`
      )
      .all(date) as {
      bucketTs: number;
      feed: string;
      symbol: string;
      rank: number;
      fullUniverse: number | null;
    }[];
    if (rankRows.length > 0) {
      scanModeRecorded = rankRows.some((row) => row.fullUniverse != null);
      // Rank series per symbol per feed (rows arrive ordered feed, bucketTs,
      // rank — so each series is already bucketTs-ascending).
      rankHistoryBySymbol = new Map();
      for (const row of rankRows) {
        const feeds = rankHistoryBySymbol.get(row.symbol) ?? new Map<string, RankPoint[]>();
        const series = feeds.get(row.feed) ?? [];
        series.push({ bucketTs: Number(row.bucketTs), rank: Number(row.rank) });
        feeds.set(row.feed, series);
        rankHistoryBySymbol.set(row.symbol, feeds);
      }
      const byFeedBucket = new Map<string, Map<number, { symbol: string; rank: number }[]>>();
      for (const row of rankRows) {
        const buckets = byFeedBucket.get(row.feed) ?? new Map();
        const bucket = buckets.get(Number(row.bucketTs)) ?? [];
        bucket.push({ symbol: row.symbol, rank: Number(row.rank) });
        buckets.set(Number(row.bucketTs), bucket);
        byFeedBucket.set(row.feed, buckets);
      }
      candidateSymbolsByTick = new Map();
      for (const tick of ticks) {
        const mode = [...rankRows]
          .filter((row) => row.bucketTs <= tick && row.fullUniverse != null)
          .sort((a, b) => b.bucketTs - a.bucketTs)[0]?.fullUniverse;
        if (mode === 1) {
          candidateSymbolsByTick.set(tick, new Set(symbols));
          continue;
        }
        const members = new Set<string>();
        for (const [feed, buckets] of byFeedBucket) {
          const latest = [...buckets.keys()].filter((bucket) => bucket <= tick).sort((a, b) => b - a)[0];
          if (latest == null) continue;
          for (const row of buckets.get(latest) ?? []) {
            if (feed !== 'oi' || row.rank <= 24) members.add(row.symbol);
          }
        }
        candidateSymbolsByTick.set(tick, members);
      }
    }
  }
  return {
    date,
    symbols,
    ticks,
    oiSeries,
    eqBars,
    nseOiByBucket,
    sectorBySymbol,
    baselines,
    candidateSymbolsByTick,
    rankHistoryBySymbol,
    coverage: {
      rankSnapshots: candidateSymbolsByTick != null,
      scanModeRecorded,
      optionsLedFields: hasOptionsLedFields,
    },
  };
}

// ─── Replay one variant over one day ─────────────────────────────────────────
export interface ReplayPick {
  symbol: string;
  side: 'CE' | 'PE';
  tick: number;
  /** The tick time as "HH:MM" IST — stamps every evidence number below so a
   *  narration can never silently attach a value from a different moment. */
  asOfIST: string;
  sector: string;
  entry: number;
  sl: number | null;
  target: number | null;
  slBasis: string;
  score: number;
  extended: boolean;
  orBreakout: boolean;
  // ── As-of-tick evidence snapshot (the numbers you'd cite). EVERY field here
  //    comes from THIS tick's replay row — never a stored trade_suggestions
  //    value. This is the single source of truth for narrating the pick;
  //    the mixing that produced the wrong "OI 1.32×" is structurally
  //    impossible now (there is no other source to reach for). ──
  rFactor: number | null;
  rFactorConfidence: number | null;
  oiLevel: number | null;
  oiUrgency: number | null;
  changePctOpen: number | null;
  spreadPct: number | null;
  imbalance: number | null;
  nseOiPct: number | null;
  /** Combined-OI build rate over the trailing ~30 min (pct-points) as of the tick. */
  nseOiSlope30m: number | null;
  /** Best ~30-min leaderboard climb (gainers/OI boards; positive = climbing)
   *  as of the tick — evidence for the minRankClimb experiment. */
  rankClimb30m: number | null;
  /** Sector turnover-weighted % move as of the tick + whether it agrees with the trade. */
  sectorPct: number | null;
  sectorAligned: boolean | null;
  // Factor-alignment context (for the evidence report, not the score):
  vwapAligned: boolean | null;
  supertrendAligned: boolean | null;
  tiltAligned: boolean | null;
  eqTurnoverRatio: number | null;
  combinedOiLevel: number | null;
  /** Human-readable reasons, generated HERE from the fields above — the text a
   *  narration should quote verbatim instead of re-deriving numbers. */
  reasons: string[];
}

export function replayVariant(
  day: DayData,
  variant: Variant,
  opts?: ReplayOptions
): { picks: ReplayPick[]; gateCounts: Record<string, number> } {
  const firstSeen = new Map<string, ReplayPick>();
  const gateCounts: Record<string, number> = {};
  const bump = (k: string) => {
    gateCounts[k] = (gateCounts[k] ?? 0) + 1;
  };
  /** Best ~30-min leaderboard climb across the gainers/OI boards as of a tick
   *  (positive = climbing; null = no supportable read on either board). Only
   *  those two feeds count — the live engine's CLIMB_FEEDS (rank-tracker.ts);
   *  rank_snapshots also holds 'active-value' rows the gate never reads.
   *  `opts` narrows which climbs QUALIFY (the catch-gate refinements under
   *  evaluation); omit for the plain evidence read. */
  const bestRankClimbOf = (
    symbol: string,
    asOf: number,
    opts?: { gainersOnly?: boolean; maxRank?: number | null }
  ): number | null => {
    const feeds = day.rankHistoryBySymbol?.get(symbol);
    if (!feeds) return null;
    let best: number | null = null;
    for (const [feed, series] of feeds) {
      if (feed !== 'gainers' && feed !== 'oi') continue;
      if (opts?.gainersOnly && feed !== 'gainers') continue;
      const climb = rankClimb(series, asOf);
      if (climb == null) continue;
      if (opts?.maxRank != null) {
        // rankClimb returned non-null, so the series has a fresh point ≤ asOf —
        // its rank is the destination the climb was measured to.
        const pts = series.filter((p) => p.bucketTs <= asOf);
        if (pts[pts.length - 1].rank > opts.maxRank) continue;
      }
      if (best == null || climb > best) best = climb;
    }
    return best;
  };

  for (const tick of day.ticks) {
    const tickBucket = bucketOf(tick);
    const candidateSymbols = day.candidateSymbolsByTick
      ? [...(day.candidateSymbolsByTick.get(tick) ?? new Set<string>())]
      : day.symbols;
    interface Surv {
      row: LiveUrgencyRow;
      sector: string;
      direction: 'bullish' | 'bearish';
      orBreakout: boolean;
      bars: Bar[];
      or: { openRangeHigh: number | null; openRangeLow: number | null };
      setupLevel: string;
      extended: boolean;
      score: number;
    }
    const survivors: Surv[] = [];
    let upCount = 0;
    let downCount = 0;

    // Sector strength as-of this tick (turnover-weighted move + breadth, the
    // heatmap's aggregation) — for the requireSectorAlign gate + pick evidence.
    const sectorTiles: { sector: string; pct: number; turnover: number }[] = [];
    for (const s of candidateSymbols) {
      const series = (day.oiSeries.get(s) ?? []).filter((p) => p.bucketTs <= tick);
      const snap = series[series.length - 1];
      const sector = day.sectorBySymbol.get(s);
      if (snap && snap.ltp > 0 && sector) {
        sectorTiles.push({
          sector,
          pct: snap.changePctOpen ?? 0,
          turnover: snap.futTurnover > 0 ? snap.futTurnover : 0,
        });
      }
    }
    const sectorAgg = new Map<string, SectorAggregate>(aggregateSectors(sectorTiles).map((a) => [a.sector, a]));
    const alignmentOf = (
      sector: string,
      direction: 'bullish' | 'bearish'
    ): { sa: SectorAggregate | null; aligned: boolean | null } => {
      const sa = sectorAgg.get(sector) ?? null;
      const aligned =
        sa == null || Math.abs(sa.weightedPct) < 0.1
          ? null
          : direction === 'bullish'
            ? sa.weightedPct > 0
            : sa.weightedPct < 0;
      return { sa, aligned };
    };

    for (const s of candidateSymbols) {
      const series = (day.oiSeries.get(s) ?? []).filter((p) => p.bucketTs <= tick);
      const snap = series[series.length - 1];
      if (!snap || snap.ltp <= 0) {
        bump('noPrice');
        continue;
      }
      // Tilt basis: move vs the PREVIOUS CLOSE (captures the gap; change-from-
      // open reads near-flat on gap days), falling back to change-from-open.
      const prevC = day.baselines.get(s)?.priorDayClose;
      const tiltChg = prevC != null && prevC > 0 ? ((snap.ltp - prevC) / prevC) * 100 : (snap.changePctOpen ?? 0);
      if (tiltChg > 0) upCount++;
      else if (tiltChg < 0) downCount++;

      const bars = (day.eqBars.get(s) ?? []).filter((b) => b.bucketTs < tickBucket && b.high > 0);
      const sc = deriveSessionContext(bars);
      const urgency = computeOiUrgency(series);
      const base = day.baselines.get(s);
      const rfIn = buildLiveRFactorInput(
        {
          symbol: s,
          ltp: snap.ltp,
          changePctOpen: snap.changePctOpen,
          bid: null, // not recorded — the spread factor reports unavailable (live had it)
          ask: null,
          spreadPct: snap.spreadPct,
          futOi: snap.futOi > 0 ? snap.futOi : null,
          turnover: snap.futTurnover > 0 ? snap.futTurnover : null,
          dayHigh: sc.dayHigh,
          dayLow: sc.dayLow,
        },
        base,
        sc,
        new Date(tick * 1000)
      );
      const r = rfIn ? computeRFactor(rfIn, { weights: variant.rfWeights }) : null;
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

      // ── The engine's gate sequence, verbatim order (thresholds from variant) ──
      const verdict = setupScore(row);
      if (verdict.level === 'illiquid' || row.spreadPct == null || row.spreadPct > SUGGESTION_MAX_SPREAD_PCT) {
        bump('illiquid');
        continue;
      }
      if (row.rFactorBias == null || row.rFactorBias === 'neutral') {
        bump('neutralBias');
        continue;
      }
      // direction + breakout + trend indicators are computed BEFORE the R/
      // confidence gates so the momentum-breakout path (and the OI-gate breakout
      // bypass) can use them — mirrors the live engine's order exactly.
      const direction = row.rFactorBias === 'buy' ? 'bullish' : 'bearish';
      const orBreakout =
        sc.openRangeComplete &&
        (direction === 'bullish'
          ? sc.openRangeHigh != null && snap.ltp > sc.openRangeHigh
          : sc.openRangeLow != null && snap.ltp < sc.openRangeLow);
      const lastCompletedBar = bars.at(-1) ?? null;
      const confirmedOrBreakout =
        sc.openRangeComplete &&
        lastCompletedBar != null &&
        (direction === 'bullish'
          ? sc.openRangeHigh != null &&
            lastCompletedBar.close > sc.openRangeHigh &&
            snap.ltp > sc.openRangeHigh
          : sc.openRangeLow != null && lastCompletedBar.close < sc.openRangeLow && snap.ltp < sc.openRangeLow);
      const volumeLookback = bars.slice(-7, -1).filter((bar) => bar.volume > 0);
      const priorAverageVolume =
        volumeLookback.length > 0
          ? volumeLookback.reduce((sum, bar) => sum + bar.volume, 0) / volumeLookback.length
          : null;
      const breakoutVolumeRatio =
        lastCompletedBar != null && priorAverageVolume != null && priorAverageVolume > 0
          ? lastCompletedBar.volume / priorAverageVolume
          : null;
      const st = supertrend(bars);
      const vw = sessionVwap(bars);
      const supertrendAligned =
        st == null ? null : direction === 'bullish' ? st.direction === 'up' : st.direction === 'down';
      const vwapAligned = vw == null ? null : direction === 'bullish' ? snap.ltp > vw : snap.ltp < vw;

      // Momentum-breakout path (variant experiment; see momentum-breakout.ts):
      // clears the R-Factor, confidence, OI and quiet-setup gates on a confirmed
      // OR breakout + BOTH trend indicators agreeing + a real move behind it.
      const momentumOk =
        variant.momentumBreakout &&
        qualifiesMomentumBreakout(
          {
            orBreakout,
            supertrendAligned,
            vwapAligned,
            changePctOpen: snap.changePctOpen,
            direction,
          },
          { minChangePct: variant.momentumMinChangePct }
        );
      if (momentumOk) bump('momentumAdmitted');

      if (!momentumOk && (row.rFactor ?? 0) < variant.minRFactor) {
        bump('weakRFactor');
        continue;
      }
      if (!momentumOk && (row.rFactorConfidence ?? 0) < variant.minConfidence) {
        bump('lowConfidence');
        continue;
      }
      const futOiOk = (row.oiLevel ?? 0) >= variant.minOiLevel;
      const nseRows = (day.nseOiByBucket.get(s) ?? []).filter((b) => b.bucketTs <= tick && b.nseOiPct != null);
      const nseOiPct = nseRows.length > 0 ? nseRows[nseRows.length - 1].nseOiPct : null;
      const nseOptionsLegsOk =
        snap.optShare != null &&
        snap.optShare >= MIN_OPT_SHARE &&
        snap.premValueCr != null &&
        snap.premValueCr >= MIN_OPT_PREMIUM_CR;
      let nseOiOk = nseOiPct != null && nseOiPct >= variant.minNseOiPct && nseOptionsLegsOk;
      // Slope refinement of the options-led path: the combined-OI build must
      // still be moving over the trailing ~30 min, not just a stale level.
      if (nseOiOk && variant.minNseOiSlope != null) {
        const slope = combinedOiSlope(nseRows, tick);
        nseOiOk = slope != null && slope >= variant.minNseOiSlope;
      }
      // Rank-climb CATCH path — mirrors the live engine.ts gate exactly: a
      // smaller build (≥ rankClimbMinNsePct, < minNseOiPct) with qualifying
      // options legs passes IF the name is climbing the gainers/OI leaderboard.
      // No board history = no climb evidence = not admitted via this path.
      if (
        !nseOiOk &&
        variant.rankClimbCatch &&
        nseOiPct != null &&
        nseOiPct >= variant.rankClimbMinNsePct &&
        nseOiPct < variant.minNseOiPct &&
        nseOptionsLegsOk
      ) {
        const climb = bestRankClimbOf(s, tick, {
          gainersOnly: variant.rankClimbGainersOnly,
          maxRank: variant.rankClimbMaxRank,
        });
        if (climb != null && climb >= variant.rankClimbMinSpots) {
          bump('climbAdmitted');
          nseOiOk = true;
        }
      }
      // Fourth OI-gate path — a confirmed, trend-aligned, high-R breakout with
      // NO OI evidence still clears (breakout-bypass.ts). Evaluated only when OI
      // evidence is absent AND the variant enables it.
      let breakoutOk = false;
      if (variant.breakoutBypass && !futOiOk && !nseOiOk && orBreakout) {
        breakoutOk = qualifiesByBreakout(
          { orBreakout, supertrendAligned, vwapAligned, rFactor: row.rFactor },
          {
            minRFactor: variant.breakoutMinRFactor,
            requireTrendAlign: variant.breakoutRequireTrend,
          }
        );
      }
      if (!futOiOk && !nseOiOk && !breakoutOk && !momentumOk) {
        bump('lowOiLevel');
        continue;
      }
      const turnoverFactor = row.rFactors?.find((f) => f.label.startsWith('Turnover'));
      if (!turnoverFactor?.available || turnoverFactor.score < MIN_TURNOVER_SCORE) {
        bump('lowTurnover');
        continue;
      }
      const chg = snap.changePctOpen ?? 0;
      if (!(direction === 'bullish' ? chg > 0 || orBreakout : chg < 0 || orBreakout)) {
        bump('directionDisagree');
        continue;
      }
      if (variant.requireConfirmedOrb && !confirmedOrBreakout) {
        bump('confirmedOrbMissing');
        continue;
      }
      if (
        variant.minBreakoutVolumeRatio != null &&
        (breakoutVolumeRatio == null || breakoutVolumeRatio < variant.minBreakoutVolumeRatio)
      ) {
        bump('breakoutVolumeWeak');
        continue;
      }
      // Supertrend/VWAP alignment hard gates — the live engine enforces these
      // (added from the July 10–13 benchmark: 0/3 wins misaligned); mirrored
      // here for fidelity. null = not yet computable = gate skipped, as live.
      if (variant.requireSupertrendAlign !== false && supertrendAligned === false) {
        bump('supertrendDisagree');
        continue;
      }
      if (vwapAligned === false) {
        bump('vwapDisagree');
        continue;
      }
      // Sector-alignment gate (variant experiment; flat/unknown sectors pass).
      if (variant.requireSectorAlign && alignmentOf(day.sectorBySymbol.get(s) ?? '', direction).aligned === false) {
        bump('sectorMisaligned');
        continue;
      }
      if (verdict.level === 'quiet' && !momentumOk) {
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
        score: 0,
      });
    }

    const breadth = new Map<string, number>();
    for (const sv of survivors) {
      if (!sv.sector) continue;
      const k = `${sv.sector}:${sv.direction}`;
      breadth.set(k, (breadth.get(k) ?? 0) + 1);
    }
    for (const sv of survivors) {
      sv.score = computeCompositeScore(
        {
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
        },
        variant.weights,
        variant.extendedMult
      );
    }
    survivors.sort((a, b) => b.score - a.score);

    const tiltUp = upCount > downCount * 1.5;
    const tiltDown = downCount > upCount * 1.5;
    const eligible = variant.banExtended
      ? survivors.filter((sv) => {
          if (!sv.extended) return true;
          // Extended + ban on. Trend-aligned bypass (variant experiment): re-admit
          // only genuine trend-day continuations — breakout + VWAP + Supertrend —
          // exactly as the live engine does (lib/trade-suggest/extended-bypass.ts).
          if (!variant.extendedTrendBypass) return false;
          const ltp = sv.row.ltp ?? 0;
          const vw = sessionVwap(sv.bars);
          const st = supertrend(sv.bars);
          const vwapAligned = vw == null ? null : sv.direction === 'bullish' ? ltp > vw : ltp < vw;
          const supertrendAligned =
            st == null ? null : sv.direction === 'bullish' ? st.direction === 'up' : st.direction === 'down';
          return qualifiesExtendedTrend(
            {
              orBreakout: sv.orBreakout,
              supertrendAligned,
              vwapAligned,
              rFactor: sv.row.rFactor,
            },
            {
              minRFactor: variant.extendedBypassMinRFactor ?? EXTENDED_BYPASS_MIN_RFACTOR,
              requireSupertrend: variant.extendedBypassRequireSupertrend ?? EXTENDED_BYPASS_REQUIRE_SUPERTREND,
            }
          );
        })
      : survivors;
    for (const sv of eligible.slice(0, MAX_PICKS)) {
      if (!opts?.allFires && firstSeen.size >= REPLAY_DAILY_TRADE_CAP) break;
      const side: 'CE' | 'PE' = sv.direction === 'bullish' ? 'CE' : 'PE';
      const key = `${sv.row.symbol}:${side}`;
      if (firstSeen.has(key)) continue;
      const entry = sv.row.ltp ?? 0;
      const a14 = atr(sv.bars);
      const plan = buildSpotPlan(side, entry, sv.bars, sv.or, tickBucket, {
        atr: a14,
        atrMult: variant.atrMult,
      });
      const vw = sessionVwap(sv.bars);
      const st = supertrend(sv.bars);
      const base = day.baselines.get(sv.row.symbol);
      const eqTurnNow = sv.bars.reduce((acc, b) => acc + b.close * b.volume, 0);
      // Session fraction elapsed at the tick (IST): minutes since 09:15 ÷ 375.
      const istMin = ((((tick + 19800) % 86400) + 86400) % 86400) / 60;
      const frac = Math.min(1, Math.max(0.02, (istMin - (9 * 60 + 15)) / 375));
      const nseRows = (day.nseOiByBucket.get(sv.row.symbol) ?? []).filter(
        (b) => b.bucketTs <= tick && b.nseOiPct != null
      );
      const nsePct = nseRows.length > 0 ? nseRows[nseRows.length - 1].nseOiPct : null;
      const nseSlope = combinedOiSlope(nseRows, tick);
      const pickRankClimb = bestRankClimbOf(sv.row.symbol, tick);
      const { sa: pickSa, aligned: pickSectorAligned } = alignmentOf(sv.sector, sv.direction);
      const pickSectorPct = pickSa == null ? null : Math.round(pickSa.weightedPct * 100) / 100;
      const asOfMin = Math.round(istMin);
      const asOfIST = `${String(Math.floor(asOfMin / 60)).padStart(2, '0')}:${String(asOfMin % 60).padStart(2, '0')}`;
      const eqTurnoverRatio =
        base?.eqTurnover20dAvg != null && eqTurnNow > 0
          ? Math.round((eqTurnNow / (base.eqTurnover20dAvg * frac)) * 100) / 100
          : null;
      const combinedOiLevel =
        base?.combinedOiPrev != null && base.combinedOi20dAvg != null && nsePct != null
          ? Math.round(((base.combinedOiPrev * (1 + nsePct / 100)) / base.combinedOi20dAvg) * 1000) / 1000
          : null;
      const vwapAligned = vw == null ? null : side === 'CE' ? entry > vw : entry < vw;
      const supertrendAligned = st == null ? null : side === 'CE' ? st.direction === 'up' : st.direction === 'down';
      const r = sv.row;
      // Reasons generated HERE, purely from this tick's row + indicators. Every
      // number is implicitly "as of asOfIST" — no stored-row values reachable.
      const reasons = [
        `R-Factor ${r.rFactor?.toFixed(2) ?? '—'} ${sv.direction} (confidence ${((r.rFactorConfidence ?? 0) * 100).toFixed(0)}%)`,
        `futures OI ${r.oiLevel?.toFixed(2) ?? '—'}× 20-day avg${r.oiUrgency != null && r.oiUrgency > 0 ? `, urgency ${r.oiUrgency.toFixed(1)}/10` : ''}`,
        nsePct != null
          ? `NSE combined OI ${nsePct >= 0 ? '+' : ''}${nsePct.toFixed(1)}% (fut+opt)`
          : 'NSE combined OI not recorded at this tick',
        ...(nseSlope != null
          ? [`combined-OI slope ${nseSlope >= 0 ? '+' : ''}${nseSlope.toFixed(1)} pts / ~30 min`]
          : []),
        ...(pickRankClimb != null
          ? [
              `leaderboard ${pickRankClimb > 0 ? `climbing +${pickRankClimb}` : pickRankClimb < 0 ? `slipping ${pickRankClimb}` : 'holding ±0'} spots / ~30 min (best of gainers/OI boards)`,
            ]
          : []),
        ...(combinedOiLevel != null
          ? [`combined fut+opt OI ≈${combinedOiLevel.toFixed(2)}× 20-day avg (derived)`]
          : []),
        `change from open ${r.changePctOpen != null ? `${r.changePctOpen >= 0 ? '+' : ''}${r.changePctOpen.toFixed(2)}%` : 'n/a'}`,
        sv.orBreakout
          ? 'trading beyond the opening range (breakout confirmed)'
          : 'inside the opening range (no breakout yet)',
        st != null
          ? `Supertrend(10,3) ${st.direction}${supertrendAligned ? ' — agrees' : ' — DISAGREES with the trade'}`
          : 'Supertrend unavailable',
        vw != null
          ? `${vwapAligned ? 'favorable' : 'wrong'} side of session VWAP ${vw.toFixed(2)}`
          : 'VWAP unavailable',
        ...(pickSa != null && pickSectorAligned != null
          ? [
              `sector ${sv.sector} ${pickSectorPct! >= 0 ? '+' : ''}${pickSectorPct!.toFixed(2)}% (turnover-weighted, ${pickSa.advancers}↑/${pickSa.decliners}↓) — ${pickSectorAligned ? 'agrees' : 'FIGHTING the sector'}`,
            ]
          : []),
        ...(eqTurnoverRatio != null
          ? [`equity turnover ≈${eqTurnoverRatio.toFixed(1)}× time-adjusted 20-day pace`]
          : []),
        `spread ${r.spreadPct != null ? `${r.spreadPct.toFixed(3)}%` : 'n/a'}`,
      ];
      firstSeen.set(key, {
        symbol: sv.row.symbol,
        side,
        tick,
        asOfIST,
        sector: sv.sector,
        entry,
        sl: plan.slSpot,
        target: plan.targetSpot,
        slBasis: plan.slBasis,
        score: Math.round(sv.score * 1000) / 1000,
        extended: sv.extended,
        orBreakout: sv.orBreakout,
        rFactor: r.rFactor,
        rFactorConfidence: r.rFactorConfidence,
        oiLevel: r.oiLevel,
        oiUrgency: r.oiUrgency,
        changePctOpen: r.changePctOpen,
        spreadPct: r.spreadPct,
        imbalance: r.imbalance,
        nseOiPct: nsePct,
        nseOiSlope30m: nseSlope,
        rankClimb30m: pickRankClimb,
        sectorPct: pickSectorPct,
        sectorAligned: pickSectorAligned,
        vwapAligned,
        supertrendAligned,
        tiltAligned: tiltUp || tiltDown ? (side === 'CE' ? tiltUp : tiltDown) : null,
        eqTurnoverRatio,
        combinedOiLevel,
        reasons,
      });
    }
  }
  return { picks: [...firstSeen.values()], gateCounts };
}

// ─── Outcome scoring (bar-by-bar to the close; SL wins ties — conservative) ──
export interface Outcome {
  hit: 'target' | 'sl' | 'open';
  rMultiple: number;
  maxFavPct: number;
  maxAdvPct: number;
  closePct: number;
}
export function scorePick(day: DayData, p: ReplayPick): Outcome | null {
  const after = (day.eqBars.get(p.symbol) ?? []).filter((b) => b.bucketTs >= bucketOf(p.tick) && b.high > 0);
  if (after.length === 0 || p.entry <= 0) return null;
  const sgn = p.side === 'CE' ? 1 : -1;
  const risk = p.sl != null ? Math.abs(p.entry - p.sl) : null;
  let hit: Outcome['hit'] = 'open';
  for (const b of after) {
    if (p.sl != null && (p.side === 'CE' ? b.low <= p.sl : b.high >= p.sl)) {
      hit = 'sl';
      break;
    }
    if (p.target != null && (p.side === 'CE' ? b.high >= p.target : b.low <= p.target)) {
      hit = 'target';
      break;
    }
  }
  const hi = Math.max(...after.map((b) => b.high));
  const lo = Math.min(...after.map((b) => b.low));
  const close = after[after.length - 1].close;
  const pct = (v: number) => ((v - p.entry) / p.entry) * 100;
  const closeMove = sgn * (close - p.entry);
  return {
    hit,
    rMultiple: hit === 'target' ? TARGET_RR : hit === 'sl' ? -1 : risk != null && risk > 0 ? closeMove / risk : 0,
    maxFavPct: p.side === 'CE' ? pct(hi) : -pct(lo),
    maxAdvPct: p.side === 'CE' ? -pct(lo) : pct(hi),
    closePct: sgn * pct(close),
  };
}

/** One day's scoreboard for a variant. */
export interface DayResult {
  date: string;
  picks: { p: ReplayPick; o: Outcome }[];
  totalR: number;
  targets: number;
  stops: number;
  hits1pct: number;
}
export function evaluateDay(day: DayData, variant: Variant, opts?: ReplayOptions): DayResult {
  const { picks } = replayVariant(day, variant, opts);
  const outs = picks
    .map((p) => ({ p, o: scorePick(day, p) }))
    .filter((x): x is { p: ReplayPick; o: Outcome } => x.o !== null);
  return {
    date: day.date,
    picks: outs,
    totalR: outs.reduce((a, x) => a + x.o.rMultiple, 0),
    targets: outs.filter((x) => x.o.hit === 'target').length,
    stops: outs.filter((x) => x.o.hit === 'sl').length,
    hits1pct: outs.filter((x) => x.o.maxFavPct >= 1).length,
  };
}
