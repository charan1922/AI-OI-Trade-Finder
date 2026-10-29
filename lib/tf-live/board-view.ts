/**
 * What the /live TF Climbers cockpit shows per name — pure, so CI can pin it.
 * Spec: docs/superpowers/specs/2026-10-08-tf-climbers-cockpit-design.md.
 *
 * gateStrip() mirrors selectTfCandidates() check for check: all ten true ⇔ the
 * selector picks the name (verify-tf-selector.ts proves it), so the card can
 * never disagree with the auto-trader. Missing evidence is null (grey), never true.
 */
import type { TfBoardAt } from '@/lib/tf-live/race';
import { type TfSelectorConfig, type TfSymbolContext, tfMoveFreshness } from '@/lib/tf-live/selector';

export type Gate = boolean | null;

export interface GateStrip {
  climbing: Gate;
  moving: Gate;
  orb: Gate;
  beacon: Gate;
  pool: Gate;
  notExtended: Gate;
  /** "Don't chase" (operator rule 2026-10-09): 09:15 candle and move from prev close vs a normal day. */
  notChasing: Gate;
  /** In /live's visible F&O OI Build-up or Most Active list (operator rule 2026-10-12). */
  inNseList: Gate;
  /** ⑧ Supertrend(10,3) does not point against the trade (operator rule 2026-10-29). */
  supertrend: Gate;
  /** ⑨ The move has started and is not reversing — not 'quiet', not 'fading' (2026-10-29). */
  fresh: Gate;
}

/** The selector's own order. */
export const GATE_ORDER = [
  'climbing',
  'moving',
  'orb',
  'beacon',
  'pool',
  'notExtended',
  'notChasing',
  'inNseList',
  'supertrend',
  'fresh',
] as const;

export const GATE_LABEL: Record<keyof GateStrip, string> = {
  climbing: 'climbing',
  moving: 'moving',
  orb: 'our ORB',
  beacon: 'TF beacon',
  pool: 'options pool',
  notExtended: 'not extended',
  notChasing: 'not chasing',
  inNseList: 'in OI / active list',
  supertrend: 'Supertrend with it',
  fresh: 'move started',
};

export function gateStrip(
  deltaR: number | null,
  pctChange: number | null,
  ctx: TfSymbolContext | undefined,
  cfg: TfSelectorConfig
): GateStrip {
  const side = pctChange == null ? null : pctChange > 0 ? 'CE' : 'PE';
  return {
    climbing: deltaR == null ? null : deltaR > cfg.minDeltaR,
    moving: pctChange == null ? null : Math.abs(pctChange) >= cfg.minAbsPctChange,
    orb: !cfg.requireBreakout ? true : ctx?.breakout == null ? null : ctx.breakout,
    // TF not flagging a name is an answer ("no beacon"), not missing data.
    beacon: !cfg.requireTfBeacon
      ? true
      : ctx == null || side == null
        ? null
        : ctx.tfBeacon === (side === 'CE' ? 'BULL' : 'BEAR'),
    pool: ctx?.premValueCr == null ? null : ctx.premValueCr >= cfg.minPremValueCr,
    // The selector passes an unrecorded 09:45 bar (selector.ts ⑤) — so does the strip,
    // but only when there is context at all.
    notExtended: ctx == null ? null : ctx.sinceEntryPct == null ? true : ctx.sinceEntryPct < cfg.maxSinceEntryPct,
    // Missing daily range or 09:15 candle is grey — and the selector rejects it (⑥).
    notChasing:
      ctx?.stretch == null || ctx.stretch.firstCandle == null
        ? null
        : ctx.stretch.firstCandle < cfg.maxFirstCandleAdr && ctx.stretch.fromPrevCloseAdr < cfg.maxFromPrevCloseAdr,
    // In either visible list = green. In none with every list read = red. A list that was
    // unavailable or stale (and the stock in none of the rest) = grey, like the selector's reject.
    inNseList: !cfg.requireNseList
      ? true
      : ctx?.nseLists == null
        ? null
        : (ctx.nseLists.oiBuildupRank != null &&
              (cfg.maxNseListRank == null || ctx.nseLists.oiBuildupRank <= cfg.maxNseListRank)) ||
            (ctx.nseLists.mostActiveRank != null &&
              (cfg.maxNseListRank == null || ctx.nseLists.mostActiveRank <= cfg.maxNseListRank))
          ? true
          : ctx.nseLists.complete
            ? false
            : null,
    // ⑧ A veto: only a KNOWN disagreement fails. Not-formed passes, exactly as the selector does.
    supertrend: !cfg.rejectSupertrendAgainst ? true : ctx == null ? null : ctx.supertrendAligned !== false,
    // ⑨ Same classification the selector uses (tfMoveFreshness); 'spent'/'unknown' pass.
    fresh: ctx == null ? null : !cfg.rejectMoveProfiles.includes(tfMoveFreshness(ctx).profile),
  };
}

