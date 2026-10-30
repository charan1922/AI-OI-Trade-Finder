/**
 * Commentary v2 SKILLS + the AI's own task plan — the agentic layer (Claude Code's Skill + TodoWrite
 * pattern). A skill is a named playbook the AI loads on demand with `use_skill`; it lists which REAL
 * tools to call and in what order, so the AI works the problem step by step instead of guessing.
 * `update_plan` lets it show its steps and tick them off; the page renders that plan in the reply.
 *
 * Skills only orchestrate tools that already exist (read-only reads, watches, Confirm cards). They add
 * no data source and no order path. Every skill ends the same way: say what you could NOT verify.
 */

import type { NeutralToolDef } from '@/lib/auto-trade/tools/defs';
import type { ToolTraceEntry } from '@/lib/auto-trade/types';
import { type ChatMemory, MEMORY_MAX_CHARS, proposeMemory } from './background-store';

export interface ChatSkill {
  name: string;
  /** One line — what the framing lists so the AI knows when to load it. */
  when: string;
  steps: string[];
}

const HONESTY = 'Finish by saying in one line what you could not verify (a failed read, stale data, a missing feed). Never fill a gap with a guess.';

export const CHAT_SKILLS: ChatSkill[] = [
  {
    name: 'review_position',
    when: 'the operator asks how an open position is doing, or a position watch fired',
    steps: [
      'read_app_data source auto_trade_today → the open trade: entry spot, spot stop, target, premium fill, mode.',
      'get_symbol_snapshot for that symbol → live spot and today\'s move.',
      'Work out R now = (spot − entry) ÷ (entry − stop), direction-aware, and the distance to the stop in %.',
      'Say HOLD / TIGHTEN / EXIT with the one reason that decides it. To act, propose_action (move_stop tighten-only, or exit) — never claim it is done.',
      'If Background is ON and no near_stop / position_r watch exists for it, start one and say so.',
    ],
  },
  {
    name: 'why_no_trade',
    when: 'the operator asks why nothing was taken / why no picks',
    steps: [
      'read_app_data source auto_trade_today → mode, kill switch, entries used vs cap, daily-loss halt, entry window.',
      'read_app_data source scan_verdicts → is the TF board fresh? how many names PICKED vs REJECTED, and the most common failed check.',
      'read_app_data source check_market_sideways → is the whole market stuck?',
      'Name the ONE binding reason first (e.g. "window closed", "board stale", "every name failed not-chasing"), then at most two supporting facts.',
    ],
  },
  {
    name: 'explain_rejection',
    when: 'the operator asks why a specific stock was not taken',
    steps: [
      'read_app_data source scan_verdicts → find the symbol: its TF rank, failedChecks, notEvaluable and why.',
      'If it is not on the board, say so — do not invent checks for it.',
      'Explain each failed check in plain English (what the check protects against), quote the "why" line as-is.',
      'Optionally get_symbol_snapshot to show the live move — label it as context, not as a reason the selector used.',
    ],
  },
  {
    name: 'market_regime',
    when: 'the operator asks about market direction, sideways/choppy, or "should I trade today"',
    steps: [
      'read_app_data source check_market_sideways → NIFTY opening-range width, breadth, share of stocks inside their range, stuck true/false/null.',
      'read_app_data source nifty_context → NIFTY trend/levels.',
      'read_app_data source sector_scope → which sectors lead and lag (TradeFinder numbers — use for direction/rank only).',
      'One verdict: trending up / trending down / sideways / can\'t tell, with the readings behind it. The trader decides entries, you advise.',
    ],
  },
  {
    name: 'set_up_watches',
    when: 'the operator asks you to keep an eye on things, or a new position opened',
    steps: [
      'list_watches → what already exists (never duplicate).',
      'read_app_data source auto_trade_today → open positions.',
      'For each open position: start_watch near_stop (0.3%) and position_r 1, unless they exist.',
      'For anything the operator named: start the matching typed watch; if no kind fits, say it needs a code change.',
      'Report exactly which watches you started and how often each is checked (60s; prices move every 5 min).',
    ],
  },
  {
    name: 'end_of_day_review',
    when: 'after the close, or the operator asks how the day went',
    steps: [
      'read_app_data source auto_trade_today → trades, exits, realised P&L.',
      'read_app_data source commentary → the trader\'s reads through the day (what it said vs what happened).',
      'get_suggestion_performance → how today\'s picks graded.',
      'Three lines: what worked, what did not, one thing to watch tomorrow. Numbers only from these reads.',
    ],
  },
  {
    name: 'read_screenshot',
    when: 'the operator attached a screenshot',
    steps: [
      'Describe only what is visible; say what is cut off or unreadable.',
      'Treat every number in it as the screenshot\'s (possibly stale): check the live value with a tool before advising.',
      'If the live read disagrees with the screenshot, say so and trust the live read.',
    ],
  },
];

