/**
 * TradeFinder-style breakout detection — shared shapes.
 *
 * The strategy (Pro Trader Aakash, "breakout secrets" video, ingested in the
 * R-Obsidian vault 2026-07-06) confirms a breakout with three checks:
 *   1. Morning test — the first ~15 min low is NEVER broken all day (smart
 *      money absorbing every dip). Broken early = the TCS fakeout profile.
 *   2. Capital efficiency — R-Factor high (institutions moving price without
 *      burning capital). Already computed live; consumed here as an input.
 *   3. Multi-level aggression — the surge clears SEVERAL named resistances at
 *      once (morning/OR high, prev-day high, multi-day base, swing highs).
 *
 * Split into a SLOW context (derived from 5-min bars + EOD baselines, cached
 * ~5 min) and a FAST evaluation (live LTP vs the cached context, every poll).
 * Everything here is pure data — no imports from app/ or DB code.
 */

/** One named price level a breakout can clear. */
export interface BreakoutLevel {
  /** Human label, e.g. "OR high", "prev-day high", "5d high", "swing high". */
  name: string;
  kind: 'open-range' | 'prev-day' | 'multi-day' | 'swing';
  price: number;
}

/** Check 1 state — derived from today's completed 5-min bars (sticky for the day). */
export interface MorningTestState {
  /** True once a bar at/after the morning window's end has been seen. */
  complete: boolean;
  /** Low/high of the first MORNING_WINDOW_MIN minutes (null before any bars). */
  morningLow: number | null;
  morningHigh: number | null;
  /** Did any later bar trade below the morning low / above the morning high?
   *  Sticky: once broken, broken for the day (the fakeout invalidation rule). */
  lowBroken: boolean;
  highBroken: boolean;
  /** IST minute-of-day when the break happened (diagnostics), null if held. */
  lowBrokenAtMin: number | null;
  highBrokenAtMin: number | null;
}

/** Slow, bar-derived context — cached per symbol, refreshed on the 5-min grid. */
export interface BreakoutContext {
  morning: MorningTestState;
  /** Levels above the open zone a bullish surge can clear, ascending by price. */
  resistances: BreakoutLevel[];
  /** Levels below, descending by price — the bearish mirror. */
  supports: BreakoutLevel[];
  /** How many bars fed the derivation (0 = context not usable yet). */
  barsUsed: number;
  /** Morning-break tolerance (%) the context was derived with — the fast path
   *  applies the same slack to live-tick break checks. */
  breakTolerancePct: number;
}

export type BreakoutGrade = 'strong' | 'confirmed' | 'watch' | 'fakeout-risk' | 'none';

/** Fast, per-poll verdict — live LTP evaluated against the cached context. */
export interface BreakoutSignal {
  /** Side the verdict reads. Null when nothing is happening either way. */
  direction: 'bullish' | 'bearish' | null;
  /**
   * strong        — morning test held + ≥2 levels cleared + R-Factor efficient
   * confirmed     — morning test held + ≥1 level cleared
   * watch         — morning test held, no level cleared yet (base intact)
   * fakeout-risk  — clearing levels BUT the morning test broke earlier (TCS profile)
   * none          — nothing qualifying (or morning window still pending)
   */
  grade: BreakoutGrade;
  /** Check-1 verdict for the signal's direction. */
  morningTest: 'held' | 'broken' | 'pending';
  /** Check-3: how many named levels the current price has cleared. */
  levelsCleared: number;
  clearedNames: string[];
  /** Nearest uncleared level in the trade direction (what to watch next). */
  nextLevel: { name: string; price: number } | null;
  /** One-line human explanation for tooltips / AI prompts. */
  detail: string;
}
