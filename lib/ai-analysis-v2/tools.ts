/**
 * AI Analysis v2 — every tool the agent has, and the executor the graph's `tools` node calls.
 *
 *   read        read_data (v2's own allowlisted reader), 4 Trade Assistant market tools (read-only)
 *   agent       load_skill, update_plan, ask_operator, propose_memory
 *   act         propose_action (runs AFTER the reply, per the operator's Auto / Ask switches — graph `act` node)
 *   background  start_watch, cancel_watch, list_watches, write_note
 *   check-in    notify_operator, schedule_next_check (only on a self-paced check-in)
 *
 * `get_live_suggestions` is deliberately NOT offered: it runs and persists a new scan as a side effect.
 */

import { executeTool as executeAssistantTool, TOOL_DEFS as ASSISTANT_TOOL_DEFS } from '@/lib/ai-assistant/tools';
import type { NeutralToolDef } from '@/lib/auto-trade/tools/defs';
import { MAX_PROPOSALS, PROPOSE_ACTION_TOOL, proposeAction } from './actions';
import { MEMORY_MAX_CHARS, proposeMemory } from './background-store';
import { BACKGROUND_TOOL_DEFS, BACKGROUND_TOOL_NAMES, executeBackgroundTool } from './background-tools';
import { readData, READ_DATA_TOOL, toIst } from './data';
import { executeHeartbeatTool, HEARTBEAT_TOOL_DEFS, HEARTBEAT_TOOL_NAMES, type HeartbeatDecision } from './heartbeat';
import { LOAD_SKILL_TOOL, loadSkillBody } from './skills';
import type { PlanStep, V2Action } from './types';

const MARKET_TOOLS = new Set(['get_symbol_snapshot', 'get_market_pulse', 'get_suggestion_performance', 'get_eod_leaderboard']);

const marketToolDefs: NeutralToolDef[] = ASSISTANT_TOOL_DEFS.flatMap((t) =>
  t.type === 'function' && MARKET_TOOLS.has(t.name)
    ? [{ name: t.name, description: t.description ?? '', parameters: (t.parameters ?? {}) as Record<string, unknown> }]
    : []
);

const AGENT_TOOL_DEFS: NeutralToolDef[] = [
  {
    name: 'update_plan',
    description:
      'Show the operator your step plan for this turn (pending → in_progress → done). Once at the start of a 3+ step job, once at the end. Steps ≤ 8 words.',
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: { title: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'done'] } },
            required: ['title', 'status'],
          },
        },
      },
      required: ['steps'],
    },
  },
  {
    name: 'ask_operator',
    description:
      'Ask ONE follow-up question instead of guessing (which stock? exit or tighten?). 2–4 short tap-able options; their tap arrives as their next message. Then end your turn with one line.',
    parameters: {
      type: 'object',
      properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4 } },
      required: ['question', 'options'],
    },
  },
  {
    name: 'propose_memory',
    description: `Propose ONE thing to remember across days (≤ ${MEMORY_MAX_CHARS} chars). lesson = a mistake you made or a better way to work; preference = how the operator wants things. NEVER prices, levels, positions or anything that goes stale. Saved only when the operator taps Save.`,
    parameters: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['lesson', 'preference'] }, text: { type: 'string' } },
      required: ['kind', 'text'],
    },
  },
];

/** What one turn collected from its tools (the answer's record + what `act` runs). */
export interface TurnState {
  plan: PlanStep[] | null;
  question: { text: string; options: string[] } | null;
  memories: number[];
  skills: string[];
  proposals: { action: V2Action; description: string }[];
  /** Only on a self-paced check-in. */
  heartbeat: HeartbeatDecision | null;
}

export function newTurnState(heartbeat: HeartbeatDecision | null = null): TurnState {
  return { plan: null, question: null, memories: [], skills: [], proposals: [], heartbeat };
}

export function toolDefs(opts: { background: boolean; checkIn: boolean }): NeutralToolDef[] {
  return [
    READ_DATA_TOOL,
    ...marketToolDefs,
    LOAD_SKILL_TOOL,
    ...AGENT_TOOL_DEFS,
    PROPOSE_ACTION_TOOL,
    ...(opts.background ? BACKGROUND_TOOL_DEFS : []),
    ...(opts.checkIn ? HEARTBEAT_TOOL_DEFS : []),
  ];
}

export interface ToolRun {
  /** Sent back to the model. */
  output: unknown;
  ok: boolean;
  /** One line for the page. */
  detail: string;
}

/** Compact "key: value" form of the arguments — the step's IN line. */
export function readableArgs(args: Record<string, unknown>): string | null {
  const parts = Object.entries(args).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  const s = parts.join(' · ');
  return s ? (s.length > 160 ? `${s.slice(0, 157)}…` : s) : null;
}

