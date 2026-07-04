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
 * Universe = symbols in oi_intraday for the date (what /live actually
 * tracked), baselines = bhavcopy STRICTLY BEFORE the date. Known fidelity
 * gaps vs live, stated not hidden: bid/ask weren't recorded (the R-Factor
 * spread factor reports unavailable; live had it), and option premiums
 * weren't recorded (the affordability gate is skipped).
 *
 * CLIs on top of this library:
 *   npx tsx scripts/replay-window.ts [date]      — named-variant grid
 *   npx tsx scripts/autoresearch.ts [n] [seed]   — autonomous experiment loop
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import Database from 'better-sqlite3';
import { setupScore } from '../app/live/_lib/setup-score';
import type { LiveUrgencyRow } from '../app/live/_lib/types';
import { buildLiveRFactorInput } from '../app/api/live/_lib/rfactor-inputs';
import type { RFactorBaseline } from '../app/api/live/_lib/rfactor-baselines';
import { computeRFactor, DEFAULT_WEIGHTS as RF_DEFAULT_WEIGHTS, type RFactorWeights } from '../lib/r-factor';
import { atr, sessionVwap, supertrend } from '../lib/signals/indicators';
import { computeOiUrgency, type OiPoint } from '../lib/signals/oi-intraday';
import { deriveSessionContext } from '../lib/signals/session-context';
import {
  EXCLUDE_EXTENDED,
  EXTENDED_SCORE_MULT,
  MAX_PICKS,
  MAX_SPREAD_PCT,
  MIN_CONFIDENCE,
  MIN_NSE_OI_PCT,
  MIN_OI_LEVEL,
  MIN_RFACTOR,
  MIN_TURNOVER_SCORE,
  SL_ATR_MULT,
  TARGET_RR,
  WEIGHTS,
} from '../lib/trade-suggest/config';
import { buildSpotPlan, computeCompositeScore, type ScoreWeights } from '../lib/trade-suggest/scoring';

const db = new Database('./data/project-r.db', { readonly: true });

// ─── Experiment configuration (what the loop is allowed to mutate) ──────────
export interface Variant {
  name: string;
  atrMult: number; // risk floor = max(0.35%, atrMult × ATR14)
  extendedMult: number; // score multiplier for ≥3%-moved names (flag-off path)
  banExtended: boolean; // hard-skip extended movers at pick time (EXCLUDE_EXTENDED)
  weights: ScoreWeights;
  /** The R-Factor engine's INTERNAL 12-factor blend — searchable per variant
   *  (the engine renormalizes over available factors, so no sum constraint). */
  rfWeights: RFactorWeights;
  // Gate overrides — default to the production config values.
  minRFactor: number;
  minConfidence: number;
  minOiLevel: number;
  minNseOiPct: number;
}

/** Mirrors the production config — the loop's baseline. */
export const SHIPPED_VARIANT: Variant = {
  name: 'shipped',
  atrMult: SL_ATR_MULT,
  extendedMult: EXTENDED_SCORE_MULT,
  banExtended: EXCLUDE_EXTENDED,
  weights: WEIGHTS,
  rfWeights: RF_DEFAULT_WEIGHTS,
  minRFactor: MIN_RFACTOR,
  minConfidence: MIN_CONFIDENCE,
  minOiLevel: MIN_OI_LEVEL,
  minNseOiPct: MIN_NSE_OI_PCT,
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
}

/** All sessions with recorded intraday OI (each is a usable benchmark day). */
export function listRecordedDates(): string[] {
  return (db.prepare(`SELECT DISTINCT date FROM oi_intraday ORDER BY date ASC`).all() as { date: string }[]).map((r) => r.date);
}

const avg = (values: number[]): number | null => {
  const xs = values.filter((v) => v > 0).slice(0, 20);
  return xs.length >= 5 ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
};
const pos = (v: unknown): number | null => (v != null && Number(v) > 0 ? Number(v) : null);
const bucketOf = (ts: number): number => ts - (ts % 300);

