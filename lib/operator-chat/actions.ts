/**
 * Pure rules for what the operator chat may PROPOSE. Nothing here touches a
 * broker or the database, so the contract runs in CI
 * (scripts/verify-operator-chat.ts). Executing a confirmed proposal lives in
 * act.ts and goes through the SAME functions the /auto-trade console uses.
 */

import { SETTING_DEFS } from '@/lib/auto-trade/settings';
import type { ChatAction } from './format';

/**
 * Settings the chat never changes. `broker` re-routes where orders go, so it
 * stays a deliberate /auto-trade page action. (`mode: live` is refused
 * separately below — live keeps its two-key rule.)
 */
export const CHAT_SETTING_BLOCKED: ReadonlySet<string> = new Set(['broker']);

export const CHAT_SETTING_KEYS: readonly string[] = SETTING_DEFS.map((d) => d.key).filter(
  (k) => !CHAT_SETTING_BLOCKED.has(k)
);

export function settingLabel(key: string): string {
  return SETTING_DEFS.find((d) => d.key === key)?.label ?? key;
}

/**
 * Validate a requested setting change exactly as the settings registry would
 * (same parse, same ranges), WITHOUT writing it. Returns the canonical stored
 * form of the value so the Confirm card shows precisely what will be saved.
 */
export function validateSettingChange(
  key: unknown,
  rawValue: unknown
): { ok: true; key: string; value: string } | { ok: false; error: string } {
  const k = typeof key === 'string' ? key : '';
  const def = SETTING_DEFS.find((d) => d.key === k);
  if (!def) return { ok: false, error: `Unknown setting "${k}". Settable from chat: ${CHAT_SETTING_KEYS.join(', ')}` };
  if (CHAT_SETTING_BLOCKED.has(k)) return { ok: false, error: `"${k}" is changed only on the /auto-trade page.` };
  let parsed: ReturnType<typeof def.parse>;
  try {
    parsed = def.parse(String(rawValue ?? ''));
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  if (k === 'mode' && parsed === 'live') {
    return {
      ok: false,
      error:
        'Live mode is never switched on from chat — it keeps its two-key rule (AUTO_TRADE_LIVE_ENABLED on the box + the /auto-trade page).',
    };
  }
  return { ok: true, key: k, value: def.serialize(parsed) };
}

/** The one-line text on the Confirm card — what will happen, in plain words. */
export function describeAction(a: ChatAction): string {
  switch (a.kind) {
    case 'take_trade':
      return `Take ${a.symbol} now — run the trader immediately with your order to enter it (it must be an eligible scanner pick and pass every gate)`;
    case 'setting':
      return `Change ${settingLabel(a.key ?? '')} (${a.key}): ${a.from ?? '—'} → ${a.value}`;
    case 'exit':
      return `Exit ${a.symbol} ${a.contract ?? ''} now, at market`.replace(/\s+/g, ' ').trim();
    case 'move_stop':
      return `Move ${a.symbol} stop ${a.fromSl ?? '—'} → ${a.toSl} (tighten only)`;
    case 'approve':
      return `Approve the pending ${a.symbol} ${a.contract ?? ''} order (every gate re-checked on a fresh quote)`
        .replace(/\s+/g, ' ')
        .trim();
    case 'reject':
      return `Reject the pending ${a.symbol} ${a.contract ?? ''} order`.replace(/\s+/g, ' ').trim();
    case 'run_pass':
      return 'Run the trader now — fresh scan + full decision pass, every gate applies';
  }
}
