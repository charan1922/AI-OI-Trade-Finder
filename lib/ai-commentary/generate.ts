/**
 * Grounded commentary over a deterministic /trade-suggest scan result.
 *
 * The scan does the math; the model ONLY narrates the numbers it's given — it
 * never invents prices, Greeks, or probabilities (same grounding rule as the
 * Trade Assistant). We pass a trimmed, real-numbers-only view of the result and
 * ask for a short, scannable market read.
 */
import type { SuggestResponse } from '@/lib/trade-suggest/types';
import { getMimoClient, getMimoModel } from './client';

const SYSTEM = [
  'You are a concise Indian F&O options desk assistant. You are given the JSON output of a',
  'deterministic intraday options scanner (R-Factor + open-interest urgency + opening-range',
  'breakout). Write a SHORT market read for the trader.',
  '',
  'Hard rules:',
  '- Use ONLY numbers present in the JSON. Never invent premiums, Greeks, win-rates or targets.',
  '- If there are no suggestions, say so plainly and summarise why (the gated reasons / breadth).',
  '- Be specific and scannable. No hype, no financial-advice disclaimers, no preamble.',
  '- Max ~120 words. Plain text, short lines or a tight bullet list.',
].join('\n');

/** Trim the scan result to the fields worth narrating (keeps the prompt small
 *  and the grounding tight). */
function trimForPrompt(r: SuggestResponse): unknown {
  return {
    window: r.window,
    scanned: r.scanned,
    gated: r.gated,
    tilt: r.tilt,
    suggestions: (r.suggestions ?? []).map((s) => ({
      symbol: s.symbol,
      direction: s.direction,
      side: s.option?.optionType ?? (s.direction === 'bullish' ? 'CE' : 'PE'),
      strike: s.option?.strike ?? null,
      score: s.score,
      rFactor: s.rFactor,
      confidence: s.rFactorConfidence,
      oiLevel: s.oiLevel,
      orBreakout: s.orBreakout,
      entrySpot: s.plan.entrySpot,
      slSpot: s.plan.slSpot,
      targetSpot: s.plan.targetSpot,
      premium: s.option?.premium?.ltp ?? null,
      perLotCost: s.option?.premium?.perLotCost ?? null,
      reasons: s.reasons,
    })),
  };
}

export interface CommentaryResult {
  text: string;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
}

/**
 * Generate the narration. Budgets enough tokens for the reasoning model's
 * thinking + the answer, and reads `content` (the answer), never the reasoning.
 * Throws on API failure — the caller decides whether to swallow it.
 */
export async function generateCommentary(result: SuggestResponse): Promise<CommentaryResult> {
  const client = getMimoClient();
  const model = getMimoModel();
  const resp = await client.chat.completions.create(
    {
      model,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: JSON.stringify(trimForPrompt(result)) },
      ],
      temperature: 0.3,
      // Reasoning model: leave headroom for reasoning_content + the ~120-word answer.
      max_tokens: 1600,
    },
    { timeout: 90_000 },
  );
  const text = (resp.choices?.[0]?.message?.content ?? '').trim();
  if (!text) throw new Error('MiMo returned empty content (reasoning may have consumed the token budget).');
  return {
    text,
    model,
    promptTokens: resp.usage?.prompt_tokens ?? null,
    completionTokens: resp.usage?.completion_tokens ?? null,
  };
}
