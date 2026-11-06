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
import { buildSystemPrompt } from '@/lib/ai-assistant/system-prompt';
import { executeTool, TOOL_DEFS } from '@/lib/ai-assistant/tools';
import { runToolLoop } from '@/lib/auto-trade/decision/providers';
import { getAutoTradeSettings } from '@/lib/auto-trade/settings';
import type { NeutralToolDef } from '@/lib/auto-trade/tools/defs';
import type { AiProvider } from '@/lib/auto-trade/types';
import { hasMimo } from '@/lib/env';
import { proposeAction } from './act';
import { READ_APP_DATA_TOOL, readAppData } from './app-data';
import { ACTION_KINDS, type ChatAction, type ChatToolUse, describeToolUse, type OperatorMessage } from './format';

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
}): Promise<{
  text: string;
  provider: AiProvider;
  model: string;
  proposals: { action: ChatAction; description: string }[];
  /** What the AI checked — from the loop's own trace (no extra model call); stored as the audit record, not shown. */
  tools: ChatToolUse[];
}> {
  const { provider, mimoModel } = await chatProvider();
  const proposals: { action: ChatAction; description: string }[] = [];
  const result = await runToolLoop({
    provider,
    mimoModel,
    system: `${buildSystemPrompt(sessionInfo())}\n\n${opts.framing}`,
    user: transcript(opts.prior, opts.message),
    tools: [...CHAT_TOOLS, PROPOSE_ACTION_TOOL],
    execute: async (name, args) => {
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
        const result = {
          proposed: true,
          card: p.description,
          note: 'NOT done yet. A Confirm card is shown under your reply; it happens only when the operator taps Confirm. Tell them to tap it — never say it is done.',
        };
        return { result, trace: { name, args, ok: true, summary: p.description } };
      }
      if (name === READ_APP_DATA_TOOL.name) {
        const started = Date.now();
        const r = await readAppData(args);
        return { result: r.result, trace: { name, args, ok: r.ok, summary: r.summary, ms: Date.now() - started } };
      }
      const { result: data, trace } = await executeTool(name, args);
      return { result: data, trace: { name: trace.name, args: trace.args, ok: trace.ok, summary: trace.summary } };
    },
  });
  const tools = result.trace.map((t) => describeToolUse(t.name, t.args ?? {}, t.ok, t.summary));
  return { text: result.text || '(no reply produced)', provider, model: result.model, proposals, tools };
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