export const allPass = (g: GateStrip): boolean => GATE_ORDER.every((k) => g[k] === true);
export const passedCount = (g: GateStrip): number => GATE_ORDER.filter((k) => g[k] === true).length;

/** Plain English for the first check that is not passed, or null. Read as "needs: …". */
export function firstNeed(g: GateStrip, ctx: TfSymbolContext | undefined, cfg: TfSelectorConfig): string | null {
  for (const k of GATE_ORDER) {
    if (g[k] === true) continue;
    const missing = g[k] == null;
    switch (k) {
      case 'climbing':
        return missing
          ? 'an earlier board to measure the 30-min rate'
          : 'R-Factor to resume climbing (flat over 30 min)';
      case 'moving':
        return missing ? 'a % change from TF' : `a move of at least ${cfg.minAbsPctChange}% to set the side`;
      case 'orb':
        return missing ? 'the 30-min opening range (complete at 09:45)' : 'our 30-min opening-range breakout';
      case 'beacon':
        return missing ? 'TF breakout beacon data' : 'TF breakout beacon in the trade direction';
      case 'pool':
        return missing
          ? 'an options premium reading'
          : `options pool of ₹${cfg.minPremValueCr} Cr (has ₹${Math.round(ctx?.premValueCr ?? 0)} Cr)`;
      case 'notExtended':
        return missing
          ? 'recorded price data'
          : `a pullback — ${(ctx?.sinceEntryPct ?? 0).toFixed(1)}% extended since 09:45 (max ${cfg.maxSinceEntryPct}%)`;
      case 'inNseList':
        return missing
          ? "NSE's live OI Build-up and Most Active lists (unavailable or stale)"
          : "a spot in /live's F&O OI Build-up or Most Active list (it is in neither right now)";
      case 'supertrend':
        return missing ? 'price data for Supertrend' : 'Supertrend(10,3) to turn with the trade (it points against it now)';
      case 'fresh': {
        if (missing || ctx == null) return 'price data since 09:45';
        const f = tfMoveFreshness(ctx);
        return f.profile === 'fading'
          ? `the move to stop reversing — ${Math.abs(f.sinceEntryDirectional ?? 0).toFixed(2)}% against the trade since 09:45`
          : 'the move to start — flat since 09:45 (nothing has started yet)';
      }
      case 'notChasing': {
        const st = ctx?.stretch;
        if (missing || st == null || st.firstCandle == null) return 'a normal-day range and the 09:15 candle (daily data)';
        return st.firstCandle >= cfg.maxFirstCandleAdr
          ? `a calmer open — the 09:15 candle was ${st.firstCandle.toFixed(2)}× a normal day (max ${cfg.maxFirstCandleAdr}×)`
          : `room left — already ${st.fromPrevCloseAdr.toFixed(2)}× a normal day from yesterday's close (max ${cfg.maxFromPrevCloseAdr}×)`;
      }
    }
  }
  return null;
}

/** TF R-Factor on the last board at or before `minute`; null when none / not listed. */
function rAt(boards: TfBoardAt[], symbol: string, minute: number): number | null {
  for (let i = boards.length - 1; i >= 0; i--) {
    if (boards[i].minuteIST <= minute) return boards[i].rFactor.get(symbol) ?? null;
  }
  return null;
}

/** Is the money arriving faster or slower? Gain over the last 15 min vs the 15 before. */
export function rTrend(
  boards: TfBoardAt[],
  symbol: string,
  asOfMin: number,
  band = 0.02
): 'faster' | 'slower' | 'steady' | null {
  const now = rAt(boards, symbol, asOfMin);
  const m15 = rAt(boards, symbol, asOfMin - 15);
  const m30 = rAt(boards, symbol, asOfMin - 30);
  if (now == null || m15 == null || m30 == null) return null;
  const diff = now - m15 - (m15 - m30);
  return diff > band ? 'faster' : diff < -band ? 'slower' : 'steady';
}

