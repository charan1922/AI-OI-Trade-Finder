/**
 * AI Analysis v2 — the agent as a LangGraph StateGraph (pattern: the operator's sap-triage graph).
 *
 *   START → prepare → model ─(tool calls)→ tools → model …
 *                      └─(final text)→ review ─(fix needed, asked once)→ model
 *                                             └─(ok)→ act → END
 *
 * - model   one streamed MiMo call (model.ts). Thinking on the first round only; self-heals: thinking off, then
 *           Flash. Past MAX_ROUNDS a last call with tools removed forces an answer.
 * - tools   runs each call (tools.ts), streams a step per call.
 * - review  checks enforced in CODE, each asked once (as the reference agent does — the model sometimes skips
 *           what the instructions ask): the final message must be an answer, not bookkeeping ("Noted."); a
 *           check-in with an open position must have looked at that position.
 * - act     proposed actions run per the operator's per-kind Auto / Ask switches (actions.ts).
 *
 * Events go out through LangGraph's custom stream (`config.writer`) — the chat route forwards them as SSE; a
 * background run (wake-up / check-in) simply has no listener.
 */

import { Annotation, END, type LangGraphRunnableConfig, START, StateGraph } from '@langchain/langgraph';
import { applyProposals, type AutoActions } from './actions';
import { DEFAULT_CHAT_MODEL } from './background-store';
import { callMimo, type MimoMessage, type ModelResult, toMimoTools } from './model';
import { imageRules, instructions, liveContext, UNPROMPTED_RULES } from './prompt';
import { QUIET_TOOLS, readableArgs, runTool, stepTitle, toolDefs, type TurnState } from './tools';
import type { AgentEvent, StepRecord, V2Message } from './types';
import type { ChatMemory } from './background-store';

/** Model rounds per turn. Every round re-sends the conversation, so this is also a token cap. */
export const MAX_ROUNDS = 8;
const TOOL_OUTPUT_CHARS = 9_000;

export type RunMode = 'chat' | 'wake' | 'checkin';

/** Per-run inputs the nodes need (not part of the graph state: functions, signals, mutable turn record). */
export interface RunContext {
  date: string;
  mode: RunMode;
  model: string;
  thinking: boolean;
  background: boolean;
  autoActions: AutoActions;
  memories: ChatMemory[];
  openPositions: string[];
  turn: TurnState;
  signal?: AbortSignal;
  /** Filled by `act`. */
  actions: V2Message[];
}

const last = <T>(_: T, incoming: T): T => incoming;
const append = <T>(current: T[], incoming: T[]): T[] => [...(current ?? []), ...(incoming ?? [])];
const sum = (a: number, b: number) => (a ?? 0) + (b ?? 0);

export const AgentState = Annotation.Root({
  system: Annotation<string>({ reducer: last, default: () => '' }),
  messages: Annotation<MimoMessage[]>({ reducer: append, default: () => [] }),
  round: Annotation<number>({ reducer: last, default: () => 0 }),
  answer: Annotation<string>({ reducer: last, default: () => '' }),
  modelUsed: Annotation<string>({ reducer: last, default: () => '' }),
  reasoning: Annotation<string[]>({ reducer: append, default: () => [] }),
  thinkMs: Annotation<number | null>({ reducer: last, default: () => null }),
  steps: Annotation<StepRecord[]>({ reducer: append, default: () => [] }),
  recovered: Annotation<string[]>({ reducer: append, default: () => [] }),
  reviews: Annotation<string[]>({ reducer: append, default: () => [] }),
  promptTokens: Annotation<number>({ reducer: sum, default: () => 0 }),
  completionTokens: Annotation<number>({ reducer: sum, default: () => 0 }),
  cachedTokens: Annotation<number>({ reducer: sum, default: () => 0 }),
  reasoningTokens: Annotation<number>({ reducer: sum, default: () => 0 }),
  /** Repeated reads the guard refused this turn. Two → the next round has no tools and must answer. */
  refusals: Annotation<number>({ reducer: sum, default: () => 0 }),
  /** Set by review when it pushed a fix request this pass. */
  reviewRetry: Annotation<boolean>({ reducer: last, default: () => false }),
});

type State = typeof AgentState.State;
type Config = LangGraphRunnableConfig & { configurable?: { ctx?: RunContext } };

