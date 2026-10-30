/**
 * Commentary v2 — pure view helpers and the client-side shapes of the APIs the page reads.
 * No React, no fetch.
 */

import type { ActionView, ChatToolUse, ReplyMeta, WakeInfo } from '@/lib/operator-chat/format';

export interface V2Message {
  id: number;
  date: string;
  role: 'user' | 'assistant';
  content: string;
  at: string;
  action?: ActionView | null;
  tools?: ChatToolUse[] | null;
  model?: string | null;
  wake?: WakeInfo | null;
  meta?: ReplyMeta | null;
  images?: string[] | null;
}

export interface TraderRead {
  id: number;
  date: string;
  asOf: string;
  model: string;
  text: string;
  picksCount: number;
  promptTokens: number | null;
  completionTokens: number | null;
  createdAt: string;
}

export interface CycleStep {
  name: string;
  startedAt: string;
  endedAt: string;
  ms: number;
  ok: boolean;
  detail?: string;
}

export interface CycleTimeline {
  id: number;
  status: string | null;
  startedAt: string;
  finishedAt: string | null;
  totalMs: number | null;
  steps: CycleStep[];
}

export interface WatchView {
  id: number;
  kind: string;
  params: Record<string, unknown>;
  label: string;
  createdBy: 'operator' | 'ai';
  status: 'watching' | 'fired' | 'cancelled' | 'expired';
  createdAt: string;
  firedAt: string | null;
  firedDetail: string | null;
  lastCheckedAt: string | null;
  lastCheckNote: string | null;
  cadence: string;
}

export interface BackgroundState {
  enabled: boolean;
  /** /config selects v2 (COMMENTARY_V2). False → v2's background work is paused (one version at a time). */
  v2Selected: boolean;
  loop: {
    startedAt: string | null;
    autonomous: boolean;
    tickMs: number;
    lastTick: { at: string; status: string; detail: string | null; ms: number } | null;
  };
  limits: { maxActiveWatches: number; wakeCapPerDay: number };
  budget: { used: number; nextAtMs: number | null };
  watches: WatchView[];
  notes: { id: number; at: string; text: string }[];
  wakeups: {
    id: number;
    at: string;
    kind: 'watch' | 'heartbeat';
    watchIds: number[];
    outcome: 'ai' | 'fallback' | 'capped' | 'quiet';
    messageId: number | null;
    detail: string | null;
  }[];
  heartbeat: { nextCheckAt: string | null; due: boolean; today: number; max: number };
  /** The code's own session times (never typed into the page). */
  session: { raceStartMin: number; squareOffMin: number; watchExpiryMin: number };
  /** v2's own chat model (default Flash) — separate from the auto-trader's. */
  model: { mimoModel: string; defaultModel: string; options: string[] };
  skills: string[];
  memories: { id: number; kind: 'lesson' | 'preference'; text: string; status: 'pending' | 'saved'; createdAt: string }[];
  /** Per action kind: true = the AI does it by itself, false = Confirm card. */
  autoActions: Record<string, boolean>;
}

export interface ProgressStep {
  label: string;
  state: 'running' | 'ok' | 'error';
  detail: string | null;
  ms: number | null;
}

export interface LiveTurn {
  steps: ProgressStep[];
  done: boolean;
  elapsedMs: number;
}

export interface TradeView {
  id: number;
  symbol: string;
  status: string;
  direction: 'bullish' | 'bearish';
  optionType: string;
  strike: number;
  entrySpot: number;
  slSpot: number | null;
  entryPremium: number | null;
  aiReasonEntry: string | null;
}

export interface AutoTradeState {
  settings: { mode: string; broker: string; aiProvider: 'azure' | 'mimo'; killSwitch: boolean; maxTradesPerDay: number };
  /** Server env key AUTO_TRADE_LIVE_ENABLED — the second key live mode needs (approval mode does not). */
  liveEnvEnabled: boolean;
  entryWindow: { opensAt: string; closesAt: string; active: boolean };
  today: { entriesUsed: number; openLots: number; realizedPnlRupees: number };
  trades: TradeView[];
  pending: TradeView[];
}

export interface RaceRow {
  symbol: string;
  side: 'CE' | 'PE';
  rankNow: number;
  tradeable: boolean;
  blockedBy: string | null;
  needs: string | null;
  gates: Record<string, boolean | null>;
}

export interface RaceState {
  stale?: boolean;
  boardMinuteIST?: number | null;
  verdictNote?: string | null;
  board?: RaceRow[];
}

/** Epoch ms of an ISO timestamp or an IST "YYYY-MM-DD HH:MM[:SS]" string. */
export function toMs(s: string): number {
  const iso = s.includes('T') ? s : `${s.replace(' ', 'T')}+05:30`;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
}

export function hhmm(s: string | number): string {
  const d = new Date(typeof s === 'number' ? s : toMs(s));
  return Number.isNaN(d.getTime())
    ? String(s)
    : d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
}

