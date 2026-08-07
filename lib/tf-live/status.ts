/**
 * Turns raw TradeFinder plumbing state into ONE honest health verdict for /tf.
 *
 * WHY: the page used to render `session.lastError` verbatim, so the operator saw
 *
 *     TradeFinder rejected it (AT_ERROR: INVALID TOKEN)
 *
 * which reads as "everything is broken and your token is dead". Both halves of
 * that were usually wrong. On 2026-08-07 that banner appeared SECONDS after a
 * capture that had just stored 210 stocks, and the token in question had three
 * hours left — the real cause was request bursting (see lib/tf-live/client.ts),
 * which resolves itself on the next tick.
 *
 * The distinction that actually matters to a human is: DO I NEED TO DO
 * SOMETHING? So this collapses everything into three levels:
 *
 *   error   — captures cannot recover on their own. Paste a fresh pair. (Only
 *             a missing or genuinely expired token qualifies.)
 *   warning — a tick failed but the system heals itself. Nothing to do.
 *   ok      — feeds are landing.
 *
 * PURE (no imports, no clock of its own — `nowMs` is passed in) so the exact
 * wording and, more importantly, the "is this actionable?" decision can be
 * pinned in CI. A status line that cries wolf is worse than no status line:
 * the one time it means "paste a token", it has to be believed.
 */

export type TfHealthLevel = 'ok' | 'warning' | 'error';

export interface TfHealth {
  level: TfHealthLevel;
  /** Short line for the badge. */
  headline: string;
  /** One plain-English sentence explaining the state. */
  detail: string;
  /** Present only when the operator must act. Null means "nothing to do". */
  action: string | null;
}

export interface TfHealthInput {
  configured: boolean;
  /** The lt JWT's own expiry, ISO. Null when unknown. */
  jwtExpiresAt: string | null;
  /** Session-level error from the most recent tick. Null after a clean tick. */
  lastError: string | null;
  /** Most recent SUCCESSFUL capture of any feed, ISO. Null if none ever. */
  lastSuccessAt: string | null;
  /** Successful and total capture attempts today, across all feeds. */
  successesToday: number;
  attemptsToday: number;
  nowMs: number;
}

/** "3 minutes ago" / "2 hours ago" — small and dependency-free. */
export function humanAgo(iso: string | null, nowMs: number): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  const mins = Math.floor((nowMs - then) / 60_000);
  if (mins < 1) return 'just now';
  if (mins === 1) return '1 minute ago';
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.floor(mins / 60);
  return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
}

/**
 * True when an error string describes something that heals by itself. These are
 * the throttle/transport failures — NOT a dead credential.
 *
 * Note the deliberate asymmetry: TradeFinder answers a throttled burst with the
 * SAME `AT_ERROR: INVALID TOKEN` it uses for a genuinely bad token, so the code
 * alone cannot tell them apart. The lt JWT's own expiry can, and it is checked
 * first — so an AT_ERROR arriving while the JWT is still valid is treated as
 * transient, which is what the evidence says it almost always is.
 */
export function isTransientTfError(error: string): boolean {
  const e = error.toLowerCase();
  return (
    e.includes('at_error') ||
    e.includes('rejected') ||
    e.includes('timed out') ||
    e.includes('network') ||
    e.includes('http 5') ||
    e.includes('feeds failed')
  );
}

export function summarizeTfHealth(input: TfHealthInput): TfHealth {
  const { nowMs } = input;

  if (!input.configured) {
    return {
      level: 'error',
      headline: 'Not connected',
      detail: 'No TradeFinder session is stored, so nothing is being captured.',
      action: 'Paste an lt/at pair from a signed-in TradeFinder tab.',
    };
  }

  // A genuinely expired JWT is the ONE state that cannot recover on its own.
  const expiresMs = input.jwtExpiresAt ? new Date(input.jwtExpiresAt).getTime() : null;
  if (expiresMs != null && Number.isFinite(expiresMs) && expiresMs <= nowMs) {
    return {
      level: 'error',
      headline: 'Session expired',
      detail: 'The TradeFinder token has passed its expiry, so every capture is being refused.',
      action: 'Paste a fresh lt/at pair from a signed-in TradeFinder tab.',
    };
  }

  const ago = humanAgo(input.lastSuccessAt, nowMs);
  const tally = input.attemptsToday > 0 ? ` ${input.successesToday}/${input.attemptsToday} captures succeeded today.` : '';

  if (!input.lastError) {
    return {
      level: 'ok',
      headline: ago ? `Capturing — last feed ${ago}` : 'Connected',
      detail: ago
        ? `The most recent tick captured cleanly.${tally}`
        : `Connected and waiting for the next tick inside the capture window.${tally}`,
      action: null,
    };
  }

  if (isTransientTfError(input.lastError)) {
    return {
      level: 'warning',
      headline: ago ? `Retrying — last good feed ${ago}` : 'Retrying',
      detail:
        `TradeFinder refused the most recent request. This is normally short-lived rate limiting, ` +
        `and the collector retries automatically on the next tick — the stored token is still valid.${tally}`,
      action: null,
    };
  }

  return {
    level: 'warning',
    headline: 'Last tick failed',
    detail: `${input.lastError}${tally}`,
    action: null,
  };
}