/** Load one recorded session; null when nothing was recorded for the date. */
export function loadDay(date: string): DayData | null {
  const symbols = (db.prepare(`SELECT DISTINCT symbol FROM oi_intraday WHERE date=?`).all(date) as { symbol: string }[]).map(
    (r) => r.symbol,
  );
  if (symbols.length === 0) return null;
  // DATA-COVERAGE GUARD: the replay needs 5-min candles (opening range, ATR,
  // SL, outcome scoring). The Fyers recorder only started 2026-07-03; earlier
  // dates have oi_intraday but ZERO fyers_candles — replaying them yields
  // zero picks as an artifact, which poisons the experiment metric (found
  // 2026-07-04: the loop "improved" by loosening gates against 8 empty days).
  // A day without candle coverage is not a benchmark day.
  const eqBarCount = (db.prepare(`SELECT COUNT(*) AS c FROM fyers_candles WHERE date=? AND instrument='EQ'`).get(date) as { c: number }).c;
  if (eqBarCount === 0) return null;
  const sectorBySymbol = new Map(
    (db.prepare(`SELECT symbol, sector FROM fno_stocks`).all() as { symbol: string; sector: string }[]).map((r) => [r.symbol, r.sector]),
  );
  const oiSeries = new Map<string, OiPoint[]>();
  const eqBars = new Map<string, Bar[]>();
  const nseOiByBucket = new Map<string, { bucketTs: number; nseOiPct: number | null }[]>();
  for (const s of symbols) {
    oiSeries.set(
      s,
      db
        .prepare(
          `SELECT bucketTs, ltp, futOi, oiLevel, futTurnover, changePctOpen, spreadPct, imbalance
           FROM oi_intraday WHERE symbol=? AND date=? ORDER BY bucketTs ASC`,
        )
        .all(s, date) as OiPoint[],
    );
    eqBars.set(
      s,
      db
        .prepare(
          `SELECT bucketTs, open, high, low, close, volume FROM fyers_candles WHERE symbol=? AND date=? AND instrument='EQ' ORDER BY bucketTs ASC`,
        )
        .all(s, date) as Bar[],
    );
    nseOiByBucket.set(
      s,
      db
        .prepare(`SELECT bucketTs, nseOiPct FROM fyers_candles WHERE symbol=? AND date=? AND instrument='FUT' ORDER BY bucketTs ASC`)
        .all(s, date) as { bucketTs: number; nseOiPct: number | null }[],
    );
  }

  // Baselines: bhavcopy STRICTLY BEFORE the replay date (what live saw that
  // morning). Mirrors app/api/live/_lib/rfactor-baselines.ts.
  const baselines = new Map<string, BaselinePlus>();
  for (const s of symbols) {
    const rs = db
      .prepare(
        `SELECT futOi, optOi, futTurnover, futVolume, eqTurnover, eqHigh, eqLow, eqClose
         FROM bhavcopy_days WHERE symbol=? AND date<? ORDER BY date DESC LIMIT 25`,
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
        }),
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
  return { date, symbols, ticks, oiSeries, eqBars, nseOiByBucket, sectorBySymbol, baselines };
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

export function replayVariant(day: DayData, variant: Variant): { picks: ReplayPick[]; gateCounts: Record<string, number> } {
  const firstSeen = new Map<string, ReplayPick>();
  const gateCounts: Record<string, number> = {};
  const bump = (k: string) => {
    gateCounts[k] = (gateCounts[k] ?? 0) + 1;
  };

  for (const tick of day.ticks) {
    const tickBucket = bucketOf(tick);
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

    for (const s of day.symbols) {
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
          futOi: snap.futOi > 0 ? snap.futOi : null,
          turnover: snap.futTurnover > 0 ? snap.futTurnover : null,
          dayHigh: sc.dayHigh,
          dayLow: sc.dayLow,
        },
        base,
        sc,
        new Date(tick * 1000),
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
        rFactors: r?.factors.map((f) => ({ label: f.label, score: f.score, vote: f.vote, available: f.available, detail: f.detail })) ?? null,
      };

      // ── The engine's gate sequence, verbatim order (thresholds from variant) ──
      const verdict = setupScore(row);
      if (verdict.level === 'illiquid' || row.spreadPct == null || row.spreadPct > MAX_SPREAD_PCT) {
        bump('illiquid');
        continue;
      }
      if (row.rFactorBias == null || row.rFactorBias === 'neutral') {
        bump('neutralBias');
        continue;
      }
      if ((row.rFactor ?? 0) < variant.minRFactor) {
        bump('weakRFactor');
        continue;
      }
      if ((row.rFactorConfidence ?? 0) < variant.minConfidence) {
        bump('lowConfidence');
        continue;
      }
      const futOiOk = (row.oiLevel ?? 0) >= variant.minOiLevel;
      const nseRows = (day.nseOiByBucket.get(s) ?? []).filter((b) => b.bucketTs <= tick && b.nseOiPct != null);
      const nseOiPct = nseRows.length > 0 ? nseRows[nseRows.length - 1].nseOiPct : null;
      if (!futOiOk && !(nseOiPct != null && nseOiPct >= variant.minNseOiPct)) {
        bump('lowOiLevel');
        continue;
      }
      const turnoverFactor = row.rFactors?.find((f) => f.label.startsWith('Turnover'));
      if (!turnoverFactor?.available || turnoverFactor.score < MIN_TURNOVER_SCORE) {
        bump('lowTurnover');
        continue;
      }
      const direction = row.rFactorBias === 'buy' ? 'bullish' : 'bearish';
      const orBreakout =
        sc.openRangeComplete &&
        (direction === 'bullish' ? sc.openRangeHigh != null && snap.ltp > sc.openRangeHigh : sc.openRangeLow != null && snap.ltp < sc.openRangeLow);
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
        variant.extendedMult,
      );
    }
    survivors.sort((a, b) => b.score - a.score);

    const tiltUp = upCount > downCount * 1.5;
    const tiltDown = downCount > upCount * 1.5;
    const eligible = variant.banExtended ? survivors.filter((sv) => !sv.extended) : survivors;
    for (const sv of eligible.slice(0, MAX_PICKS)) {
      const side: 'CE' | 'PE' = sv.direction === 'bullish' ? 'CE' : 'PE';
      const key = `${sv.row.symbol}:${side}`;
      if (firstSeen.has(key)) continue;
      const entry = sv.row.ltp ?? 0;
      const a14 = atr(sv.bars);
      const plan = buildSpotPlan(side, entry, sv.bars, sv.or, tickBucket, { atr: a14, atrMult: variant.atrMult });
      const vw = sessionVwap(sv.bars);
      const st = supertrend(sv.bars);
      const base = day.baselines.get(sv.row.symbol);
      const eqTurnNow = sv.bars.reduce((acc, b) => acc + b.close * b.volume, 0);
      // Session fraction elapsed at the tick (IST): minutes since 09:15 ÷ 375.
      const istMin = ((((tick + 19800) % 86400) + 86400) % 86400) / 60;
      const frac = Math.min(1, Math.max(0.02, (istMin - (9 * 60 + 15)) / 375));
      const nseRows = (day.nseOiByBucket.get(sv.row.symbol) ?? []).filter((b) => b.bucketTs <= tick && b.nseOiPct != null);
      const nsePct = nseRows.length > 0 ? nseRows[nseRows.length - 1].nseOiPct : null;
      const asOfMin = Math.round(istMin);
      const asOfIST = `${String(Math.floor(asOfMin / 60)).padStart(2, '0')}:${String(asOfMin % 60).padStart(2, '0')}`;
      const eqTurnoverRatio =
        base?.eqTurnover20dAvg != null && eqTurnNow > 0 ? Math.round((eqTurnNow / (base.eqTurnover20dAvg * frac)) * 100) / 100 : null;
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
        ...(combinedOiLevel != null ? [`combined fut+opt OI ≈${combinedOiLevel.toFixed(2)}× 20-day avg (derived)`] : []),
        `change from open ${r.changePctOpen != null ? `${r.changePctOpen >= 0 ? '+' : ''}${r.changePctOpen.toFixed(2)}%` : 'n/a'}`,
        sv.orBreakout ? 'trading beyond the opening range (breakout confirmed)' : 'inside the opening range (no breakout yet)',
        st != null
          ? `Supertrend(10,3) ${st.direction}${supertrendAligned ? ' — agrees' : ' — DISAGREES with the trade'}`
          : 'Supertrend unavailable',
        vw != null ? `${vwapAligned ? 'favorable' : 'wrong'} side of session VWAP ${vw.toFixed(2)}` : 'VWAP unavailable',
        ...(eqTurnoverRatio != null ? [`equity turnover ≈${eqTurnoverRatio.toFixed(1)}× time-adjusted 20-day pace`] : []),
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
export function evaluateDay(day: DayData, variant: Variant): DayResult {
  const { picks } = replayVariant(day, variant);
  const outs = picks.map((p) => ({ p, o: scorePick(day, p) })).filter((x): x is { p: ReplayPick; o: Outcome } => x.o !== null);
  return {
    date: day.date,
    picks: outs,
    totalR: outs.reduce((a, x) => a + x.o.rMultiple, 0),
    targets: outs.filter((x) => x.o.hit === 'target').length,
    stops: outs.filter((x) => x.o.hit === 'sl').length,
    hits1pct: outs.filter((x) => x.o.maxFavPct >= 1).length,
  };
}
