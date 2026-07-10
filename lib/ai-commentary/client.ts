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

export const MIMO_DEFAULT_MODEL = 'mimo-v2.5-pro';

export function getMimoModel(): string {
  return env.MIMO_MODEL || MIMO_DEFAULT_MODEL;
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