/** First board minute of the CURRENT unbroken run of 30-min gains above `minDeltaR`. */
export function climbingSince(
  boards: TfBoardAt[],
  symbol: string,
  asOfMin: number,
  minDeltaR: number,
  lookbackMin = 30
): number | null {
  const upTo = boards.filter((b) => b.minuteIST <= asOfMin);
  let since: number | null = null;
  for (let i = upTo.length - 1; i >= 0; i--) {
    const r = upTo[i].rFactor.get(symbol);
    const ago = rAt(upTo, symbol, upTo[i].minuteIST - lookbackMin);
    if (r == null || ago == null || r - ago <= minDeltaR) break;
    since = upTo[i].minuteIST;
  }
  return since;
}

/** TF R-Factor at every board in [fromMin, asOfMin] — the card's sparkline. */
export function rPath(
  boards: TfBoardAt[],
  symbol: string,
  fromMin: number,
  asOfMin: number
): { minute: number; r: number }[] {
  const out: { minute: number; r: number }[] = [];
  for (const b of boards) {
    if (b.minuteIST < fromMin || b.minuteIST > asOfMin) continue;
    const r = b.rFactor.get(symbol);
    if (r != null) out.push({ minute: b.minuteIST, r });
  }
  return out;
}

export interface DroppedClimber {
  symbol: string;
  /** First and last board minute it was climbing inside the top N. */
  from: number;
  to: number;
  /** Where it is now; null = no longer on the board at all (left Intraday Boost). */
  rankNow: number | null;
  rNow: number | null;
  deltaRNow: number | null;
}

/** Names that climbed inside the top N earlier today but are off the top N now —
 *  kept visible (operator, 2026-10-08), most recent drop first. */
export function droppedClimbers(
  boards: TfBoardAt[],
  opts: {
    asOfMin: number;
    fromMin: number;
    topN: number;
    minDeltaR: number;
    lookbackMin?: number;
    onBoardNow: ReadonlySet<string>;
  }
): DroppedClimber[] {
  const lookback = opts.lookbackMin ?? 30;
  const inRange = boards.filter((b) => b.minuteIST >= opts.fromMin && b.minuteIST <= opts.asOfMin);
  const spans = new Map<string, { from: number; to: number }>();
  for (const b of inRange) {
    for (const [symbol, rank] of b.rank) {
      if (rank > opts.topN || opts.onBoardNow.has(symbol)) continue;
      const r = b.rFactor.get(symbol);
      const ago = rAt(boards, symbol, b.minuteIST - lookback);
      if (r == null || ago == null || r - ago <= opts.minDeltaR) continue;
      const span = spans.get(symbol);
      spans.set(symbol, span ? { from: span.from, to: b.minuteIST } : { from: b.minuteIST, to: b.minuteIST });
    }
  }
  const now = inRange.at(-1);
  return [...spans]
    .map(([symbol, s]) => {
      const rNow = now?.rFactor.get(symbol) ?? null;
      const ago = rAt(boards, symbol, opts.asOfMin - lookback);
      return {
        symbol,
        from: s.from,
        to: s.to,
        rankNow: now?.rank.get(symbol) ?? null,
        rNow,
        deltaRNow: rNow == null || ago == null ? null : rNow - ago,
      };
    })
    .sort((a, b) => b.to - a.to);
}

/** Broad baskets are not sectors. Compared upper-case: TF writes "NiFTY 50". */
const BROAD_BASKETS = new Set(['NIFTY 50', 'SENSEX', 'NIFTY MID SELECT', 'OTHERS']);

/** The stock's first industry basket (TF's order) that has a TF sector value. */
export function pickSector(
  baskets: string[],
  values: ReadonlyMap<string, number>
): { name: string; value: number } | null {
  for (const name of baskets) {
    if (BROAD_BASKETS.has(name.toUpperCase())) continue;
    const value = values.get(name);
    if (value != null) return { name, value };
  }
  return null;
}

/** The sectors proper: every TF index value except the broad baskets. */
export function realSectors(values: ReadonlyMap<string, number>): { name: string; value: number }[] {
  return [...values.entries()]
    .filter(([name]) => !BROAD_BASKETS.has(name.toUpperCase()))
    .map(([name, value]) => ({ name, value }));
}

