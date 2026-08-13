/**
 * Config-drift reminder — PURE orchestration, extracted from the poller so it is
 * unit-testable with injected clock/sender/marker/lease (PR#2 review 2026-07-20).
 * No I/O, no imports of prisma/telegram/poller: every side effect arrives via
 * `deps`. The poller wires the real deps; tests wire fakes.
 */

/** Reminder window (IST minutes): from the pre-open warm-up start (08:40) through
 *  MARKET CLOSE (15:30). The wide window ensures a late server restart still
 *  reports a risky stored override; the once-per-day marker prevents repeats. */
export const DRIFT_REMINDER_START_MIN = 8 * 60 + 40; // 08:40
export const DRIFT_REMINDER_END_MIN = 15 * 60 + 30; // 15:30 (market close)

/** True when `ist` (a Date whose LOCAL components are the IST wall clock) is a
 *  weekday inside [08:40, 15:30). Holiday check is applied separately (async). */
export function inDriftReminderWindow(ist: Date): boolean {
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;
  const minute = ist.getHours() * 60 + ist.getMinutes();
  return minute >= DRIFT_REMINDER_START_MIN && minute < DRIFT_REMINDER_END_MIN;
}

/**
 * The Telegram body for settings that differ from their coded safe defaults.
 */
export function buildDriftMessage(overrides: string[]): string {
  return `⚠️ Trade-Suggest scanner has ${overrides.length} setting(s) off their safe default today:\n${overrides
    .map((o) => `• ${o}`)
    .join('\n')}\n\nCheck /config if this wasn't intentional.`;
}

/** Injected effects — all async, all replaceable in tests. */
export interface DriftReminderDeps {
  /** Persistent "already done today?" check (survives restart). */
  wasMarked: () => Promise<boolean>;
  /** Serialise the send across concurrent processes; false → not the leader. */
  acquireLease: () => Promise<boolean>;
  releaseLease: () => Promise<void>;
  /** Current scanner settings that differ from their safe default. */
  getOverrides: () => Promise<string[]>;
  /** Deliver the alert; ok=false means try again next tick. */
  send: (message: string) => Promise<{ ok: boolean; error?: string }>;
  /** Persist the once-per-day marker; returns whether the write CONFIRMED. */
  mark: () => Promise<boolean>;
}

export type DriftReminderStatus = 'already-marked' | 'not-leader' | 'no-drift' | 'sent' | 'send-failed' | 'error';

export interface DriftReminderOutcome {
  status: DriftReminderStatus;
  /** True → the caller may set its in-memory fast-path marker (nothing more to do
   *  today for THIS process). False → retry on the next tick. */
  completedToday: boolean;
  /** Whether the persistent marker write confirmed. When false after a 'sent',
   *  cross-restart dedup is NOT guaranteed for the rest of today (honest signal). */
  markedPersisted: boolean;
  message?: string;
  overrides: number;
}

/**
 * Decide-and-act, given the injected effects. Marks the day done ONLY after a
 * confirmed delivery (or when there is nothing to send), so a failed DB read or
 * Telegram send is retried next tick instead of being silently lost. The lease
 * is always released via `finally`.
 */
export async function runConfigDriftReminderCore(deps: DriftReminderDeps): Promise<DriftReminderOutcome> {
  if (await deps.wasMarked()) return { status: 'already-marked', completedToday: true, markedPersisted: true, overrides: 0 };
  if (!(await deps.acquireLease())) return { status: 'not-leader', completedToday: false, markedPersisted: false, overrides: 0 };
  try {
    const overrides = await deps.getOverrides();
    if (overrides.length === 0) {
      const persisted = await deps.mark(); // nothing to deliver — safe to mark done
      return { status: 'no-drift', completedToday: true, markedPersisted: persisted, overrides: 0 };
    }
    const message = buildDriftMessage(overrides);
    const res = await deps.send(message);
    if (!res.ok) {
      // Delivery failed → do NOT mark, so the next tick retries.
      return { status: 'send-failed', completedToday: false, markedPersisted: false, message: res.error, overrides: overrides.length };
    }
    const persisted = await deps.mark(); // mark ONLY after confirmed delivery
    return { status: 'sent', completedToday: true, markedPersisted: persisted, message, overrides: overrides.length };
  } catch (err) {
    return { status: 'error', completedToday: false, markedPersisted: false, message: (err as Error).message, overrides: 0 };
  } finally {
    await deps.releaseLease();
  }
}
