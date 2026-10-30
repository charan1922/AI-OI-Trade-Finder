/**
 * The AI's reply in the operator chat on /trade-commentary.
 *
 * It answers with the SAME provider the auto-trader is configured to decide
 * with (auto-trade setting `aiProvider`: azure | mimo), so the thread has one
 * AI rather than a commentary model on one side and a different chat model on
 * the other. It uses the Trade Assistant's READ-ONLY market tools
 * (lib/ai-assistant/tools.ts) through the provider-agnostic tool loop; it has
 * no order tools at all, so a chat reply can never place, change or cancel a
 * trade — only the auto-trader's gated pass can.
 */

import { sessionInfo } from '@/lib/ai-assistant/assistant';
import { hasAzureConfig } from '@/lib/ai-assistant/azure-client';
import { buildSystemPrompt, sessionBlock } from '@/lib/ai-assistant/system-prompt';
import { executeTool, TOOL_DEFS } from '@/lib/ai-assistant/tools';
import { type LoopStepEvent, runToolLoop } from '@/lib/auto-trade/decision/providers';
import { getAutoTradeSettings } from '@/lib/auto-trade/settings';
import type { NeutralToolDef } from '@/lib/auto-trade/tools/defs';
import type { AiProvider } from '@/lib/auto-trade/types';
import { hasMimo } from '@/lib/env';
import { proposeAction } from './act';
import { READ_APP_DATA_TOOL, readAppData } from './app-data';
import type { AutoActions } from './auto-act';
import { executeHeartbeatTool, HEARTBEAT_TOOL_DEFS, HEARTBEAT_TOOL_NAMES, type HeartbeatDecision } from './heartbeat';
import { BACKGROUND_TOOL_DEFS, BACKGROUND_TOOL_NAMES, executeBackgroundTool } from './background-tools';
import { AGENT_TOOL_DEFS, AGENT_TOOL_NAMES, type AgentTurnState, agentFraming, executeAgentTool, memoryBlock } from './skills';
import { type ChatMemory, savedMemories } from './background-store';
import { finishTurn, isTurnCancelled, noteStep, recordStep, startTurn, turnSignal } from './progress';
import {
  ACTION_KINDS,
  type ChatAction,
  type ChatToolUse,
  describeToolUse,
  type OperatorMessage,
  type ReplyMeta,
} from './format';

/** Prior turns replayed to the model — enough to follow the thread, not to flood it. */
const HISTORY_TURNS = 8;
const HISTORY_CHARS = 1500;

/** The Trade Assistant's tools + read_app_data (every page's data, allowlisted). All read-only. */
const CHAT_TOOLS: NeutralToolDef[] = [
  ...TOOL_DEFS.flatMap((t) =>
    t.type === 'function'
      ? [
          {
            name: t.name,
            description: t.description ?? '',
            parameters: (t.parameters ?? {}) as Record<string, unknown>,
          },
        ]
      : []
  ),
  READ_APP_DATA_TOOL,
];

export function providerConfigured(provider: AiProvider): boolean {
  return provider === 'mimo' ? hasMimo() : hasAzureConfig();
}

/** The provider the chat will reply with — the auto-trader's configured decision AI. */
export async function chatProvider(): Promise<{ provider: AiProvider; mimoModel: string; configured: boolean }> {
  const settings = await getAutoTradeSettings();
  return {
    provider: settings.aiProvider,
    mimoModel: settings.mimoModel,
    configured: providerConfigured(settings.aiProvider),
  };
}

function transcript(prior: OperatorMessage[], message: string): string {
  const turns = prior
    .slice(-HISTORY_TURNS)
    .map((m) => `${m.role === 'user' ? 'OPERATOR' : 'YOU'}: ${m.content.slice(0, HISTORY_CHARS)}`);
  return [
    ...(turns.length > 0 ? ['Conversation so far today (oldest first):', ...turns, ''] : []),
    "OPERATOR's new message:",
    message,
  ].join('\n');
}

/** At most this many Confirm cards per reply — a fix + the trade, not a menu. */
const MAX_PROPOSALS = 3;

