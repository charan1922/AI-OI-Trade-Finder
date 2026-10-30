/**
 * Commentary v2 HEARTBEAT — the always-on, self-paced check-in (operator 2026-10-30: "let AI on — check every
 * 5 min; if it wants to analyse further it does it itself"). Modelled on Claude Code's self-paced loop: the
 * model picks its own next check (5–30 min) and decides each time whether anything deserves the operator's
 * attention. Following Anthropic's agent guidance: ground truth from tools every check, hard stopping limits,
 * human checkpoints via the per-action switches, and a cheap quiet path (nothing posted).
 *
 * Runs only while v2 is selected AND Background is ON, in market hours, never while the trader runs.
 */

import type { NeutralToolDef } from '@/lib/auto-trade/tools/defs';
import type { ToolTraceEntry } from '@/lib/auto-trade/types';

/** Hard limits — code, not prompt. */
export const HEARTBEAT_MIN_MIN = 5;
export const HEARTBEAT_MAX_MIN = 30;
export const HEARTBEAT_DEFAULT_MIN = 5;
export const MAX_HEARTBEATS_PER_DAY = 80;
/** First check-in of the day (the market opens 09:15; the TF board needs a few minutes). */
export const HEARTBEAT_START_MIN = 9 * 60 + 20;

export interface HeartbeatDecision {
  /** Set by notify_operator. QUIET IS THE DEFAULT: without it nothing is posted (poka-yoke — a live check
   *  posted "nothing needs you right now" when it was asked to stay quiet). */
  notify: string | null;
  nextMinutes: number;
  reason: string;
}

export const HEARTBEAT_TOOL_DEFS: NeutralToolDef[] = [
  {
    name: 'notify_operator',
    description:
      'Post your message to the operator. Call it ONLY when something deserves their attention now (a position near its stop or at a target, a new pick, a rejection that matters, the board breaking). Without this call your check-in stays QUIET: your final line is only logged, never posted.',
    parameters: { type: 'object', properties: { why: { type: 'string' } }, required: ['why'] },
  },
  {
    name: 'schedule_next_check',
    description: `When to check in next, in minutes (${HEARTBEAT_MIN_MIN}–${HEARTBEAT_MAX_MIN}). ${HEARTBEAT_MIN_MIN} when a position is open or something is developing; longer when quiet, out of the entry window, or the board is stale. Always call it once.`,
    parameters: {
      type: 'object',
      properties: { minutes: { type: 'number' }, reason: { type: 'string' } },
      required: ['minutes', 'reason'],
    },
  },
];

export const HEARTBEAT_TOOL_NAMES: ReadonlySet<string> = new Set(HEARTBEAT_TOOL_DEFS.map((t) => t.name));

export function executeHeartbeatTool(
  name: string,
  args: Record<string, unknown>,
  decision: HeartbeatDecision
): { result: unknown; trace: ToolTraceEntry } {
  if (name === 'notify_operator') {
    const why = typeof args.why === 'string' ? args.why.trim().slice(0, 160) : '';
    decision.notify = why || 'something worth raising';
    return {
      result: { ok: true, note: 'Your final message will be POSTED. Make it the 60–120 word message the operator should read.' },
      trace: { name, args, ok: true, summary: `will post: ${decision.notify.slice(0, 80)}` },
    };
  }
  const raw = Number(args.minutes);
  const minutes = Number.isFinite(raw) ? Math.min(HEARTBEAT_MAX_MIN, Math.max(HEARTBEAT_MIN_MIN, Math.round(raw))) : HEARTBEAT_DEFAULT_MIN;
  decision.nextMinutes = minutes;
  decision.reason = typeof args.reason === 'string' ? args.reason.trim().slice(0, 120) : '';
  return {
    result: { ok: true, nextInMinutes: minutes },
    trace: { name, args, ok: true, summary: `next check in ${minutes} min${decision.reason ? ` — ${decision.reason}` : ''}` },
  };
}

/** The check-in prompt (user turn). */
export function heartbeatPrompt(lastNotes: readonly string[], lastQuiet: string | null, openSymbols: readonly string[] = []): string {
  return [
    'CHECK-IN (no watch fired — this is your regular self-paced look at the market).',
    ...(openSymbols.length
      ? [
          `OPEN POSITION(S): ${openSymbols.join(', ')}. You MUST use_skill review_position for each and decide HOLD /`,
          'TIGHTEN / EXIT on the THESIS, not only on the stop: is the breakout still intact (price vs the level it broke —',
          'back inside the opening range means it failed)? R-Factor now vs at entry? Supertrend with or against? Has the',
          'move gone nowhere since entry? The guard only exits at the stop or target — judging the idea is YOUR job. If',
          'the thesis is broken, propose the exit (it runs by itself when exit is on Auto) and notify_operator with why.',
          'If it holds, stay quiet unless something changed.',
          '',
        ]
      : []),
    'Decide whether anything deserves the operator\'s attention RIGHT NOW. Look with your tools (ground truth, not memory):',
    '- open positions: distance to stop, R, anything breaking;',
    "- TF board / today's picks: new picks, a pick rejected, the board stale;",
    '- the market regime (sideways flip) if it matters for an open position or a pick.',
    'QUIET IS THE DEFAULT. If something matters, call notify_operator and make your final message the short note',
    'the operator should read (60–120 words, real numbers, what to do or watch). If nothing changed meaningfully,',
    'do NOT call notify_operator — end with ONE line of what you checked (it is logged, never posted).',
    'Either way call schedule_next_check. Never repeat what your notes already said.',
    ...(lastQuiet ? ['', `Your last quiet check said: ${lastQuiet}`] : []),
    ...(lastNotes.length ? ['', 'Your latest notes:', ...lastNotes.map((n) => `- ${n}`)] : []),
  ].join('\n');
}