/**
 * Sector strength — the 9th dot (operator, 2026-10-12): ADVISORY, NEVER a check. It is not in
 * GATE_ORDER, `allPass` ignores it, and the selector / auto-trader never read it, so a stock
 * climbs and is taken with or without it. It only says whether the stock's sector is moving
 * WITH the trade — up for a Call, down for a Put — and how strongly compared with the other
 * sectors (TF's own sector reading: a signed value, used here only for direction and rank,
 * never narrated as a %).
 */
export const SECTOR_TOP_N = 3;

export type SectorStrengthState =
  /** Moving the trade's way and among the top-N sectors doing so — the strong case. */
  | 'top'
  /** Moving the trade's way, but not among the top-N. */
  | 'with'
  /** Exactly flat. */
  | 'flat'
  /** Moving AGAINST the trade. */
  | 'against';

export interface SectorStrength {
  name: string;
  /** TF's own signed sector reading. */
  value: number;
  state: SectorStrengthState;
  /** 1-based rank among sectors moving the trade's way (strongest first); null when not moving our way. */
  rank: number | null;
  /** How many sectors move the trade's way. */
  of: number;
  topN: number;
}

/** Null when the stock has no sector reading — missing evidence, never a guess. */
export function sectorStrength(
  sector: { name: string; value: number } | null,
  all: readonly { name: string; value: number }[],
  side: 'CE' | 'PE',
  topN: number = SECTOR_TOP_N
): SectorStrength | null {
  if (sector == null || !Number.isFinite(sector.value)) return null;
  const sign = side === 'CE' ? 1 : -1;
  // Sectors moving the trade's way, strongest first (largest up-move for a Call, largest down-move for a Put).
  const ours = all.filter((s) => Number.isFinite(s.value) && s.value * sign > 0).sort((a, b) => b.value * sign - a.value * sign);
  const idx = ours.findIndex((s) => s.name === sector.name);
  const rank = idx < 0 ? null : idx + 1;
  const state: SectorStrengthState =
    sector.value === 0 ? 'flat' : sector.value * sign < 0 ? 'against' : rank != null && rank <= topN ? 'top' : 'with';
  return { name: sector.name, value: sector.value, state, rank, of: ours.length, topN };
}

/** The 9th dot's colour: green only for the strong case; hollow otherwise; grey = no reading. */
export const sectorDot = (s: SectorStrength | null): Gate => (s == null ? null : s.state === 'top');

/** Plain English for the 9th dot — never a % (the reading is TF's own unit). */
export function describeSector(s: SectorStrength | null, side: 'CE' | 'PE'): string {
  if (s == null) return 'no sector reading for this stock';
  const label = s.name.replace(/^NIFTY /i, '').replace(/^NiFTY /, '');
  const dir = side === 'CE' ? 'up' : 'down';
  const reading = `TF reading ${s.value >= 0 ? '+' : ''}${s.value}`;
  switch (s.state) {
    case 'top':
      return `${label} is #${s.rank} of ${s.of} sectors moving ${dir} (${reading}) — strong, with the trade`;
    case 'with':
      return `${label} is moving ${dir} (${reading}, #${s.rank} of ${s.of}) but is not among the top ${s.topN}`;
    case 'flat':
      return `${label} is flat (${reading}) — no sector direction`;
    case 'against':
      return `${label} is moving against this trade (${reading})`;
  }
}

export interface ClimberInterval {
  symbol: string;
  /** Board minute (IST) it entered TF Climbers: climbing inside the top N. */
  enteredAt: number;
  /** Board minute it left — out of the top N or no longer climbing. Null = still in at `asOfMin`. */
  exitedAt: number | null;
  /** Best (lowest) rank it held while in. */
  bestRank: number;
}

/**
 * When each name entered and left TF Climbers over a session — the Climbed
 * Stocks card and its day history (operator, 2026-10-08). "In" = inside the top
 * N with a 30-min R-Factor rise above `minDeltaR`, the same test the WATCH/TAKE
 * tiers use. A name can leave and come back: each run is its own interval.
 */