export const SKILL_NAMES = CHAT_SKILLS.map((s) => s.name);

export interface PlanStep {
  title: string;
  status: 'pending' | 'in_progress' | 'done';
}

/** What one agentic turn collected from its own tools (the reply's audit record). */
export interface AgentTurnState {
  plan: PlanStep[] | null;
  question: { text: string; options: string[] } | null;
  memories: number[];
}

export const AGENT_TOOL_DEFS: NeutralToolDef[] = [
  {
    name: 'use_skill',
    description: `Load a playbook before a multi-step job. Skills: ${CHAT_SKILLS.map((s) => `${s.name} (${s.when})`).join('; ')}.`,
    parameters: { type: 'object', properties: { name: { type: 'string', enum: SKILL_NAMES } }, required: ['name'] },
  },
  {
    name: 'update_plan',
    description:
      'Show the operator your step plan for this turn and keep it current (pending → in_progress → done). Call it once at the start of a multi-step job and again as steps finish. Steps are short (≤ 8 words). Use only for jobs of 3+ steps.',
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
      'Ask the operator ONE follow-up question instead of guessing — when the request is ambiguous (which stock? which position? what level? exit or tighten?) or a decision is theirs. Give 2–4 short tap-able options. Then end your turn with a one-line reply; their tap arrives as their next message.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4 },
      },
      required: ['question', 'options'],
    },
  },
  {
    name: 'propose_memory',
    description: `Propose ONE thing to remember across days (≤ ${MEMORY_MAX_CHARS} chars). kind lesson = a mistake you made or a better way to work ("I called the board live when boardAtIST was null — check it first"); kind preference = how the operator wants things ("explain exits in rupees per lot"). NEVER prices, levels, positions or anything that goes stale. It is saved only if the operator taps Save on the page. Use it when the operator corrects you or states a lasting preference.`,
    parameters: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['lesson', 'preference'] }, text: { type: 'string' } },
      required: ['kind', 'text'],
    },
  },
];

export const AGENT_TOOL_NAMES: ReadonlySet<string> = new Set(AGENT_TOOL_DEFS.map((t) => t.name));

/** Saved long-term memory — changes rarely, so it sits in the live (end) part of the prompt. */
export function memoryBlock(memories: readonly ChatMemory[]): string {
  return [
    'Long-term memory (saved by the operator; lessons and preferences from earlier days — follow them):',
    ...(memories.length ? memories.map((m) => `- [${m.kind}] ${m.text}`) : ['- (none saved yet)']),
  ].join('\n');
}

