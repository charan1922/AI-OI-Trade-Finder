/**
 * AI Analysis v2 — shared types. v2 owns these; nothing here is imported from or by v1
 * (`lib/operator-chat/*`, /trade-commentary).
 */

/** What v2 may DO. `take_trade` is deliberately absent: the trader takes entries only through its own pass, and v2
 *  has no channel into it (operator 2026-11-06: v2 never feeds the trader). `run_pass` runs that pass now. */
export const ACTION_KINDS = ['exit', 'move_stop', 'reject', 'run_pass', 'approve', 'setting'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];
export type ActionStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface V2Action {
  kind: ActionKind;
  /** setting */
  key?: string;
  value?: string;
  from?: string | null;
  /** exit / move_stop / approve / reject */
  tradeId?: number;
  symbol?: string;
  contract?: string;
  /** move_stop */
  fromSl?: number | null;
  toSl?: number;
}

export interface ActionView extends V2Action {
  status: ActionStatus;
  result: string | null;
}

/** A proposal can only be confirmed while it is fresh — "exit X" means NOW, not an hour later. */
export const ACTION_TTL_MS = 10 * 60_000;

export function isActionExpired(proposedAtIso: string, nowMs = Date.now()): boolean {
  const t = new Date(proposedAtIso).getTime();
  return !Number.isFinite(t) || nowMs - t > ACTION_TTL_MS;
}

/** One step of a turn as the page shows it (a tool call with its input and result line). */
export interface StepRecord {
  id: string;
  /** name + arguments — the duplicate-read guard's key. */
  key: string;
  title: string;
  /** What the AI asked for, compact ("source: auto_trade_today"). */
  input: string | null;
  /** The tool's own one-line result. */
  detail: string | null;
  ok: boolean;
  ms: number | null;
}

export interface PlanStep {
  title: string;
  status: 'pending' | 'in_progress' | 'done';
}

/** Why the AI spoke without being asked. */
export interface WakeInfo {
  kind: 'watch' | 'heartbeat';
  reason?: string;
  watches: { id: number; label: string; note: string }[];
  /** 'ai' = the AI wrote it; 'fallback' = the AI failed and code wrote it; 'capped' = over the daily cap. */
  outcome: 'ai' | 'fallback' | 'capped';
}

/** Everything recorded about one answer (the audit record the page draws). */
export interface AnswerDetails {
  steps: StepRecord[];
  /** MiMo's own reasoning text, per model round that had any — real, never paraphrased. */
  reasoning: string[];
  /** Time spent on the thinking (first) model round. */
  thinkMs: number | null;
  plan: PlanStep[] | null;
  skills: string[];
  question: { text: string; options: string[] } | null;
  memories: number[];
  /** Self-healing: what failed and how the answer recovered. */
  recovered: string[];
  /** Code-enforced checks that asked the model to fix its answer (review node). */
  reviews: string[];
  wake: WakeInfo | null;
  ms: number;
  rounds: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
}

export interface V2Message {
  id: number;
  date: string;
  role: 'user' | 'assistant';
  content: string;
  at: string;
  model: string | null;
  details: AnswerDetails | null;
  /** Set on an action row (a Confirm card / an auto action's record). */
  action: ActionView | null;
  images: string[] | null;
  /** The answer failed or was stopped part way; `failureReason` says why. */
  partial: boolean;
  failureReason: string | null;
}

/** Server-sent events of one chat run, in order (the page draws them live). */
export type AgentEvent =
  | { event: 'run'; data: { runId: string; messageId: number; userMessageId: number } }
  | { event: 'step'; data: { id: string; title: string; input: string | null } }
  | { event: 'step_done'; data: StepRecord }
  | { event: 'reasoning'; data: { text: string } }
  | { event: 'delta'; data: { text: string } }
  | { event: 'plan'; data: { steps: PlanStep[] } }
  | { event: 'note'; data: { text: string; tone: 'info' | 'warn' } }
  /** The streamed answer text so far is discarded (the review node asked the model to rewrite it). */
  | { event: 'reset'; data: Record<string, never> }
  | { event: 'done'; data: { message: V2Message | null; actions: V2Message[] } }
  | { event: 'error'; data: { message: string } };
