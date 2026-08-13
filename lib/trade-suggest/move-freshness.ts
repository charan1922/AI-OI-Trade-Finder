/**
 * Move freshness — what the "App Since 9:45" column actually means for a trade.
 *
 * WHY THIS EXISTS
 * ---------------
 * `changePctOpen` (the day's move from the open) and `sinceEntryPct` (the move
 * since the 09:45 entry window opened, recorded in lib/signals/oi-intraday.ts)
 * answer completely different questions, and only the second one is about the
 * trade you are about to take:
 *
 *   +4.0% day / +3.8% since 09:45  →  the move is HAPPENING NOW. Tradeable.
 *   +4.0% day / +0.1% since 09:45  →  the whole move was the gap. You would be
 *                                     buying a stock that has done nothing for
 *                                     an hour. This is the gap-and-flat profile.
 *   +4.0% day / −0.9% since 09:45  →  it is GIVING BACK. Buying strength here
 *                                     means buying into distribution.
 *
 * The engine's `extended` flag collapses all three into "already moved ≥3%,
 * late to chase". That is right about the third case, wrong about the first,
 * and the setup-score reasons already hint at this split
 * (app/live/_lib/setup-score.ts) without anything downstream acting on it.
 *
 * This module makes the distinction explicit and DIRECTION-AWARE, so a bearish
 * pick that has fallen since 09:45 reads as fresh, not as a −% problem.
 *
 * HONEST LIMITS
 * -------------
 * - `sinceEntryPct` is null before 09:45 and null when no snapshot was recorded
 *   at/after 09:45 (a poller gap). Both return 'unknown' — never a guessed
 *   profile. 'unknown' must be treated as "no freshness evidence", not as good.
 * - The thresholds below are read off the shape of the data, not fitted to
 *   outcomes. `sinceEntryPct` was only persisted to the EOD table from
 *   2026-08-07, so there is no multi-day history to calibrate against yet.
 *   Treat them as provisional and re-derive once the history exists.
 *
 * PURE (no imports, no clock, no I/O) — driven identically by CI and replay.
 */

export type MoveProfile = 'fresh' | 'quiet' | 'spent' | 'fading' | 'unknown';

export interface MoveFreshness {
  profile: MoveProfile;
  /** Move since 09:45 IST, signed TOWARD the trade direction (%). */
  sinceEntryDirectional: number | null;
  /** Move from the open, signed TOWARD the trade direction (%). */
  dayDirectional: number | null;
  /** Share of the day's directional move made after 09:45, as a ratio. Null
   *  when the day's move is too small for the ratio to mean anything. */
  freshShare: number | null;
  detail: string;
}
export interface MoveFreshnessConfig {
  /** |move since 09:45| below this counts as "gone nowhere". */
  flatPct: number;
  /** Directional move since 09:45 at/above this is genuinely fresh. */
  freshPct: number;
  /** Move AGAINST the trade since 09:45 at/beyond this is fading. */
  fadePct: number;
  /** A day move at/above this makes a flat "since" reading a SPENT move rather
   *  than merely a quiet one. */
  spentDayPct: number;
  /** Below this |day move| the freshShare ratio is not reported. */
  minDayPctForShare: number;
}

export const DEFAULT_MOVE_FRESHNESS_CONFIG: MoveFreshnessConfig = {
  flatPct: 0.3,
  freshPct: 0.3,
  fadePct: 0.4,
  spentDayPct: 1.5,
  minDayPctForShare: 0.5,
};

const round2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * Classify how much of a candidate's move is still in front of it.
 *
 * `sinceEntryPct` and `changePctOpen` are the RAW signed percentages as the
 * live row carries them (positive = price up), exactly as stored; this function
 * does the direction flip for bearish trades.
 */
export function classifyMoveFreshness(
  input: {
    sinceEntryPct: number | null;
    changePctOpen: number | null;
    direction: 'bullish' | 'bearish';
  },
  cfg: MoveFreshnessConfig = DEFAULT_MOVE_FRESHNESS_CONFIG
): MoveFreshness {
  const sign = input.direction === 'bullish' ? 1 : -1;
  const since =
    input.sinceEntryPct == null || !Number.isFinite(input.sinceEntryPct)
      ? null
      : round2(input.sinceEntryPct * sign);
  const day =
    input.changePctOpen == null || !Number.isFinite(input.changePctOpen)
      ? null
      : round2(input.changePctOpen * sign);

  if (since == null) {
    return {
      profile: 'unknown',
      sinceEntryDirectional: null,
      dayDirectional: day,
      freshShare: null,
      detail: 'no 09:45 reference recorded — freshness unknown, treat it as missing evidence, not as clean',
    };
  }

  const freshShare =
    day != null && Math.abs(day) >= cfg.minDayPctForShare ? round2(since / day) : null;
  const shareText = freshShare == null ? '' : ` (${Math.round(freshShare * 100)}% of the day's move came after 09:45)`;
  const base = { sinceEntryDirectional: since, dayDirectional: day, freshShare };

  if (since <= -cfg.fadePct) {
    return {
      ...base,
      profile: 'fading',
      detail:
        `giving it back: ${since.toFixed(2)}% AGAINST the trade since 09:45` +
        (day == null ? '' : `, on a ${day >= 0 ? '+' : ''}${day.toFixed(2)}% day`) +
        ' — buying this is buying into the unwind',
    };
  }

  if (Math.abs(since) < cfg.flatPct) {
    if (day != null && day >= cfg.spentDayPct) {
      return {
        ...base,
        profile: 'spent',
        detail:
          `gap-and-flat: ${day.toFixed(2)}% on the day but only ${since >= 0 ? '+' : ''}${since.toFixed(2)}% since 09:45` +
          shareText +
          ' — the move happened before the entry window and has stalled since',
      };
    }
    return {
      ...base,
      profile: 'quiet',
      detail: `flat since 09:45 (${since >= 0 ? '+' : ''}${since.toFixed(2)}%) with no big day move behind it — nothing has started yet`,
    };
  }

  if (since >= cfg.freshPct) {
    return {
      ...base,
      profile: 'fresh',
      detail:
        `moving NOW: ${since >= 0 ? '+' : ''}${since.toFixed(2)}% since 09:45` +
        (day == null ? '' : `, ${day >= 0 ? '+' : ''}${day.toFixed(2)}% on the day`) +
        shareText,
    };
  }

  return {
    ...base,
    profile: 'quiet',
    detail: `only ${since >= 0 ? '+' : ''}${since.toFixed(2)}% since 09:45 — drifting, not driving`,
  };
}
