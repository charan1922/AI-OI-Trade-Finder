/**
 * Order-block detector — OUR documented rule set (OB_ALGORITHM_VERSION), not a
 * reconstruction of any vendor's proprietary algorithm, and not proof of any
 * institutional order. An order block here is an algorithmically inferred
 * price zone: the last opposite-colour 5-min candle before a strong candle
 * CLOSES through a confirmed swing level.
 *
 * Spec: docs/superpowers/specs/2026-11-19-order-blocks-design.md (from the
 * operator's handoff README/CLAUDE.md). Pure: no I/O, no clock, no randomness.
 * CI-checked by scripts/order-block-checks.ts.
 *
 * Causality is the whole point:
 *   - only COMPLETED bars, processed in strictly increasing endMs order;
 *   - a swing pivot is known only after `right` more bars have closed;
 *   - BOS at bar i uses only pivots known by the close of bar i-1, and the
 *     displacement test uses ATR[i-1] (never the impulse bar's own ATR);
 *   - a zone exists only from its confirming (BOS) bar's endMs — drawing it
 *     from the origin candle is visual context, never an earlier signal.
 * One streaming core (processClosedBar) also backs batch replay, so offline
 * and live outputs are identical by construction (parity is CI-checked).
 */

export const OB_ALGORITHM_VERSION = 'ob-v1.0-single-candle';

export interface ObBar {
  /** UTC epoch ms, inclusive. */
  startMs: number;
  /** UTC epoch ms, exclusive — the bar is complete at this instant. */
  endMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Underlying shares traded (never option OI). */
  volume: number;
}

export interface ObConfig {
  left: number;
  right: number;
  atrPeriod: number;
  /** body / range of the BOS candle. A hypothesis to backtest, not a proven edge. */
  minBodyRatio: number;
  /** body / ATR[i-1] of the BOS candle. A hypothesis to backtest, not a proven edge. */
  minBodyAtr: number;
  /** Candles before the BOS bar searched for the opposing origin candle. */
  originLookback: number;
  /**
   * Price resolution for comparisons, in rupees. ₹0.01 (one paisa) — the finest unit any
   * NSE price is quoted in, so it never merges two distinct prices. Not the exchange tick:
   * per-stock ticks are not in our master data, and an assumed coarser tick could make two
   * different highs compare equal (a false "tie" that would block a real pivot).
   */
  tickSize: number;
  /** Close must go this many ticks past the far edge to invalidate (0 = any close beyond). */
  invalidationToleranceTicks: number;
  /** Session policy: zones expire at the end of their IST session; ATR and pivots carry over. */
  expireAtSessionEnd: boolean;
  /**
   * Session policy: the origin candle must be in the BOS bar's IST session. Without it,
   * a strong first bar after an overnight gap picked yesterday's afternoon candle as its
   * origin (ALKEM 2026-11-09: confirmed 09:20 from an origin at 10:25 the day before).
   */
  originSameSession: boolean;
}

export const OB_DEFAULT_CONFIG: ObConfig = {
  left: 3,
  right: 3,
  atrPeriod: 14,
  minBodyRatio: 0.6,
  minBodyAtr: 1.5,
  originLookback: 8,
  tickSize: 0.01,
  invalidationToleranceTicks: 0,
  expireAtSessionEnd: true,
  originSameSession: true,
};

export type ObSide = 'bullish' | 'bearish';
export type ObState = 'confirmed_active' | 'retested' | 'invalidated' | 'expired';

export interface ObPivot {
  kind: 'high' | 'low';
  barIndex: number;
  price: number;
  /** Close of bar barIndex + right — the earliest moment this pivot is knowable. */
  knownAtMs: number;
  used: boolean;
}

