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
import { READ_APP_DATA_TOOL, readAppData } from './app-data';
import type { OperatorMessage } from './format';

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

export async function replyToOperator(opts: {
  message: string;
  prior: OperatorMessage[];
  framing: string;
}): Promise<{ text: string; provider: AiProvider; model: string }> {
  const { provider, mimoModel } = await chatProvider();
  const result = await runToolLoop({
    provider,
    mimoModel,
    system: `${buildSystemPrompt(sessionInfo())}\n\n${opts.framing}`,
    user: transcript(opts.prior, opts.message),
    tools: CHAT_TOOLS,
    execute: async (name, args) => {
      if (name === READ_APP_DATA_TOOL.name) {
        const started = Date.now();
        const r = await readAppData(args);
        return { result: r.result, trace: { name, args, ok: r.ok, summary: r.summary, ms: Date.now() - started } };
      }
      const { result: data, trace } = await executeTool(name, args);
      return { result: data, trace: { name: trace.name, args: trace.args, ok: trace.ok, summary: trace.summary } };
    },
  });
  return { text: result.text || '(no reply produced)', provider, model: result.model };
}
