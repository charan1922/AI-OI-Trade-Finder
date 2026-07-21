/**
 * PURE config-drift checks — no DB, no clocks. Exercises buildConfigOverrideSummary
 * (the value≠default detector behind the pre-open reminder) so the safety
 * feature is covered in CI, not only claimed (PR#2 review 2026-07-20). Run by
 * both the box bench and the DB-free CI runner (scripts/verify-quant-shadow.ts).
 */
import { buildConfigOverrideSummary } from '../lib/config/feature-toggles';
import {
  type DriftReminderDeps,
  inDriftReminderWindow,
  runConfigDriftReminderCore,
} from '../lib/config/config-drift-reminder';

export type CheckFn = (name: string, ok: boolean, detail?: string) => void;

/** A recording fake for the reminder's injected effects; override per test. */
function fakeDeps(over: Partial<DriftReminderDeps> = {}): {
  deps: DriftReminderDeps;
  calls: { sent: string[]; marked: number; leaseAcquired: number; leaseReleased: number };
} {
  const calls = { sent: [] as string[], marked: 0, leaseAcquired: 0, leaseReleased: 0 };
  const deps: DriftReminderDeps = {
    wasMarked: async () => false,
    acquireLease: async () => {
      calls.leaseAcquired++;
      return true;
    },
    releaseLease: async () => {
      calls.leaseReleased++;
    },
    getOverrides: async () => ['Breakout bypass: ON (safe default OFF)'],
    send: async (m) => {
      calls.sent.push(m);
      return { ok: true };
    },
    mark: async () => {
      calls.marked++;
      return true;
    },
    ...over,
  };
  return { deps, calls };
}

// IST-wall-clock Date helper for the window tests (local components = IST).
const istAt = (h: number, m: number, day = 1 /* Mon */) => new Date(2026, 6, 20 + (day - 1), h, m);

// Minimal fixtures matching the ToggleState / NumberState shapes the real
// getAllToggles / getAllNumberSettings return.
const toggle = (label: string, category: string, value: boolean, def: boolean) => ({ label, category, value, default: def });
const number = (key: string, label: string, category: string, value: number, def: number, min: number) => ({
  key, label, category, value, default: def, min,
});