export interface OrderBlock {
  id: string;
  symbol: string;
  side: ObSide;
  zoneLow: number;
  zoneHigh: number;
  originBarIndex: number;
  originStartMs: number;
  originEndMs: number;
  /** The BOS candle. */
  confirmedBarIndex: number;
  /** BOS candle endMs — the zone does not exist before this instant. */
  confirmedAtMs: number;
  brokenPivotPrice: number;
  brokenPivotBarIndex: number;
  brokenPivotKnownAtMs: number;
  /** BOS candle body / range. */
  bodyRatio: number;
  /** BOS candle body / ATR of the bar before it. */
  bodyAtrRatio: number;
  priorAtr: number;
  /** Diagnostic: bars strictly between origin and BOS whose range overlapped the zone. */
  preconfirmationOverlapBars: number;
  algorithmVersion: string;
  state: ObState;
  firstRetestAtMs: number | null;
  invalidatedAtMs: number | null;
  expiredAtMs: number | null;
  source: string;
}

export type ObEventType = 'pivot_confirmed' | 'bos_no_origin' | 'ob_confirmed' | 'ob_retested' | 'ob_invalidated' | 'ob_expired';

export interface ObEvent {
  type: ObEventType;
  atMs: number;
  barIndex: number;
  obId?: string;
  detail?: string;
}

export interface ObEngineState {
  readonly config: ObConfig;
  readonly symbol: string;
  readonly source: string;
  bars: ObBar[];
  /** ATR as of each bar's close (null until seeded). */
  atr: (number | null)[];
  seedTrs: number[];
  highs: ObPivot[];
  lows: ObPivot[];
  blocks: OrderBlock[];
  events: ObEvent[];
  sessionDate: string | null;
}

const IST_OFFSET_MS = 19_800_000;