export function climberIntervals(
  boards: TfBoardAt[],
  opts: { fromMin: number; asOfMin: number; topN: number; minDeltaR: number; lookbackMin?: number }
): ClimberInterval[] {
  const lookback = opts.lookbackMin ?? 30;
  const done: ClimberInterval[] = [];
  const open = new Map<string, ClimberInterval>();
  for (const b of boards) {
    if (b.minuteIST < opts.fromMin || b.minuteIST > opts.asOfMin) continue;
    const inNow = new Set<string>();
    for (const [symbol, rank] of b.rank) {
      if (rank > opts.topN) continue;
      const r = b.rFactor.get(symbol);
      const ago = rAt(boards, symbol, b.minuteIST - lookback);
      if (r == null || ago == null || r - ago <= opts.minDeltaR) continue;
      inNow.add(symbol);
      const cur = open.get(symbol);
      if (cur) cur.bestRank = Math.min(cur.bestRank, rank);
      else open.set(symbol, { symbol, enteredAt: b.minuteIST, exitedAt: null, bestRank: rank });
    }
    for (const [symbol, cur] of open) {
      if (inNow.has(symbol)) continue;
      cur.exitedAt = b.minuteIST;
      done.push(cur);
      open.delete(symbol);
    }
  }
  return [...done, ...open.values()].sort((a, b) => a.enteredAt - b.enteredAt || a.bestRank - b.bestRank);
}

/** One stock on the Climbed Stocks card: every run it had, merged and steadied. */
export interface ClimbedStock {
  symbol: string;
  firstEnteredAt: number;
  /** Null = still in at `asOfMin` (or its last exit is not yet confirmed). */
  lastExitedAt: number | null;
  bestRank: number;
  runs: { enteredAt: number; exitedAt: number | null; bestRank: number }[];
}

/**
 * Steadies the raw per-capture intervals for DISPLAY (operator, 2026-10-09:
 * "same stock multiple entry exit — no quality"). On 2026-10-08 the raw test
 * logged 61 entries for 27 stocks: 12 re-entries came back within 10 minutes
 * (TATAELXSI out 12:56, back 12:57) and 7 runs lasted ≤ 5 minutes — one capture
 * dipping under the line, not money leaving. So:
 *  - an exit only counts once the name stays out `graceMin`: a return inside
 *    that merges into the same run, and a last exit younger than `graceMin` at
 *    `asOfMin` is not yet confirmed (shown as still in);
 *  - a closed run shorter than `minStayMin` is a blip and is dropped;
 *  - each stock appears ONCE, its runs listed inside.
 * Genuine pauses (JINDALSTEL out 37 minutes, then back) stay separate runs.
 * Display only: the selector and the cockpit tiers keep the raw test.
 */
export function climbedStocks(
  intervals: ClimberInterval[],
  opts: { asOfMin: number; graceMin: number; minStayMin: number }
): ClimbedStock[] {
  const bySymbol = new Map<string, ClimberInterval[]>();
  for (const iv of intervals) bySymbol.set(iv.symbol, [...(bySymbol.get(iv.symbol) ?? []), iv]);
  const out: ClimbedStock[] = [];
  for (const [symbol, list] of bySymbol) {
    const runs: ClimbedStock['runs'] = [];
    for (const iv of [...list].sort((a, b) => a.enteredAt - b.enteredAt)) {
      const prev = runs.at(-1);
      if (prev && prev.exitedAt != null && iv.enteredAt - prev.exitedAt <= opts.graceMin) {
        prev.exitedAt = iv.exitedAt;
        prev.bestRank = Math.min(prev.bestRank, iv.bestRank);
      } else {
        runs.push({ enteredAt: iv.enteredAt, exitedAt: iv.exitedAt, bestRank: iv.bestRank });
      }
    }
    const last = runs.at(-1);
    if (last && last.exitedAt != null && opts.asOfMin - last.exitedAt < opts.graceMin) last.exitedAt = null;
    const kept = runs.filter((r) => r.exitedAt == null || r.exitedAt - r.enteredAt >= opts.minStayMin);
    if (kept.length === 0) continue;
    out.push({
      symbol,
      firstEnteredAt: kept[0].enteredAt,
      lastExitedAt: kept.at(-1)!.exitedAt,
      bestRank: Math.min(...kept.map((r) => r.bestRank)),
      runs: kept,
    });
  }
  return out.sort((a, b) => a.firstEnteredAt - b.firstEnteredAt || a.bestRank - b.bestRank);
}