export async function runConfigDriftChecks(check: CheckFn): Promise<void> {
  // 1. A non-default 'Trade Suggest' toggle appears.
  const s1 = buildConfigOverrideSummary(
    [toggle('Extended-trend bypass', 'Trade Suggest', true, false)],
    []
  );
  check('config-drift: non-default Trade Suggest toggle appears', s1.length === 1 && s1[0].includes('Extended-trend bypass') && s1[0].includes('ON') && s1[0].includes('safe default OFF'), s1[0]);

  // 2. A toggle AT its default is excluded.
  const s2 = buildConfigOverrideSummary([toggle('Skip already-extended movers', 'Trade Suggest', true, true)], []);
  check('config-drift: toggle at default is excluded', s2.length === 0);

  // 3. A NON-default toggle in another category (Server) is excluded.
  const s3 = buildConfigOverrideSummary([toggle('Auto power-off', 'Server', true, false)], []);
  check('config-drift: non-Trade-Suggest (Server) toggle excluded', s3.length === 0);

  // 4. A non-default numeric scanner setting (MAX_PICKS, Trade Suggest) is included.
  const s4 = buildConfigOverrideSummary([], [number('MAX_PICKS', 'Max picks per scan', 'Trade Suggest', 7, 3, 1)]);
  check('config-drift: numeric Trade Suggest override included', s4.length === 1 && s4[0].includes('Max picks per scan') && s4[0].includes('7') && s4[0].includes('safe default 3'), s4[0]);

  // 5. A drifted window TIME (Entry & Exit Times) is included AND rendered HH:MM.
  const s5 = buildConfigOverrideSummary([], [number('WINDOW_END_MIN', 'Scan window closes (min IST)', 'Entry & Exit Times', 870, 660, 600)]);
  check('config-drift: window-time drift included and shown HH:MM', s5.length === 1 && s5[0].includes('14:30') && s5[0].includes('safe default 11:00'), s5[0]);

  // 6. A numeric AT its default is excluded.
  const s6 = buildConfigOverrideSummary([], [number('WINDOW_START_MIN', 'Scan window opens (min IST)', 'Entry & Exit Times', 580, 580, 555)]);
  check('config-drift: numeric at default excluded', s6.length === 0);

  // 7. A numeric in an unrelated category is excluded even when drifted.
  const s7 = buildConfigOverrideSummary([], [number('SOME_OTHER', 'Unrelated knob', 'Server', 5, 1, 0)]);
  check('config-drift: unrelated-category numeric excluded', s7.length === 0);

  // 8. Mixed set: counts only the drifted, relevant ones.
  const s8 = buildConfigOverrideSummary(
    [
      toggle('Breakout bypass', 'Trade Suggest', true, false), // in
      toggle('TF breakout gate', 'Trade Suggest', false, false), // out (default)
      toggle('Auto power-off', 'Server', true, false), // out (category)
    ],
    [
      number('MAX_PICKS', 'Max picks per scan', 'Trade Suggest', 5, 3, 1), // in
      number('COMMENTARY_ENTRY_CUTOFF_MIN', 'Commentary entry cutoff (min IST)', 'Entry & Exit Times', 750, 750, 660), // out (default)
    ]
  );
  check('config-drift: mixed set counts only drifted+relevant', s8.length === 2, `got ${s8.length}: ${JSON.stringify(s8)}`);

  const staleOff = buildConfigOverrideSummary(
    [toggle('Block stale-candle auto entry', 'Priority Refresh', false, true)],
    []
  );
  check(
    'config-drift: BLOCK_STALE_AUTO_ENTRY OFF is reported with safe default ON',
    staleOff.length === 1 && staleOff[0].includes('Block stale-candle auto entry') && staleOff[0].includes('OFF') && staleOff[0].includes('safe default ON'),
    staleOff[0]
  );
  const staleOn = buildConfigOverrideSummary(
    [toggle('Block stale-candle auto entry', 'Priority Refresh', true, true)],
    []
  );
  check('config-drift: BLOCK_STALE_AUTO_ENTRY ON is excluded', staleOn.length === 0);

  const priorityCap = buildConfigOverrideSummary(
    [],
    [number('PRIORITY_MAX_UNIQUE', 'Max unique Tier 1', 'Priority Refresh', 30, 40, 1)]
  );
  check(
    'config-drift: PRIORITY_MAX_UNIQUE numeric override is reported',
    priorityCap.length === 1 && priorityCap[0].includes('30') && priorityCap[0].includes('safe default 40'),
    priorityCap[0]
  );

  // ── Reminder WINDOW (PR#2 review: must span the whole session, not stop 11:00) ──
  check('window: pre-open 08:45 weekday → in window', inDriftReminderWindow(istAt(8, 45)) === true);
  check('window: 12:00 weekday (SCAN_OUTSIDE_WINDOW late-restart case) → in window', inDriftReminderWindow(istAt(12, 0)) === true);
  check('window: 15:00 weekday → still in window (before 15:30 close)', inDriftReminderWindow(istAt(15, 0)) === true);
  check('window: 08:00 (too early) → out', inDriftReminderWindow(istAt(8, 0)) === false);
  check('window: 16:00 (after close) → out', inDriftReminderWindow(istAt(16, 0)) === false);
  check('window: Sunday noon → out (weekend)', inDriftReminderWindow(istAt(12, 0, 7)) === false);

  // ── Reminder WORKFLOW via injected fakes (PR#2 review) ──────────────────────
  // Successful delivery sends once AND writes the marker.
  {
    const { deps, calls } = fakeDeps();
    const r = await runConfigDriftReminderCore(deps);
    check('reminder: success → status sent, one send, marker written', r.status === 'sent' && calls.sent.length === 1 && calls.marked === 1 && r.completedToday, r.status);
    check('reminder: success message lists the drifted setting', calls.sent[0]?.includes('Breakout bypass'));
    check('reminder: lease released after a successful send', calls.leaseReleased === 1);
  }
  // Telegram failure → NO marker, NOT completed → retries next tick.
  {
    const { deps, calls } = fakeDeps({ send: async () => ({ ok: false, error: 'telegram 500' }) });
    const r = await runConfigDriftReminderCore(deps);
    check('reminder: delivery failure → not marked, retryable', r.status === 'send-failed' && calls.marked === 0 && r.completedToday === false, r.status);
    check('reminder: lease released even on failed send', calls.leaseReleased === 1);
  }
  // Already marked today → no send, no re-mark (persistent dedup).
  {
    const { deps, calls } = fakeDeps({ wasMarked: async () => true });
    const r = await runConfigDriftReminderCore(deps);
    check('reminder: already-marked → no send, no lease', r.status === 'already-marked' && calls.sent.length === 0 && calls.leaseAcquired === 0);
  }
  // Not the leader (lease held by another process) → no send.
  {
    const { deps, calls } = fakeDeps({ acquireLease: async () => false });
    const r = await runConfigDriftReminderCore(deps);
    check('reminder: not-leader → no send (concurrent-process guard)', r.status === 'not-leader' && calls.sent.length === 0);
  }
  // Nothing drifted → mark done, no message.
  {
    const { deps, calls } = fakeDeps({ getOverrides: async () => [] });
    const r = await runConfigDriftReminderCore(deps);
    check('reminder: no drift → marked done, no send', r.status === 'no-drift' && calls.sent.length === 0 && calls.marked === 1 && r.completedToday);
  }
  // Delivered but the marker write FAILED → honest: markedPersisted=false.
  {
    const { deps } = fakeDeps({ mark: async () => false });
    const r = await runConfigDriftReminderCore(deps);
    check('reminder: sent but marker write failed → markedPersisted false (honest)', r.status === 'sent' && r.markedPersisted === false && r.completedToday);
  }
}
