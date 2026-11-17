/**
 * Fyers data-budget rules — PURE (no I/O), CI-checked by
 * scripts/fyers-budget-checks.ts. Standard plan since 2026-11-16: 5/s, 50/min,
 * 5,000/day for Data APIs. The gate (lib/fyers/client.ts) applies these:
 *   - the day's count is persisted (budget-store.ts) so a deploy mid-session
 *     resumes instead of believing it has 4,500 calls left;
 *   - a Fyers refusal LATCHES the gate shut (a minute, or until 00:00 IST) —
 *     on 2026-11-16/17 the poller kept firing ~495 refused calls every cycle;
 *   - the last CRITICAL_RESERVE calls of the day belong to the critical lane
 *     (open-trade guard quotes, entry spot) so a trade is never left blind.
 */

export type FyersLane = 'critical' | 'normal';
export type LimitKind = 'minute' | 'day';

export const CRITICAL_RESERVE = 500;
const IST_OFFSET_MS = 19_800_000;

export interface BudgetState {
  date: string;
  count: number;
  latchUntil: number;
  latchReason: string | null;
}

export type StoredBudget = BudgetState;

/** Fyers' own refusal text ("…limit of 50 requests/minute", "…5,000 requests/day"). */
export function classifyLimitRefusal(message: string): LimitKind | null {
  if (/requests\s*\/\s*day|per\s+day/i.test(message)) return 'day';
  if (/requests\s*\/\s*min(ute)?|per\s+minute/i.test(message)) return 'minute';
  return null;
}

export function istDayKey(nowMs: number): string {
  return new Date(nowMs + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export function latchUntilFor(kind: LimitKind, nowMs: number): number {
  if (kind === 'minute') return nowMs + 61_000;
  return Date.parse(`${istDayKey(nowMs)}T00:00:00+05:30`) + 86_400_000;
}

/** Today's state from the stored row: same IST day → resume, else a fresh day. */
export function resumeBudget(row: StoredBudget | null, nowMs: number): BudgetState {
  const date = istDayKey(nowMs);
  if (!row || row.date !== date) return { date, count: 0, latchUntil: 0, latchReason: null };
  return { date, count: row.count, latchUntil: row.latchUntil, latchReason: row.latchReason };
}

/** null = admitted; otherwise the human-readable refusal. */
export function admitCall(s: BudgetState, lane: FyersLane, perDay: number, nowMs: number): string | null {
  if (nowMs < s.latchUntil) {
    const until = new Date(s.latchUntil + IST_OFFSET_MS).toISOString().slice(11, 16);
    return `Fyers data paused until ${until} IST (${s.latchReason ?? 'limit'})`;
  }
  const allowance = lane === 'critical' ? perDay : perDay - CRITICAL_RESERVE;
  if (s.count >= allowance) {
    return lane === 'critical'
      ? `Fyers daily data budget exhausted (${s.count}/${perDay})`
      : `Fyers daily data budget: last ${CRITICAL_RESERVE} calls reserved for open trades (${s.count}/${perDay})`;
  }
  return null;
}