function ctxOf(config: Config): RunContext {
  const ctx = config.configurable?.ctx;
  if (!ctx) throw new Error('AI Analysis v2: run context missing');
  return ctx;
}

function emit(config: Config, e: AgentEvent): void {
  try {
    config.writer?.(e);
  } catch {
    // display only — never let a closed stream break the run
  }
}

// ── prepare ──────────────────────────────────────────────────────────────────

async function prepare(_state: State, config: Config): Promise<Partial<State>> {
  const ctx = ctxOf(config);
  // Static first (cacheable), live last.
  const system = [
    instructions(),
    ...(ctx.mode === 'chat' ? [] : [UNPROMPTED_RULES]),
    await liveContext({ date: ctx.date, autoActions: ctx.autoActions, memories: ctx.memories }),
  ].join('\n\n');
  return { system };
}

// ── model ────────────────────────────────────────────────────────────────────

async function model(state: State, config: Config): Promise<Partial<State>> {
  const ctx = ctxOf(config);
  // Out of rounds, or the model keeps asking for reads it already has (seen 2026-11-06: 6 refused repeats in a row).
  const finalRound = state.round >= MAX_ROUNDS || state.refusals >= 2;
  const tools = finalRound ? [] : toMimoTools(toolDefs({ background: ctx.background, checkIn: ctx.mode === 'checkin' }));
  const messages: MimoMessage[] = [
    { role: 'system', content: state.system },
    ...state.messages,
    // Seen 2026-11-06: with tools removed and no instruction, MiMo wrote raw <tool_call> markup as its "answer".
    ...(finalRound
      ? [{ role: 'user' as const, content: 'No more tool calls are possible. Answer the operator now with what your tools already returned, and say plainly what you could not read.' }]
      : []),
  ];

  // Self-healing ladder for this round: [thinking as asked] → thinking off → Flash.
  const think = ctx.thinking && state.round === 0;
  const attempts: { thinking: boolean; model: string; why?: string }[] = [
    { thinking: think, model: ctx.model },
    ...(think ? [{ thinking: false, model: ctx.model, why: 'thinking off' }] : []),
    ...(ctx.model !== DEFAULT_CHAT_MODEL ? [{ thinking: false, model: DEFAULT_CHAT_MODEL, why: `fell back to ${DEFAULT_CHAT_MODEL}` }] : []),
  ];
  const recovered: string[] = [];
  let result: ModelResult | null = null;
  let used = ctx.model;
  let lastErr: unknown = null;
  for (const a of attempts) {
    if (a.why) {
      emit(config, { event: 'note', data: { text: `Self-healing: retrying with ${a.why}`, tone: 'warn' } });
      emit(config, { event: 'reset', data: {} }); // drop text the failed attempt had already streamed
    }
    try {
      result = await callMimo({
        model: a.model,
        messages,
        tools,
        thinking: a.thinking,
        signal: ctx.signal,
        onReasoning: (d) => emit(config, { event: 'reasoning', data: { text: d } }),
        onText: (d) => emit(config, { event: 'delta', data: { text: d } }),
      });
      used = a.model;
      break;
    } catch (err) {
      lastErr = err;
      if (ctx.signal?.aborted) throw new Error('Stopped by the operator.');
      recovered.push(`${a.thinking ? 'thinking on' : 'thinking off'} · ${a.model} failed: ${(err as Error).message.slice(0, 140)}`);
    }
  }
  if (!result) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  // Text written in a round that then calls tools ("let me check…") is not the answer — clear it from the page.
  if (result.toolCalls.length && result.content.trim()) emit(config, { event: 'reset', data: {} });

  const assistant: MimoMessage = {
    role: 'assistant',
    content: result.content,
    // MiMo rule: an assistant message with tool calls is replayed WITH its reasoning on every later request.
    ...(result.reasoning ? { reasoning_content: result.reasoning } : {}),
    ...(result.toolCalls.length
      ? { tool_calls: result.toolCalls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.arguments } })) }
      : {}),
  };
  return {
    messages: [assistant],
    round: state.round + 1,
    answer: result.toolCalls.length ? state.answer : result.content.trim(),
    modelUsed: used,
    reasoning: result.reasoning ? [result.reasoning] : [],
    thinkMs: state.round === 0 && result.reasoning ? result.ms : state.thinkMs,
    recovered,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    cachedTokens: result.cachedTokens,
    reasoningTokens: result.reasoningTokens,
    reviewRetry: false,
  };
}

