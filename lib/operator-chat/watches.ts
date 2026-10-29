/**
 * Commentary v2 watches — PURE (no DB, no network). A watch is a typed condition code can check
 * exactly; the AI or the operator starts one, the watch loop evaluates it, and a fired watch wakes
 * the chat AI for one turn. Anything that is not one of these kinds is refused — the AI must never
 * promise a watch the code cannot check.
 *
 * Missing or stale evidence never fires a watch (`fired: null` + the reason).
 */

export const WATCH_KINDS = [
  'price_cross',
  'position_r',
  'near_stop',
  'tf_top',
  'market_sideways',
  'board_stale',
  'time',
] as const;
export type WatchKind = (typeof WATCH_KINDS)[number];
export type WatchStatus = 'watching' | 'fired' | 'cancelled' | 'expired';

export interface WatchParams {
  symbol?: string;
  /** price_cross */
  level?: number;
  direction?: 'above' | 'below';
  /** position_r: fire at this many R in the trade's favour (negative = against). */
  r?: number;
  /** position_r: spot distance of 1R, frozen at creation (the stop trails later). */
  riskPts?: number;
  /** near_stop: fire when the spot is within this % of the stop. */
  withinPct?: number;
  /** tf_top */
  event?: 'joins' | 'leaves';
  /** market_sideways */
  to?: 'stuck' | 'not_stuck';
  /** time: HH:MM IST */
  at?: string;
}

/** Hard limits — enforced in code, not in the prompt. */
export const MAX_ACTIVE_WATCHES = 10;
export const WAKE_CAP_PER_DAY = 20;
export const WAKE_SPACING_MS = 5 * 60_000;
/** Every watch expires at the close, 15:30 IST. */
export const WATCH_EXPIRY_MIN = 15 * 60 + 30;
/** A price level further than this from the current price is refused as a likely typo. */
export const PRICE_BAND_PCT = 10;
export const DEFAULT_NEAR_STOP_PCT = 0.3;
/** The TF board must be live before 'stale' means anything (first captures land ~09:20). */
const BOARD_STALE_FROM_MIN = 9 * 60 + 30;

/** What one evaluation pass can see. Every field may be missing — missing never fires. */
export interface WatchInputs {
  nowMin: number;
  spot: ReadonlyMap<string, { price: number; fresh: boolean; ageMin: number } | null>;
  openTrades: ReadonlyMap<string, { direction: 'bullish' | 'bearish'; entrySpot: number; slSpot: number | null }>;
  tf: { available: boolean; ageMinutes: number | null; maxAgeMin: number; maxRank: number; ranks: ReadonlyMap<string, number> } | null;
  sideways: { stuck: boolean | null; reason: string } | null;
}

export interface WatchVerdict {
  /** true = fired now; false = checked, not yet; null = could not check (with the reason). */
  fired: boolean | null;
  note: string;
  /** The watch can never fire again (e.g. its position closed) — close it as expired. */
  dead?: boolean;
}

const fmt = (n: number) => (Math.abs(n) >= 100 ? n.toFixed(1) : n.toFixed(2));