export function istMinuteNow(nowMs = Date.now()): number {
  const d = new Date(nowMs + 330 * 60_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

export function istToday(nowMs = Date.now()): string {
  return new Date(nowMs + 330 * 60_000).toISOString().slice(0, 10);
}

/** Epoch ms of HH:MM IST on `date`. */
export function istAt(date: string, minute: number): number {
  const h = String(Math.floor(minute / 60)).padStart(2, '0');
  const m = String(minute % 60).padStart(2, '0');
  return new Date(`${date}T${h}:${m}:00+05:30`).getTime();
}

const parseClock = (s: string | undefined): number | null => {
  const m = /^(\d{1,2}):(\d{2})/.exec(s ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

export interface Milestone {
  minute: number;
  label: string;
  detail: string;
}

export const clockOf = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

/** NSE's own hours — the only times this page knows without asking the server. */
const MARKET_OPEN_MIN = 9 * 60 + 15;
const MARKET_CLOSE_MIN = 15 * 60 + 30;

/**
 * The trading day as the code runs it. Every time comes from the server (race baseline, square-off,
 * watch expiry from /background; the effective entry window from /api/auto-trade). A milestone whose
 * time the page has not received is LEFT OUT — never filled with a guessed default.
 */
export function sessionMilestones(
  session: BackgroundState['session'] | null | undefined,
  entryWindow: { opensAt: string; closesAt: string } | null | undefined
): Milestone[] {
  const out: Milestone[] = [{ minute: MARKET_OPEN_MIN, label: 'Market opens', detail: 'NSE' }];
  if (session) out.push({ minute: session.raceStartMin, label: 'TF race baseline', detail: 'climbers measured from here' });
  const opens = parseClock(entryWindow?.opensAt);
  const closes = parseClock(entryWindow?.closesAt);
  if (opens != null) out.push({ minute: opens, label: 'Entry window opens', detail: 'auto-trader setting' });
  if (closes != null) out.push({ minute: closes, label: 'Entry window closes', detail: 'exits only after this' });
  if (session) out.push({ minute: session.squareOffMin, label: 'Forced square-off', detail: 'auto-trader setting' });
  out.push({
    minute: MARKET_CLOSE_MIN,
    label: 'Market closes',
    detail: session?.watchExpiryMin === MARKET_CLOSE_MIN ? 'watches expire' : 'NSE',
  });
  return out.sort((a, b) => a.minute - b.minute);
}

export function planStatus(m: Milestone, next: Milestone | undefined, nowMin: number): 'done' | 'now' | 'next' {
  if (nowMin < m.minute) return 'next';
  if (next && nowMin >= next.minute) return 'done';
  return next ? 'now' : 'done';
}

export type ThreadItem =
  | { kind: 'read'; ms: number; read: TraderRead }
  | { kind: 'chat'; ms: number; msg: V2Message }
  | { kind: 'checkpoint'; ms: number; label: string; time: string }
  | { kind: 'day'; ms: number; label: string };

export const dayLabel = (date: string) =>
  new Date(`${date}T12:00:00+05:30`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });

/**
 * One stream, oldest first: trader reads + chat + wake-ups, with a divider per IST day and that day's
 * session milestones (all of them for a past day, only those already passed for today). Off-hours the
 * reads feed returns the LATEST day that has reads, which can be an earlier day than today's chat.
 */
export function buildThread(
  reads: readonly TraderRead[],
  messages: readonly V2Message[],
  milestones: readonly Milestone[],
  nowMs = Date.now()
): ThreadItem[] {
  const items: ThreadItem[] = [
    ...reads.map((r) => ({ kind: 'read' as const, ms: toMs(r.createdAt), read: r })),
    ...messages.map((m) => ({ kind: 'chat' as const, ms: toMs(m.at), msg: m })),
  ];
  const today = istToday(nowMs);
  const dates = [...new Set([...reads.map((r) => r.date), ...messages.map((m) => m.date || today)])].sort();
  // Session markers only on days with a trader read — proof the session ran (no markers on holidays).
  const sessionDays = new Set(reads.map((r) => r.date));
  for (const date of dates) {
    items.push({ kind: 'day', ms: istAt(date, 0), label: date === today ? `Today · ${dayLabel(date)}` : dayLabel(date) });
    if (!sessionDays.has(date)) continue;
    for (const m of milestones) {
      const ms = istAt(date, m.minute);
      if (date < today || ms <= nowMs) items.push({ kind: 'checkpoint', ms, label: m.label, time: hhmm(ms) });
    }
  }
  return items.sort((a, b) => a.ms - b.ms);
}

/** Unique sources a reply read, in first-use order. */
export function sourcesOf(tools: readonly ChatToolUse[] | null | undefined): string[] {
  return [...new Set((tools ?? []).filter((t) => t.label !== 'prepared an action card').map((t) => t.label))];
}

export const fmtMs = (ms: number) => (ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);

export const fmtTokens = (n: number | null | undefined) => (n == null ? '—' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