function afterModel(state: State): 'tools' | 'review' {
  const lastMsg = state.messages[state.messages.length - 1];
  return lastMsg?.role === 'assistant' && lastMsg.tool_calls?.length ? 'tools' : 'review';
}

// ── tools ────────────────────────────────────────────────────────────────────

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || '{}') as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function tools(state: State, config: Config): Promise<Partial<State>> {
  const ctx = ctxOf(config);
  const lastMsg = state.messages[state.messages.length - 1];
  const calls = lastMsg?.role === 'assistant' ? (lastMsg.tool_calls ?? []) : [];
  const out: MimoMessage[] = [];
  const steps: StepRecord[] = [];
  let refusals = 0;
  // Earlier calls this turn, by name+args: how often each ran and whether its last run failed.
  const seen = new Map<string, { runs: number; ok: boolean }>();
  for (const s of state.steps) seen.set(s.key, { runs: (seen.get(s.key)?.runs ?? 0) + 1, ok: s.ok });
  // Sequential on purpose: the reads share the app's broker / quote gates (house rule: no parallel broker calls).
  for (const c of calls) {
    if (ctx.signal?.aborted) throw new Error('Stopped by the operator.');
    const args = parseArgs(c.function.arguments);
    const id = c.id || `${c.function.name}-${state.round}-${steps.length}`;
    const title = stepTitle(c.function.name, args);
    const input = readableArgs(args);
    const quiet = QUIET_TOOLS.has(c.function.name);
    // Enforced in code (seen 2026-11-06: the same two reads repeated 6 times until the round cap): a read that
    // succeeded is not repeated; a failed read gets ONE retry, then the model must say it could not read it.
    const key = `${c.function.name}:${JSON.stringify(args)}`;
    const prior = seen.get(key);
    if (!quiet && prior && (prior.ok || prior.runs >= 2)) {
      const refusal = prior.ok
        ? 'Already read this turn — the result is above. Do not read it again; use it.'
        : 'This read failed twice. Do not try again: tell the operator plainly that you could not read it, and answer with what you have.';
      out.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify({ error: refusal }) });
      refusals += 1;
      continue;
    }
    if (!quiet) emit(config, { event: 'step', data: { id, title, input } });
    const t0 = Date.now();
    const run = await runTool(c.function.name, args, { date: ctx.date, turn: ctx.turn, background: ctx.background });
    const rec: StepRecord = { id, key, title, input, detail: run.detail, ok: run.ok, ms: Date.now() - t0 };
    seen.set(key, { runs: (prior?.runs ?? 0) + 1, ok: run.ok });
    if (!quiet) emit(config, { event: 'step_done', data: rec });
    if (c.function.name === 'update_plan' && ctx.turn.plan) emit(config, { event: 'plan', data: { steps: ctx.turn.plan } });
    if (!quiet) steps.push(rec);
    let text = JSON.stringify(run.output);
    if (text.length > TOOL_OUTPUT_CHARS) text = `${text.slice(0, TOOL_OUTPUT_CHARS)}… [cut: narrow the request]`;
    out.push({ role: 'tool', tool_call_id: c.id, content: text });
  }
  return { messages: out, steps, refusals };
}

// ── review (checks enforced in code) ─────────────────────────────────────────