export async function replyToOperator(opts: {
  message: string;
  prior: OperatorMessage[];
  framing: string;
  /** Commentary v2 Background ON: adds the watch/notebook tools for this IST date. Absent = today's tools. */
  background?: { date: string };
  /** A woken turn has no operator message — it passes its own user prompt instead of the transcript. */
  userOverride?: string;
  /** Commentary v2: skills, plan, follow-up questions, memory, thinking + self-healing. Absent = v1's chat exactly. */
  agentic?: boolean;
  /** Screenshots the operator attached to THIS message (data URLs). Sent to MiMo only. */
  images?: string[];
  /** Commentary v2 answers with its own MiMo model (lib/operator-chat/background-store.ts getChatModel). */
  model?: { provider: AiProvider; mimoModel: string };
  /** Commentary v2: live progress id the page polls (lib/operator-chat/progress.ts). */
  turnId?: string;
  /** Commentary v2 "Think" switch — false skips the thinking attempt (cheaper, faster). Default on. */
  thinking?: boolean;
  /** Commentary v2: the per-message part of the framing (latest read, watches, notebook). Placed LAST in the
   *  system prompt so everything before it is an identical, cacheable prefix. */
  context?: string;
  /** Commentary v2: action kinds that run by themselves after the reply (lib/operator-chat/auto-act.ts). */
  autoActions?: AutoActions;
  /** Commentary v2 self-paced check-in: adds stay_quiet / schedule_next_check, which fill this decision. */
  heartbeat?: HeartbeatDecision;
}): Promise<{
  text: string;
  provider: AiProvider;
  model: string;
  proposals: { action: ChatAction; description: string }[];
  /** What the AI checked — from the loop's own trace (no extra model call); stored as the audit record, not shown. */
  tools: ChatToolUse[];
  /** Timing + token usage (audit record; shown on Commentary v2). */
  meta: ReplyMeta;
}> {
  const { provider, mimoModel } = opts.model ?? (await chatProvider());
  const started = Date.now();
  const agentic = opts.agentic === true;
  const turnId = opts.turnId;
  if (turnId) startTurn(turnId);
  const memories = agentic ? await savedMemories() : [];

  // Self-healing (v2 only): thinking ON first; if that call fails, retry with thinking OFF; if THAT fails on
  // Pro, retry once on Flash. Each recovery is recorded and shown on the reply. v1 makes exactly one attempt.
  const think = opts.thinking !== false;
  const attempts: { thinking: boolean; mimoModel: string; why?: string }[] = agentic && provider === 'mimo'
    ? [
        ...(think ? [{ thinking: true, mimoModel }] : []),
        { thinking: false, mimoModel, ...(think ? { why: 'thinking off' } : {}) },
        ...(mimoModel !== FALLBACK_CHAT_MODEL ? [{ thinking: false, mimoModel: FALLBACK_CHAT_MODEL, why: `fell back to ${FALLBACK_CHAT_MODEL}` }] : []),
      ]
    : [{ thinking: false, mimoModel }];
  const recovered: string[] = [];
  let lastError: unknown = null;
  try {
    for (const attempt of attempts) {
      if (attempt.why && turnId) noteStep(turnId, `Self-healing: retrying with ${attempt.why}`, 'running');
      try {
        const out = await runOnce(opts, { provider, agentic, memories, turnId, ...attempt });
        out.meta.ms = Date.now() - started;
        if (recovered.length) out.meta.recovered = recovered;
        return out;
      } catch (err) {
        lastError = err;
        // The operator pressed Stop — do not "heal" that by trying again.
        if (turnId && isTurnCancelled(turnId)) throw new Error('Stopped by the operator.');
        const msg = (err as Error).message.slice(0, 160);
        recovered.push(`${attempt.thinking ? 'thinking on' : 'thinking off'} · ${attempt.mimoModel} failed: ${msg}`);
        if (turnId) noteStep(turnId, `Attempt failed: ${msg}`, 'error');
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  } finally {
    if (turnId) finishTurn(turnId);
  }
}

/** The lower-cost tier v2 falls back to when its model keeps failing. */
const FALLBACK_CHAT_MODEL = 'mimo-v2.6-flash';

/** Compact IN of a tool call for the page (never the raw result). */
function compactArgs(args: Record<string, unknown>): string | null {
  const keys = Object.keys(args);
  if (keys.length === 0) return null;
  const s = JSON.stringify(args);
  return s.length > 200 ? `${s.slice(0, 197)}…` : s;
}

async function runOnce(
  opts: Parameters<typeof replyToOperator>[0],
  run: { provider: AiProvider; mimoModel: string; thinking: boolean; agentic: boolean; memories: ChatMemory[]; turnId?: string }
) {
  const { provider, agentic } = run;
  const background = opts.background;
  const images = opts.images ?? [];
  const canSee = provider === 'mimo';
  const proposals: { action: ChatAction; description: string }[] = [];
  const turn: AgentTurnState = { plan: null, question: null, memories: [] };
  // Prompt order (v2): everything identical across calls FIRST, then the live context — MiMo caches an
  // identical prefix automatically (~50× cheaper input on a hit). v1 keeps its original single block.
  const system = agentic
    ? [
        buildSystemPrompt(sessionInfo(), { sessionLast: true }),
        opts.framing,
        agentFraming(),
        '## Live context (changes every message — kept last so everything above is cacheable)',
        sessionBlock(sessionInfo()),
        memoryBlock(run.memories),
        ...(opts.context ? [opts.context] : []),
        ...(images.length ? [imageRules(images.length, canSee)] : []),
      ].join('\n\n')
    : [
        `${buildSystemPrompt(sessionInfo())}\n\n${opts.framing}${opts.context ? `\n\n${opts.context}` : ''}`,
        ...(images.length ? [imageRules(images.length, canSee)] : []),
      ].join('\n\n');
  const result = await runToolLoop({
    provider,
    mimoModel: run.mimoModel,
    system,
    user: opts.userOverride ?? transcript(opts.prior, opts.message),
    tools: [
      ...CHAT_TOOLS,
      PROPOSE_ACTION_TOOL,
      ...(background ? BACKGROUND_TOOL_DEFS : []),
      ...(agentic ? AGENT_TOOL_DEFS : []),
      ...(opts.heartbeat ? HEARTBEAT_TOOL_DEFS : []),
    ],
    ...(agentic ? { maxSteps: AGENTIC_MAX_STEPS } : {}),
    ...(canSee && images.length ? { images } : {}),
    // Think on the planning round only: real reasoning, without paying 10–20s of thinking on every later round.
    ...(run.thinking ? { thinking: 'first' as const } : {}),
    ...(run.turnId ? { onStep: (e: LoopStepEvent) => recordStep(run.turnId as string, e) } : {}),
    ...(run.turnId && turnSignal(run.turnId) ? { signal: turnSignal(run.turnId) } : {}),
    execute: async (name, args) => {
      if (background && BACKGROUND_TOOL_NAMES.has(name)) return executeBackgroundTool(background.date, name, args);
      if (agentic && AGENT_TOOL_NAMES.has(name)) return executeAgentTool(name, args, turn);
      if (opts.heartbeat && HEARTBEAT_TOOL_NAMES.has(name)) return executeHeartbeatTool(name, args, opts.heartbeat);
      if (name === PROPOSE_ACTION_TOOL.name) {
        if (proposals.length >= MAX_PROPOSALS) {
          const result = { proposed: false, error: `At most ${MAX_PROPOSALS} actions per reply.` };
          return { result, trace: { name, args, ok: false, summary: 'proposal cap reached' } };
        }
        const p = await proposeAction(args);
        if (!p.ok) {
          return { result: { proposed: false, error: p.error }, trace: { name, args, ok: false, summary: p.error } };
        }
        proposals.push({ action: p.action, description: p.description });
        const runsByItself = opts.autoActions?.[p.action.kind] === true;
        const result = {
          proposed: true,
          card: p.description,
          note: runsByItself
            ? 'AUTO: this runs by itself right after your reply, through every risk gate; its outcome is posted below your reply. Say you are doing it now — never say it is done, never ask for a Confirm tap.'
            : 'NOT done yet. A Confirm card is shown under your reply; it happens only when the operator taps Confirm. Tell them to tap it — never say it is done.',
        };
        return { result, trace: { name, args, ok: true, summary: p.description } };
      }
      if (name === READ_APP_DATA_TOOL.name) {
        const started = Date.now();
        const r = await readAppData(args, agentic ? { maxChars: AGENTIC_READ_CHARS } : {});
        return { result: r.result, trace: { name, args, ok: r.ok, summary: r.summary, ms: Date.now() - started } };
      }
      const { result: data, trace } = await executeTool(name, args);
      return { result: data, trace: { name: trace.name, args: trace.args, ok: trace.ok, summary: trace.summary } };
    },
  });
  const tools = result.trace.map((t) => ({
    ...describeToolUse(t.name, t.args ?? {}, t.ok, t.summary),
    ...(agentic ? { input: compactArgs(t.args ?? {}) } : {}),
  }));
  const meta: ReplyMeta = {
    ms: 0,
    spans: result.spans.map((s) => ({ name: s.name, ms: s.ms })),
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    ...(agentic
      ? {
          plan: turn.plan,
          skills: [
            ...new Set(
              result.trace.filter((t) => t.name === 'use_skill' && t.ok).map((t) => String((t.args ?? {}).name))
            ),
          ],
          question: turn.question,
          memories: turn.memories,
          thinking: run.thinking,
          ...(result.reasoning?.length ? { reasoning: result.reasoning } : {}),
          ...(result.reasoningTokens != null ? { reasoningTokens: result.reasoningTokens } : {}),
          ...(result.cachedTokens != null ? { cachedTokens: result.cachedTokens } : {}),
        }
      : {}),
  };
  return { text: result.text || '(no reply produced)', provider, model: result.model, proposals, tools, meta };
}

/** An agentic turn loads a skill, keeps a plan and reads several sources — more room than a v1 reply,
 *  but every round re-sends the whole conversation, so the cap is also a token cap. */
const AGENTIC_MAX_STEPS = 12;
/** v2 reads are capped smaller than v1's 16k: each read is re-sent on every later round of the turn. */
const AGENTIC_READ_CHARS = 8_000;

/** What the model is told when the operator attached screenshots: no reading-in, no stale numbers as live. */
function imageRules(n: number, canSee: boolean): string {
  if (!canSee) {
    return `The operator attached ${n} image(s), but this provider cannot receive images. Say plainly that you cannot see them and ask what they show. Never guess.`;
  }
  return [
    `## The operator attached ${n} screenshot(s) to this message`,
    '- Describe only what is actually visible. If something is cut off, blurry or unreadable, say so; never fill it in.',
    '- Numbers in a screenshot are THAT screenshot\'s, from when it was taken: say "in your screenshot" and check the live',
    '  value with a tool before advising on it. If the tool disagrees, say so and trust the live read.',
    '- Never claim a screenshot shows a stock, level or position you cannot point to in it.',
  ].join('\n');
}

const PROPOSE_ACTION_TOOL: NeutralToolDef = {
  name: 'propose_action',
  description: [
    "Put an action on a Confirm card under your reply. It runs ONLY when the operator taps Confirm, through the same gated code as the /auto-trade console. Use it whenever the operator asks you to DO something — don't send them to another page. kinds:",
    '- take_trade {symbol}: run the trader NOW with the operator\'s order to enter that stock (it must be an eligible scanner pick; every gate still applies). Use for "take X", "buy X", "enter X".',
    '- setting {key, value}: change a trader setting (same registry + limits as /auto-trade), e.g. key maxRiskPerLotRupees value 6000, dailyLossHaltRupees, maxTradesPerDay, maxSpreadPct, killSwitch true/false, mode off|paper|approval (never live).',
    '- exit {symbol}: exit an open position now at market.',
    '- move_stop {symbol, newSlSpot}: tighten the spot stop (tighten-only; inside the 0.35% noise band is refused).',
    '- approve / reject {symbol}: decide a pending approval (approve re-checks every gate on a fresh quote).',
    '- run_pass: run the trader now (fresh scan + full pass) without a specific order.',
    'If a gate would block what they asked (e.g. the per-lot risk is above maxRiskPerLotRupees), propose the setting fix AND the action in the same reply so one pair of taps gets it done — and say plainly what the fix changes for every future trade.',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: [...ACTION_KINDS] },
      symbol: { type: 'string' },
      key: { type: 'string' },
      value: { type: 'string' },
      newSlSpot: { type: 'number' },
    },
    required: ['kind'],
  },
};