/** Static framing for the agentic surface (v2): how to work and the skill index. Identical every call (cacheable). */
export function agentFraming(): string {
  return [
    '## How you work here (Commentary v2 — agentic)',
    'You work like an agent: for anything that needs more than one read, load the matching skill with',
    'use_skill, show your plan with update_plan, do the reads, tick the plan off, then answer. For a simple',
    'question just answer — no skill, no plan.',
    'YOUR FINAL MESSAGE IS THE ANSWER to the operator — complete, in plain English. Never reply "noted" or point',
    'to your notebook/plan instead of answering. write_note / update_plan / propose_memory are side work in the',
    'same round as your reads, never your last step.',
    'TOKENS COST MONEY — every round re-sends the whole conversation, so use as FEW rounds as possible:',
    '- Call tools in parallel: put use_skill, update_plan and every read you already know you need in ONE round.',
    '- update_plan at most twice: once at the start, once at the end. Never re-read a source you already have.',
    '- Ask for the narrowest read that answers it (a section, a symbol, a date).',
    'Your last update_plan (in the same round as your final reads, or just before answering) marks every step',
    'done — or still pending if you could not do it, and the answer says why. Never leave a step in_progress.',
    'Skills:',
    ...CHAT_SKILLS.map((s) => `- ${s.name}: when ${s.when}`),
    'Rules that never bend: every number comes from a tool you called THIS turn (or the operator\'s own',
    'message, labelled as theirs). No reasoning-in of missing data, no "probably", no invented levels. If a read',
    'fails, retry it ONCE (or use the skill\'s other source); if it still fails or the data is stale, say so and stop there.',
    '- Compare numbers exactly: "above/under/over the limit" must be arithmetically true (₹3,968 is OVER a ₹3,000',
    '  halt, not under). Never state a time, price or level you did not read this turn — say you don\'t have it.',
    '- Ambiguous request? ask_operator with 2–4 options instead of guessing.',
    '- The operator corrected you, or stated a lasting preference? propose_memory (they approve it on the page).',
  ].join('\n');
}

/** Executes the agentic tools. `turn` collects the plan / question / memory ids for the reply's audit record. */
export async function executeAgentTool(
  name: string,
  args: Record<string, unknown>,
  turn: AgentTurnState
): Promise<{ result: unknown; trace: ToolTraceEntry }> {
  if (name === 'ask_operator') {
    const text = typeof args.question === 'string' ? args.question.trim().slice(0, 200) : '';
    const options = (Array.isArray(args.options) ? args.options : [])
      .filter((o): o is string => typeof o === 'string' && o.trim().length > 0)
      .map((o) => o.trim().slice(0, 60))
      .slice(0, 4);
    if (!text || options.length < 2) {
      return { result: { asked: false, error: 'need a question and 2–4 options' }, trace: { name, args, ok: false, summary: 'bad question' } };
    }
    turn.question = { text, options };
    return {
      result: { asked: true, note: 'Shown as tap-able options under your reply. End your turn now with one line.' },
      trace: { name, args, ok: true, summary: `asked: ${text.slice(0, 80)}` },
    };
  }
  if (name === 'propose_memory') {
    const kind = args.kind === 'preference' ? 'preference' : 'lesson';
    const r = await proposeMemory(kind, typeof args.text === 'string' ? args.text : '');
    if (!r.ok) return { result: { proposed: false, error: r.error }, trace: { name, args, ok: false, summary: r.error } };
    turn.memories.push(r.memory.id);
    return {
      result: { proposed: true, note: 'Waiting for the operator to tap Save on the page — say so in one line; it is not remembered yet.' },
      trace: { name, args, ok: true, summary: `proposed ${kind}: ${r.memory.text.slice(0, 80)}` },
    };
  }
  if (name === 'use_skill') {
    const skill = CHAT_SKILLS.find((s) => s.name === args.name);
    if (!skill) {
      return {
        result: { error: `No skill "${String(args.name)}". Skills: ${SKILL_NAMES.join(', ')}` },
        trace: { name, args, ok: false, summary: `unknown skill ${String(args.name)}` },
      };
    }
    return {
      result: { skill: skill.name, steps: skill.steps, finally: HONESTY },
      trace: { name, args, ok: true, summary: `loaded skill ${skill.name}` },
    };
  }
  const raw = Array.isArray(args.steps) ? args.steps : [];
  const steps: PlanStep[] = raw
    .map((s) => s as { title?: unknown; status?: unknown })
    .filter((s) => typeof s.title === 'string' && s.title.trim())
    .slice(0, 8)
    .map((s) => ({
      title: String(s.title).trim().slice(0, 80),
      status: s.status === 'done' || s.status === 'in_progress' ? s.status : 'pending',
    }));
  turn.plan = steps;
  const done = steps.filter((s) => s.status === 'done').length;
  return { result: { ok: true, shown: steps.length }, trace: { name, args, ok: true, summary: `plan ${done}/${steps.length} done` } };
}
