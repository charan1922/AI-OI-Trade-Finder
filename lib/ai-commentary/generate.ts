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
  'You are a concise Indian F&O options desk assistant giving a RUNNING intraday commentary',
  'for ONE trading day. Each turn you get the JSON output of a deterministic options scanner',
  '(R-Factor + open-interest urgency + opening-range breakout) plus your OWN earlier reads from',
  'today. Continue the conversation — do not start fresh each time.',
  '',
  'Continuity rules:',
  '- Build on your earlier reads: note what CHANGED since the last one — did a prior pick break out',
  '  or fail, hold or lose VWAP, is a coiled name still coiled? Call names NEW / repeat / dropped.',
  '- If nothing meaningfully changed, say so briefly instead of repeating the full list.',
  '',
  'For each suggestion, ALWAYS surface the evidence AND the cautions from its `factors`, flagged with ⚠:',
  '- ⚠ Supertrend disagrees when factors.supertrendAligned is false (misaligned picks went 0/3 on replay).',
  '- ⚠ below/against VWAP when factors.vwapAligned is false.',
  '- ⚠ fighting sector when factors.sectorAligned is false (note factors.sectorPct).',
  '- ⚠ still inside opening range when orBreakout is false; ⚠ late to chase when extended is true.',
  '- ⚠ OI unwinding when factors.combinedOiSlope30m < 0 (was building earlier); positive = live build.',
  '  Confirmations (no ⚠): Supertrend+VWAP agree, sector agrees, on OI-spurt list, OI building.',
  '',
  'Hard rules:',
  '- Use ONLY numbers present in the JSON. Never invent premiums, Greeks, win-rates or targets.',
  '- If there are no suggestions, say so plainly and summarise why (the gated reasons / breadth).',
  '- Be specific and scannable. Markdown is fine (bold, bullets, ---). No hype, no disclaimers, no preamble.',
  '- Max ~180 words (the cautions are worth the space).',
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
      oiUrgency: s.oiUrgency,
      orBreakout: s.orBreakout,
      extended: s.extended, // already ran ≥3% from open — "late to chase" caution
      entrySpot: s.plan.entrySpot,
      slSpot: s.plan.slSpot,
      targetSpot: s.plan.targetSpot,
      premium: s.option?.premium?.ltp ?? null,
      perLotCost: s.option?.premium?.perLotCost ?? null,
      // Evidence/caution factors — the ⚠ signals (Supertrend, VWAP, sector, OI rate).
      factors: s.factors && {
        vwapAligned: s.factors.vwapAligned,
        supertrend: s.factors.supertrend,
        supertrendAligned: s.factors.supertrendAligned,
        atrPct: s.factors.atrPct,
        eqTurnoverRatio: s.factors.eqTurnoverRatio,
        combinedOiLevel: s.factors.combinedOiLevel,
        combinedOiSlope30m: s.factors.combinedOiSlope30m,
        onOiSpurtList: s.factors.onOiSpurtList,
        sectorPct: s.factors.sectorPct,
        sectorAligned: s.factors.sectorAligned,
      },
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
 * Generate the narration as the next turn of the day's running conversation.
 * `priorReads` are today's earlier commentary texts, OLDEST first — passed as
 * prior assistant turns so the model builds on them (references what changed,
 * marks names new/held/dropped). Budgets enough tokens for the reasoning model's
 * thinking + the answer, and reads `content` (the answer), never the reasoning.
 * Throws on API failure — the caller decides whether to swallow it.
 */
export async function generateCommentary(
  result: SuggestResponse,
  priorReads: string[] = [],
): Promise<CommentaryResult> {
  const client = getMimoClient();
  const model = getMimoModel();
  // Cap the carried history so the prompt stays small (the last few reads hold
  // the relevant intraday context; older ones are summarised by those).
  const recent = priorReads.slice(-6);
  const priorTurns = recent.map((text) => ({ role: 'assistant' as const, content: text }));
  const resp = await client.chat.completions.create(
    {
      model,
      messages: [
        { role: 'system', content: SYSTEM },
        ...priorTurns,
        {
          role: 'user',
          content:
            (recent.length ? 'Latest scan — continue the running commentary:\n' : 'First scan of the day:\n') +
            JSON.stringify(trimForPrompt(result)),
        },
      ],
      temperature: 0.3,
      // Reasoning model: leave headroom for reasoning_content + the ~140-word answer.
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
