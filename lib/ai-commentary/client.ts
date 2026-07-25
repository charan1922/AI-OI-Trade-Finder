/**
 * Xiaomi MiMo client — OpenAI-compatible, so we reuse the existing `openai`
 * SDK pointed at MiMo's base URL (no new dependency). Powers the
 * /trade-commentary narration of the deterministic scan picks.
 *
 * mimo-v2.5-pro is a REASONING model: its thinking goes to
 * `message.reasoning_content` and the user-facing answer to `message.content`.
 * Callers must budget enough max_tokens for reasoning + answer and read
 * `content` (never assume the first tokens are the answer).
 */
import OpenAI from 'openai';
import { env, hasMimo } from '@/lib/env';
import type { MimoModel } from '@/lib/auto-trade/types';

export const MIMO_MODELS = ['mimo-v2.5', 'mimo-v2.5-pro'] as const satisfies readonly MimoModel[];
export const MIMO_DEFAULT_MODEL: MimoModel = 'mimo-v2.5-pro';

export function isAllowedMimoModel(value: string | null | undefined): value is MimoModel {
  return MIMO_MODELS.includes(value as MimoModel);
}

/** Runtime setting wins; an existing valid env choice seeds deployments that
 * have not stored the new setting yet. Unknown identifiers fail explicitly. */
export function resolveMimoModel(
  runtimeModel?: string | null,
  environmentModel?: string | null
): MimoModel {
  const selected = runtimeModel?.trim() || environmentModel?.trim() || MIMO_DEFAULT_MODEL;
  if (!isAllowedMimoModel(selected)) {
    throw new Error(`Unsupported MiMo model "${selected}". Allowed: ${MIMO_MODELS.join(', ')}`);
  }
  return selected;
}

export function getMimoModel(runtimeModel?: string | null): MimoModel {
  return resolveMimoModel(runtimeModel, env.MIMO_MODEL);
}

/** Build a configured MiMo client. Throws a clear error if unconfigured. */
export function getMimoClient(): OpenAI {
  if (!hasMimo()) {
    throw new Error('MiMo is not configured. Set MIMO_API_KEY and MIMO_BASE_URL in .env.local.');
  }
  return new OpenAI({
    apiKey: env.MIMO_API_KEY,
    baseURL: env.MIMO_BASE_URL,
    maxRetries: 1,
  });
}