export function istSessionDate(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Why a bar is unusable, or null when it is a valid completed candle. */
export function invalidBarReason(b: ObBar): string | null {
  const nums = [b.startMs, b.endMs, b.open, b.high, b.low, b.close, b.volume];
  if (!nums.every(Number.isFinite)) return 'non-finite field';
  if (b.endMs <= b.startMs) return 'endMs not after startMs';
  if (b.low <= 0) return 'non-positive price';
  if (b.low > Math.min(b.open, b.close) || b.high < Math.max(b.open, b.close)) return 'OHLC out of order';
  if (b.volume < 0) return 'negative volume';
  return null;
}

export function createObEngine(symbol: string, source: string, config: ObConfig = OB_DEFAULT_CONFIG): ObEngineState {
  const intOk = (n: number) => Number.isInteger(n) && n >= 1;
  if (
    !intOk(config.left) ||
    !intOk(config.right) ||
    !intOk(config.atrPeriod) ||
    !intOk(config.originLookback) ||
    !(config.minBodyRatio >= 0 && config.minBodyRatio <= 1) ||
    !(config.minBodyAtr >= 0) ||
    !(config.tickSize > 0) ||
    !(Number.isInteger(config.invalidationToleranceTicks) && config.invalidationToleranceTicks >= 0)
  ) {
    throw new Error('Invalid order-block configuration');
  }
  return { config, symbol, source, bars: [], atr: [], seedTrs: [], highs: [], lows: [], blocks: [], events: [], sessionDate: null };
}

/**
 * Feed ONE completed bar. Returns the events that became knowable at its
 * close. A bar identical to the last processed one is a duplicate delivery
 * and is ignored (idempotent); any other bar that is not strictly later throws
 * (out-of-order data / an unrevisioned correction must never be absorbed silently).
 */
export function processClosedBar(s: ObEngineState, bar: ObBar): ObEvent[] {
  const bad = invalidBarReason(bar);
  if (bad) throw new Error(`Invalid bar at ${bar.startMs}: ${bad}`);
  const last = s.bars.at(-1);
  if (last && bar.endMs <= last.endMs) {
    const same =
      bar.endMs === last.endMs &&
      bar.startMs === last.startMs &&
      bar.open === last.open &&
      bar.high === last.high &&
      bar.low === last.low &&
      bar.close === last.close &&
      bar.volume === last.volume;
    if (same) return [];
    throw new Error(`Bar out of order or revised at ${bar.startMs} (last processed endMs ${last.endMs})`);
  }

  const c = s.config;
  const tick = (p: number) => Math.round(p / c.tickSize);
  const out: ObEvent[] = [];
  const emit = (e: ObEvent) => {
    out.push(e);
    s.events.push(e);
  };

  // Session boundary: expire the previous session's live zones at its last close.
  const session = istSessionDate(bar.startMs);
  if (c.expireAtSessionEnd && s.sessionDate !== null && session !== s.sessionDate && last) {
    for (const ob of s.blocks) {
      if (ob.state === 'confirmed_active' || ob.state === 'retested') {
        ob.state = 'expired';
        ob.expiredAtMs = last.endMs;
        emit({ type: 'ob_expired', atMs: last.endMs, barIndex: s.bars.length - 1, obId: ob.id, detail: 'session end' });
      }
    }
  }
  s.sessionDate = session;

  const i = s.bars.length;
  s.bars.push(bar);
  const b = s.bars;

  // ── Wilder ATR: seed = mean of the first atrPeriod TRs (bar 0 has no prior
  //    close, so it has no TR), then RMA. ATR[i] includes TR[i].
  let atrNow: number | null = s.atr[i - 1] ?? null;
  if (i > 0) {
    const prev = b[i - 1].close;
    const tr = Math.max(bar.high - bar.low, Math.abs(bar.high - prev), Math.abs(bar.low - prev));
    if (atrNow === null) {
      s.seedTrs.push(tr);
      if (s.seedTrs.length === c.atrPeriod) atrNow = s.seedTrs.reduce((a, v) => a + v, 0) / c.atrPeriod;
    } else {
      atrNow = (atrNow * (c.atrPeriod - 1) + tr) / c.atrPeriod;
    }
  }
  s.atr[i] = atrNow;

  // ── Lifecycle of zones confirmed on EARLIER bars. Retest first, then
  //    invalidation, so a bar that does both emits both (final: invalidated).
  const hiT = tick(bar.high);
  const loT = tick(bar.low);
  const clT = tick(bar.close);
  for (const ob of s.blocks) {
    if (ob.confirmedBarIndex >= i || (ob.state !== 'confirmed_active' && ob.state !== 'retested')) continue;
    const zLo = tick(ob.zoneLow);
    const zHi = tick(ob.zoneHigh);
    if (ob.state === 'confirmed_active' && hiT >= zLo && loT <= zHi) {
      ob.state = 'retested';
      ob.firstRetestAtMs = bar.endMs;
      emit({ type: 'ob_retested', atMs: bar.endMs, barIndex: i, obId: ob.id });
    }
    const tol = c.invalidationToleranceTicks;
    const broken = ob.side === 'bullish' ? clT < zLo - tol : clT > zHi + tol;
    if (broken) {
      ob.state = 'invalidated';
      ob.invalidatedAtMs = bar.endMs;
      emit({ type: 'ob_invalidated', atMs: bar.endMs, barIndex: i, obId: ob.id, detail: 'close beyond far edge' });
    }
  }

  // ── Break of structure on this bar, using pivots known by the close of i-1.
  if (i > 0) {
    const priorAtr = s.atr[i - 1];
    const body = Math.abs(bar.close - bar.open);
    const range = bar.high - bar.low;
    const bodyRatio = range > 0 ? body / range : 0;
    const strong = priorAtr !== null && priorAtr > 0 && bodyRatio >= c.minBodyRatio && body / priorAtr >= c.minBodyAtr;
    const opT = tick(bar.open);
    const prevClT = tick(b[i - 1].close);
    if (strong && priorAtr !== null) {
      const latestUnused = (list: ObPivot[]) => {
        for (let k = list.length - 1; k >= 0; k--) if (!list[k].used) return list[k];
        return null;
      };
      const sh = latestUnused(s.highs);
      const sl = latestUnused(s.lows);
      const up = clT > opT && sh !== null && prevClT <= tick(sh.price) && clT > tick(sh.price);
      const down = clT < opT && sl !== null && prevClT >= tick(sl.price) && clT < tick(sl.price);
      if (up || down) {
        const side: ObSide = up ? 'bullish' : 'bearish';
        const pivot = (up ? sh : sl) as ObPivot;
        pivot.used = true; // consumed at the first qualifying BOS, origin or not
        let origin = -1;
        for (let j = i - 1; j >= Math.max(0, i - c.originLookback); j--) {
          if (c.originSameSession && istSessionDate(b[j].startMs) !== session) break;
          const o = tick(b[j].open);
          const cl = tick(b[j].close);
          if (up ? cl < o : cl > o) {
            origin = j;
            break;
          }
        }
        if (origin >= 0 && tick(b[origin].high) > tick(b[origin].low)) {
          const zoneLow = b[origin].low;
          const zoneHigh = b[origin].high;
          let overlap = 0;
          for (let k = origin + 1; k < i; k++) {
            if (tick(b[k].high) >= tick(zoneLow) && tick(b[k].low) <= tick(zoneHigh)) overlap++;
          }
          const ob: OrderBlock = {
            id: `${s.symbol}:${side}:${b[origin].startMs}:${bar.endMs}`,
            symbol: s.symbol,
            side,
            zoneLow,
            zoneHigh,
            originBarIndex: origin,
            originStartMs: b[origin].startMs,
            originEndMs: b[origin].endMs,
            confirmedBarIndex: i,
            confirmedAtMs: bar.endMs,
            brokenPivotPrice: pivot.price,
            brokenPivotBarIndex: pivot.barIndex,
            brokenPivotKnownAtMs: pivot.knownAtMs,
            bodyRatio,
            bodyAtrRatio: body / priorAtr,
            priorAtr,
            preconfirmationOverlapBars: overlap,
            algorithmVersion: OB_ALGORITHM_VERSION,
            state: 'confirmed_active',
            firstRetestAtMs: null,
            invalidatedAtMs: null,
            expiredAtMs: null,
            source: s.source,
          };
          s.blocks.push(ob);
          emit({ type: 'ob_confirmed', atMs: bar.endMs, barIndex: i, obId: ob.id });
        } else {
          emit({
            type: 'bos_no_origin',
            atMs: bar.endMs,
            barIndex: i,
            detail: `${side} BOS through ${pivot.price}: no opposing candle in the ${c.originLookback} bars before it`,
          });
        }
      }
    }
  }

  // ── Confirm the pivot whose right side just completed (strict: ties reject).
  const p = i - c.right;
  if (p >= c.left) {
    const cand = b[p];
    let isHigh = true;
    let isLow = true;
    for (let j = p - c.left; j <= p + c.right; j++) {
      if (j === p) continue;
      if (tick(cand.high) <= tick(b[j].high)) isHigh = false;
      if (tick(cand.low) >= tick(b[j].low)) isLow = false;
    }
    if (isHigh) {
      s.highs.push({ kind: 'high', barIndex: p, price: cand.high, knownAtMs: bar.endMs, used: false });
      emit({ type: 'pivot_confirmed', atMs: bar.endMs, barIndex: p, detail: `swing high ${cand.high}` });
    }
    if (isLow) {
      s.lows.push({ kind: 'low', barIndex: p, price: cand.low, knownAtMs: bar.endMs, used: false });
      emit({ type: 'pivot_confirmed', atMs: bar.endMs, barIndex: p, detail: `swing low ${cand.low}` });
    }
  }

  return out;
}

/** Batch replay — the SAME core, bar by bar. */
export function replayOrderBlocks(
  symbol: string,
  source: string,
  bars: readonly ObBar[],
  config: ObConfig = OB_DEFAULT_CONFIG
): ObEngineState {
  const s = createObEngine(symbol, source, config);
  for (const bar of bars) processClosedBar(s, bar);
  return s;
}