const STEP_TITLES: Record<string, string> = {
  read_data: 'Read',
  get_symbol_snapshot: 'Stock snapshot',
  get_market_pulse: 'NSE market pulse',
  get_suggestion_performance: 'Suggestion performance',
  get_eod_leaderboard: 'End-of-day leaderboard',
  load_skill: 'Load skill',
  update_plan: 'Plan',
  ask_operator: 'Ask you',
  propose_memory: 'Propose a memory',
  propose_action: 'Prepare action',
  start_watch: 'Start watch',
  cancel_watch: 'Cancel watch',
  list_watches: 'List watches',
  write_note: 'Note',
  notify_operator: 'Decide to post',
  schedule_next_check: 'Schedule next check',
};

export function stepTitle(name: string, args: Record<string, unknown>): string {
  const base = STEP_TITLES[name] ?? name.replace(/_/g, ' ');
  const what = typeof args.source === 'string' ? args.source : typeof args.symbol === 'string' ? args.symbol : typeof args.name === 'string' ? args.name : typeof args.kind === 'string' ? args.kind : null;
  return what ? `${base} · ${what.replace(/_/g, ' ')}` : base;
}

/** Tools whose step is bookkeeping (shown elsewhere: plan, skill chip, notebook, memory), not "work". */
export const QUIET_TOOLS: ReadonlySet<string> = new Set(['update_plan', 'write_note', 'notify_operator', 'schedule_next_check']);

export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: { date: string; turn: TurnState; background: boolean }
): Promise<ToolRun> {
  const done = (output: unknown, ok: boolean, detail: string): ToolRun => ({ output, ok, detail: detail.slice(0, 200) });
  try {
    if (name === 'read_data') {
      const r = await readData(args);
      return done(r.result, r.ok, r.summary);
    }
    if (MARKET_TOOLS.has(name)) {
      const { result, trace } = await executeAssistantTool(name, args);
      return done(toIst(result), trace.ok, trace.summary);
    }
    if (name === 'load_skill') {
      const r = loadSkillBody(args.name);
      if (!r.ok) return done({ error: r.error }, false, r.error);
      if (!ctx.turn.skills.includes(r.skill.name)) ctx.turn.skills.push(r.skill.name);
      return done({ skill: r.skill.name, instructions: r.skill.body }, true, `loaded ${r.skill.name}`);
    }
    if (name === 'update_plan') {
      const raw = Array.isArray(args.steps) ? args.steps : [];
      const steps: PlanStep[] = raw
        .map((s) => s as { title?: unknown; status?: unknown })
        .filter((s) => typeof s.title === 'string' && s.title.trim())
        .slice(0, 8)
        .map((s) => ({
          title: String(s.title).trim().slice(0, 80),
          status: s.status === 'done' || s.status === 'in_progress' ? s.status : 'pending',
        }));
      ctx.turn.plan = steps;
      return done({ ok: true, shown: steps.length }, true, `plan ${steps.filter((s) => s.status === 'done').length}/${steps.length} done`);
    }
    if (name === 'ask_operator') {
      const text = typeof args.question === 'string' ? args.question.trim().slice(0, 200) : '';
      const options = (Array.isArray(args.options) ? args.options : [])
        .filter((o): o is string => typeof o === 'string' && o.trim().length > 0)
        .map((o) => o.trim().slice(0, 60))
        .slice(0, 4);
      if (!text || options.length < 2) return done({ asked: false, error: 'need a question and 2–4 options' }, false, 'bad question');
      ctx.turn.question = { text, options };
      return done({ asked: true, note: 'Shown as tap-able options under your reply. End your turn now with one line.' }, true, `asked: ${text}`);
    }
    if (name === 'propose_memory') {
      const r = await proposeMemory(args.kind === 'preference' ? 'preference' : 'lesson', typeof args.text === 'string' ? args.text : '');
      if (!r.ok) return done({ proposed: false, error: r.error }, false, r.error);
      ctx.turn.memories.push(r.memory.id);
      return done({ proposed: true, note: 'Waiting for the operator to tap Save — say so in one line; it is not remembered yet.' }, true, `proposed: ${r.memory.text}`);
    }
    if (name === 'propose_action') {
      if (ctx.turn.proposals.length >= MAX_PROPOSALS) return done({ proposed: false, error: `At most ${MAX_PROPOSALS} actions per reply.` }, false, 'action cap reached');
      const p = await proposeAction(args);
      if (!p.ok) return done({ proposed: false, error: p.error }, false, p.error);
      ctx.turn.proposals.push({ action: p.action, description: p.description });
      return done(
        { proposed: true, card: p.description, note: 'It runs (AUTO) or shows a Confirm card (ASK) right after your reply, per the operator\'s switch. Never say it is done.' },
        true,
        p.description
      );
    }
    if (ctx.background && BACKGROUND_TOOL_NAMES.has(name)) {
      const { result, trace } = await executeBackgroundTool(ctx.date, name, args);
      return done(result, trace.ok, trace.summary);
    }
    if (ctx.turn.heartbeat && HEARTBEAT_TOOL_NAMES.has(name)) {
      const { result, trace } = executeHeartbeatTool(name, args, ctx.turn.heartbeat);
      return done(result, trace.ok, trace.summary);
    }
    return done({ error: `Tool ${name} is not available here.` }, false, `unavailable: ${name}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return done({ error: msg }, false, `${name} failed: ${msg}`);
  }
}
