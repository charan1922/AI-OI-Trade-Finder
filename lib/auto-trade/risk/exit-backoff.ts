/**
 * PURE exit-retry backoff policy — no imports, no DB, no clocks.
 *
 * Lives in its own leaf so the CI bench (scripts/premium-stop-checks.ts) can
 * assert it without dragging in position-guard's import graph — prisma, the
 * broker adapters and the candle store. CLAUDE.md keeps money-touching pure
 * checks in a DB-free module on purpose; importing the guard for four
 * constants quietly broke that (review, 2026-07-28).
 *
 * CONTEXT — the incident this encodes. On 2026-07-27 the venue refused an exit
 * for margin because a SELL was already resting on the contract. The guard's
 * escalation was a NOTIFICATION ONLY: it shouted and resubmitted on the very
 * next 5-second pass, producing 89 rejected orders and 30+ identical alerts in
 * 10 minutes, none of which could ever have succeeded — the blocking condition
 * was static.
 */

/** Consecutive exit failures before escalating to a loud warning. */
export const EXIT_FAILURE_ESCALATE = 3;

/**
 * Past EXIT_FAILURE_ESCALATE consecutive failures the guard retries at most
 * once per window instead of once per pass. It NEVER gives up — an unexited
 * stopped-out position is the worse failure — it just stops hammering a venue
 * that is saying no for a reason that will not change on its own.
 */
export const EXIT_RETRY_BACKOFF_MS = 120_000;

/** Re-alert only every Nth failure past the threshold — one alarm per incident
 *  is a warning, thirty is noise that hides the next real one. */
export const EXIT_ALERT_EVERY = 10;

/**
 * How long to wait before the next exit attempt, given consecutive failures.
 * Below the escalation threshold there is no wait (a transient reject should
 * retry immediately). At or past it, one attempt per backoff window.
 */
export function exitRetryWaitMs(consecutiveFails: number): number {
  return consecutiveFails >= EXIT_FAILURE_ESCALATE ? EXIT_RETRY_BACKOFF_MS : 0;
}

/** Whether this failure count should raise an alarm: always on the FIRST
 *  escalation (a silent breaker is worse than a noisy one), then throttled. */
export function shouldAlertOnExitFailure(consecutiveFails: number): boolean {
  if (consecutiveFails < EXIT_FAILURE_ESCALATE) return false;
  return (
    consecutiveFails === EXIT_FAILURE_ESCALATE || (consecutiveFails - EXIT_FAILURE_ESCALATE) % EXIT_ALERT_EVERY === 0
  );
}