const BOOKKEEPING_ONLY = /^(\*|_)?\(?(noted|logged|saved|done|ok|okay|got it)[^a-z]*$/i;
/** Tool-call markup written as text (MiMo does this when it wants a tool it does not have). */
const TOOL_MARKUP = /<\/?(tool_call|function)[=>\s]/i;

async function review(state: State, config: Config): Promise<Partial<State>> {
  const ctx = ctxOf(config);
  const asked = new Set(state.reviews);
  const answer = state.answer.trim();
  const reply = (key: string, text: string): Partial<State> => {
    emit(config, { event: 'note', data: { text: 'Checking the answer again…', tone: 'info' } });
    emit(config, { event: 'reset', data: {} });
    return { messages: [{ role: 'user', content: text }], reviews: [key], reviewRetry: true };
  };
  // 1. The final message must be the answer (seen 2026-10-29: "Noted." after a write_note instead of an answer).
  const quietCheckIn = ctx.mode === 'checkin' && !ctx.turn.heartbeat?.notify;
  if (!quietCheckIn && !asked.has('answer') && (answer.length < 25 || BOOKKEEPING_ONLY.test(answer) || TOOL_MARKUP.test(answer))) {
    return reply('answer', 'Not shown yet: your last message is not an answer. Write the complete answer for the operator now, from what your tools returned.');
  }
  // 2. A check-in with an open position must look at it (seen 2026-10-30: INDIGO held on a failed breakout).
  if (ctx.mode === 'checkin' && ctx.openPositions.length && !asked.has('position')) {
    const looked = ctx.turn.skills.includes('review-position') || state.steps.some((s) => s.title.startsWith('Stock snapshot'));
    if (!looked) {
      return reply(
        'position',
        `Not done yet: ${ctx.openPositions.join(', ')} is open. Load the review-position skill, follow it, and decide HOLD / TIGHTEN / EXIT on the thesis before you finish.`
      );
    }
  }
  return { reviewRetry: false };
}

function afterReview(state: State): 'model' | 'act' {
  return state.reviewRetry ? 'model' : 'act';
}

// ── act ──────────────────────────────────────────────────────────────────────

async function act(_state: State, config: Config): Promise<Partial<State>> {
  const ctx = ctxOf(config);
  // Chat: the answer row was reserved before the run, so actions land under it. A headless turn (wake / check-in)
  // posts its message AFTER the run, so wake.ts applies the proposals itself once the message is in the thread.
  if (ctx.mode === 'chat' && ctx.turn.proposals.length) {
    ctx.actions = await applyProposals(ctx.date, ctx.turn.proposals, ctx.autoActions);
  }
  return {};
}

const graph = new StateGraph(AgentState)
  .addNode('prepare', prepare)
  .addNode('model', model)
  .addNode('tools', tools)
  .addNode('review', review)
  .addNode('act', act)
  .addEdge(START, 'prepare')
  .addEdge('prepare', 'model')
  .addConditionalEdges('model', afterModel, { tools: 'tools', review: 'review' })
  .addEdge('tools', 'model')
  .addConditionalEdges('review', afterReview, { model: 'model', act: 'act' })
  .addEdge('act', END)
  .compile();

export interface AgentRunResult {
  answer: string;
  model: string;
  state: State;
}

/**
 * Run the graph once. `onEvent` receives the live events (chat); a background run passes none. Throws on Stop or
 * on a model failure the self-healing could not recover — the caller records the answer as partial.
 */
export async function runAgent(
  ctx: RunContext,
  userContent: MimoMessage[],
  onEvent?: (e: AgentEvent) => void
): Promise<AgentRunResult> {
  let final: State | null = null;
  const stream = await graph.stream(
    { messages: userContent },
    {
      streamMode: ['custom', 'values'],
      configurable: { ctx },
      signal: ctx.signal,
      // prepare + (model + tools) × rounds + review retries + act
      recursionLimit: MAX_ROUNDS * 2 + 12,
    }
  );
  for await (const chunk of stream as AsyncIterable<[string, unknown]>) {
    const [mode, data] = chunk;
    if (mode === 'custom') onEvent?.(data as AgentEvent);
    else if (mode === 'values') final = data as State;
  }
  if (!final) throw new Error('The agent produced no result.');
  return { answer: final.answer, model: final.modelUsed || ctx.model, state: final };
}

/** The user turn: earlier thread lines as context, then the new message (+ screenshots). */
export function userTurn(opts: { history: string[]; message: string; images?: string[] }): MimoMessage[] {
  const text = [
    ...(opts.history.length ? ['Earlier in today\'s thread (oldest first):', ...opts.history, ''] : []),
    opts.images?.length ? `${imageRules(opts.images.length)}\n\n${opts.message}` : opts.message,
  ].join('\n');
  if (!opts.images?.length) return [{ role: 'user', content: text }];
  return [
    {
      role: 'user',
      content: [{ type: 'text', text }, ...opts.images.map((url) => ({ type: 'image_url' as const, image_url: { url } }))],
    },
  ];
}