export function parseHHMM(s: string | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((s ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

export function describeWatch(kind: WatchKind, p: WatchParams): string {
  switch (kind) {
    case 'price_cross':
      return `${p.symbol} ${p.direction === 'below' ? 'falls below' : 'rises above'} ${p.level}`;
    case 'position_r':
      return `${p.symbol} position reaches ${p.r! >= 0 ? '+' : ''}${p.r}R`;
    case 'near_stop':
      return `${p.symbol} within ${p.withinPct ?? DEFAULT_NEAR_STOP_PCT}% of its stop`;
    case 'tf_top':
      return `${p.symbol} ${p.event === 'leaves' ? 'leaves' : 'joins'} the TF top list`;
    case 'market_sideways':
      return p.to === 'not_stuck' ? 'market stops being sideways' : 'market turns sideways';
    case 'board_stale':
      return 'TF board goes stale';
    case 'time':
      return `reminder at ${p.at} IST`;
  }
}

/** How often the panel should say this kind can change — honest, not aspirational. */
export function cadenceOf(kind: WatchKind): string {
  if (kind === 'time') return 'checked every 60s';
  if (kind === 'tf_top' || kind === 'board_stale') return 'checked every 60s · TF board updates ~5 min';
  if (kind === 'market_sideways') return 'checked every 60s · candles update every 5 min';
  return 'checked every 60s · price updates every 5 min';
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * Validate a request against what the code can see NOW. Returns the normalised params + label, or a
 * plain-English refusal the AI (or the page) shows as-is.
 */
export function validateWatch(
  kindRaw: unknown,
  raw: Record<string, unknown>,
  inputs: WatchInputs
): { ok: true; kind: WatchKind; params: WatchParams; label: string } | { ok: false; error: string } {
  const kind = WATCH_KINDS.find((k) => k === kindRaw);
  if (!kind) {
    return {
      ok: false,
      error: `Not a watch I can check. Kinds: ${WATCH_KINDS.join(', ')}. Anything else needs a code change.`,
    };
  }
  const symbol = typeof raw.symbol === 'string' ? raw.symbol.trim().toUpperCase() : '';
  const params: WatchParams = {};
  if (inputs.nowMin >= WATCH_EXPIRY_MIN) return { ok: false, error: 'The market has closed — watches run until 15:30 IST.' };

  switch (kind) {
    case 'price_cross': {
      const level = num(raw.level);
      const direction = raw.direction === 'below' ? 'below' : raw.direction === 'above' ? 'above' : null;
      if (!symbol || level == null || level <= 0 || !direction) {
        return { ok: false, error: 'price_cross needs symbol, level and direction (above|below).' };
      }
      const s = inputs.spot.get(symbol);
      if (!s || !s.fresh) return { ok: false, error: `No fresh price for ${symbol} (not recorded by the poller, or stale) — can't watch it.` };
      if (Math.abs(level - s.price) / s.price > PRICE_BAND_PCT / 100) {
        return { ok: false, error: `${level} is more than ${PRICE_BAND_PCT}% from ${symbol}'s price ${fmt(s.price)} — check the level.` };
      }
      if (direction === 'above' ? s.price >= level : s.price <= level) {
        return { ok: false, error: `${symbol} is already ${direction} ${level} (now ${fmt(s.price)}).` };
      }
      Object.assign(params, { symbol, level, direction });
      break;
    }
    case 'position_r':
    case 'near_stop': {
      const t = symbol ? inputs.openTrades.get(symbol) : undefined;
      if (!t) return { ok: false, error: `No open position in ${symbol || '(no symbol)'} — this watch needs one.` };
      if (t.slSpot == null) return { ok: false, error: `${symbol}'s position has no spot stop to measure from.` };
      if (kind === 'position_r') {
        const r = num(raw.r);
        const riskPts = Math.abs(t.entrySpot - t.slSpot);
        if (r == null || r === 0 || Math.abs(r) > 10) return { ok: false, error: 'position_r needs r (e.g. 1 or -0.5), not 0, at most ±10.' };
        if (!(riskPts > 0)) return { ok: false, error: `${symbol}'s stop sits at its entry — 1R is undefined.` };
        Object.assign(params, { symbol, r, riskPts });
      } else {
        const withinPct = num(raw.withinPct) ?? DEFAULT_NEAR_STOP_PCT;
        if (withinPct <= 0 || withinPct > 3) return { ok: false, error: 'withinPct must be above 0 and at most 3.' };
        Object.assign(params, { symbol, withinPct });
      }
      break;
    }
    case 'tf_top': {
      const event = raw.event === 'leaves' ? 'leaves' : raw.event === 'joins' ? 'joins' : null;
      if (!symbol || !event) return { ok: false, error: 'tf_top needs symbol and event (joins|leaves).' };
      const tf = inputs.tf;
      if (!tf?.available || tf.ageMinutes == null || tf.ageMinutes > tf.maxAgeMin) {
        return { ok: false, error: 'The TF board is not fresh right now — a TF watch would only guess.' };
      }
      const inTop = (tf.ranks.get(symbol) ?? Infinity) <= tf.maxRank;
      if (event === 'joins' && inTop) return { ok: false, error: `${symbol} is already in TF's top ${tf.maxRank}.` };
      if (event === 'leaves' && !inTop) return { ok: false, error: `${symbol} is not in TF's top ${tf.maxRank} now.` };
      Object.assign(params, { symbol, event });
      break;
    }
    case 'market_sideways': {
      const to = raw.to === 'not_stuck' ? 'not_stuck' : raw.to === 'stuck' ? 'stuck' : null;
      if (!to) return { ok: false, error: 'market_sideways needs to (stuck|not_stuck).' };
      params.to = to;
      break;
    }
    case 'board_stale':
      break;
    case 'time': {
      const at = typeof raw.at === 'string' ? raw.at.trim() : '';
      const m = parseHHMM(at);
      if (m == null) return { ok: false, error: 'time needs at as HH:MM (IST).' };
      if (m <= inputs.nowMin) return { ok: false, error: `${at} IST has already passed.` };
      if (m >= WATCH_EXPIRY_MIN) return { ok: false, error: 'Reminders must be before 15:30 IST.' };
      params.at = at.padStart(5, '0');
      break;
    }
  }
  const custom = typeof raw.label === 'string' ? raw.label.trim().slice(0, 80) : '';
  return { ok: true, kind, params, label: custom || describeWatch(kind, params) };
}

/** One check of one watch. Pure — the loop decides what to do with the verdict. */
export function evaluateWatch(kind: WatchKind, p: WatchParams, inputs: WatchInputs): WatchVerdict {
  switch (kind) {
    case 'time': {
      const at = parseHHMM(p.at);
      if (at == null) return { fired: null, note: 'bad time', dead: true };
      return inputs.nowMin >= at ? { fired: true, note: `it is ${p.at} IST` } : { fired: false, note: `waiting for ${p.at}` };
    }
    case 'price_cross': {
      const s = inputs.spot.get(p.symbol ?? '');
      if (!s) return { fired: null, note: `no price recorded for ${p.symbol}` };
      if (!s.fresh) return { fired: null, note: `price is ${Math.round(s.ageMin)} min old — not checked on stale data` };
      const hit = p.direction === 'below' ? s.price <= p.level! : s.price >= p.level!;
      return { fired: hit, note: `${p.symbol} ${fmt(s.price)} vs ${p.level}` };
    }
    case 'position_r':
    case 'near_stop': {
      const t = inputs.openTrades.get(p.symbol ?? '');
      if (!t) return { fired: null, note: `${p.symbol} position is no longer open`, dead: true };
      const s = inputs.spot.get(p.symbol ?? '');
      if (!s) return { fired: null, note: `no price recorded for ${p.symbol}` };
      if (!s.fresh) return { fired: null, note: `price is ${Math.round(s.ageMin)} min old — not checked on stale data` };
      const dir = t.direction === 'bearish' ? -1 : 1;
      if (kind === 'position_r') {
        const r = (dir * (s.price - t.entrySpot)) / p.riskPts!;
        const hit = p.r! > 0 ? r >= p.r! : r <= p.r!;
        return { fired: hit, note: `${p.symbol} at ${r >= 0 ? '+' : ''}${r.toFixed(2)}R (spot ${fmt(s.price)})` };
      }
      if (t.slSpot == null) return { fired: null, note: `${p.symbol} has no spot stop` };
      const distPct = ((dir * (s.price - t.slSpot)) / s.price) * 100;
      return {
        fired: distPct <= p.withinPct!,
        note: `${p.symbol} spot ${fmt(s.price)} is ${distPct.toFixed(2)}% from stop ${fmt(t.slSpot)}`,
      };
    }
    case 'tf_top': {
      const tf = inputs.tf;
      if (!tf?.available || tf.ageMinutes == null) return { fired: null, note: 'no TF board' };
      if (tf.ageMinutes > tf.maxAgeMin) return { fired: null, note: `TF board is ${tf.ageMinutes} min old — not checked` };
      const rank = tf.ranks.get(p.symbol ?? '');
      const inTop = rank != null && rank <= tf.maxRank;
      const where = rank == null ? 'not on the board' : `#${rank}`;
      return { fired: p.event === 'leaves' ? !inTop : inTop, note: `${p.symbol} ${where} (top ${tf.maxRank})` };
    }
    case 'market_sideways': {
      const sw = inputs.sideways;
      if (!sw || sw.stuck == null) return { fired: null, note: sw?.reason ?? 'sideways check unavailable' };
      return { fired: p.to === 'not_stuck' ? !sw.stuck : sw.stuck, note: sw.reason };
    }
    case 'board_stale': {
      if (inputs.nowMin < BOARD_STALE_FROM_MIN) return { fired: false, note: 'board not expected before 09:30' };
      const tf = inputs.tf;
      if (!tf?.available || tf.ageMinutes == null) return { fired: true, note: 'no TF board captured today' };
      return {
        fired: tf.ageMinutes > tf.maxAgeMin,
        note: `TF board is ${tf.ageMinutes} min old (limit ${tf.maxAgeMin})`,
      };
    }
  }
}

/** Kinds whose inputs need the (cached, 5-min-bucketed) market-wide sideways read. */
export const needsSideways = (kinds: readonly WatchKind[]) => kinds.includes('market_sideways');

/**
 * May the AI be woken now? Counts every wake-up that called the model ('ai' and 'fallback');
 * 'capped' notes cost nothing. Pure.
 */
export function wakeBudget(
  wakeups: readonly { at: string; outcome: 'ai' | 'fallback' | 'capped' }[],
  nowMs: number
): { allowed: boolean; used: number; reason: string | null; nextAtMs: number | null } {
  const called = wakeups.filter((w) => w.outcome !== 'capped');
  const used = called.length;
  if (used >= WAKE_CAP_PER_DAY) return { allowed: false, used, reason: `daily cap of ${WAKE_CAP_PER_DAY} reached`, nextAtMs: null };
  const last = called.reduce((m, w) => Math.max(m, new Date(w.at).getTime() || 0), 0);
  if (last > 0 && nowMs - last < WAKE_SPACING_MS) {
    return { allowed: false, used, reason: 'spacing', nextAtMs: last + WAKE_SPACING_MS };
  }
  return { allowed: true, used, reason: null, nextAtMs: null };
}
