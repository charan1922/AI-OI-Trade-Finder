/**
 * Live progress of an in-flight v2 chat turn — what the page shows WHILE the AI works (Claude-style
 * timeline), instead of "Working…" and then everything at once. In-process memory only (the app is one
 * process on the box); a turn's record lives TURN_TTL_MS and is display-only — nothing decides on it.
 */

import type { LoopStepEvent } from '@/lib/auto-trade/decision/providers';

export interface ProgressStep {
  label: string;
  state: 'running' | 'ok' | 'error';
  detail: string | null;
  ms: number | null;
}

interface Turn {
  startedAt: number;
  steps: ProgressStep[];
  done: boolean;
}

const TURN_TTL_MS = 10 * 60_000;
const MAX_STEPS = 60;

function store(): Map<string, Turn> {
  const g = globalThis as unknown as { __chatProgress?: Map<string, Turn> };
  g.__chatProgress ??= new Map();
  return g.__chatProgress;
}

/** A client-chosen id: short, URL-safe. Anything else is ignored (no progress, the reply still works). */
export const isTurnId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(v);

export function startTurn(id: string): void {
  const s = store();
  const now = Date.now();
  for (const [k, t] of s) if (now - t.startedAt > TURN_TTL_MS) s.delete(k);
  s.set(id, { startedAt: now, steps: [], done: false });
}

const toolLabel = (name: string, args: Record<string, unknown>) => {
  const pick = (k: string) => (typeof args[k] === 'string' && args[k] ? String(args[k]) : null);
  const detail = pick('source') ?? pick('symbol') ?? pick('name') ?? pick('kind');
  return `${name.replace(/_/g, ' ')}${detail ? ` · ${detail}` : ''}`;
};

/** Feed one loop event into the turn's timeline. */
export function recordStep(id: string, e: LoopStepEvent): void {
  const t = store().get(id);
  if (!t || t.steps.length >= MAX_STEPS) return;
  if (e.kind === 'model') {
    if (e.phase === 'start') t.steps.push({ label: `Thinking (model call ${e.step})`, state: 'running', detail: null, ms: null });
    else closeLast(t, `Thinking (model call ${e.step})`, true, null, e.ms ?? null);
    return;
  }
  const label = toolLabel(e.name, e.args);
  if (e.phase === 'start') t.steps.push({ label, state: 'running', detail: null, ms: null });
  else closeLast(t, label, e.ok !== false, e.summary ?? null, e.ms ?? null);
}

function closeLast(t: Turn, label: string, ok: boolean, detail: string | null, ms: number | null): void {
  for (let i = t.steps.length - 1; i >= 0; i--) {
    if (t.steps[i].label === label && t.steps[i].state === 'running') {
      t.steps[i] = { label, state: ok ? 'ok' : 'error', detail: detail?.slice(0, 160) ?? null, ms };
      return;
    }
  }
}

/** A free-text line (e.g. a self-healing retry) in the timeline. */
export function noteStep(id: string, label: string, state: ProgressStep['state'] = 'ok'): void {
  const t = store().get(id);
  if (t && t.steps.length < MAX_STEPS) t.steps.push({ label, state, detail: null, ms: null });
}

export function finishTurn(id: string): void {
  const t = store().get(id);
  if (t) t.done = true;
}

export function getTurn(id: string): { steps: ProgressStep[]; done: boolean; elapsedMs: number } | null {
  const t = store().get(id);
  return t ? { steps: t.steps, done: t.done, elapsedMs: Date.now() - t.startedAt } : null;
}
