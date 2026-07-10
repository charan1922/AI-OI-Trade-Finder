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
  "Trader's goal: net at least ₹5,000 profit on the day, trading ~one lot (₹50-60k capital).",
  'So you must PRIORITISE — every read, name ONE **Top pick to trade now** (or explicitly "stand aside"',
  'if nothing clears the bar). Pick the single setup with the cleanest path to that ₹5k goal:',
  'best conviction (high R-Factor + live OI build), trend/VWAP/sector ALL aligned, real room from',
  'entry→target vs the SL (wider reward-to-risk), and NOT extended/late. Persistence is signal —',
  'a name that held up across your prior loops outranks a brand-new flash. Say why it beats the rest',
  'in one line. Do NOT fabricate premium projections or rupee P&L; reason from the given spot levels,',
  'perLotCost, R-Factor, OI and alignment only.',
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
  'End-of-day retrospective: when window.active is false AND you have prior reads today, add a final',
  '**End of day** section — with hindsight over the day\'s picks, name which 1-2 trades would have been',
  'the best to have taken toward the ₹5k goal and why (which held their trend/OI, cleared their target,',
  'vs which failed their SL or faded). Keep it grounded in the levels and factors you actually saw.',
  '',
  'Output structure (each stock renders directly under its own pick card, so keep them separable):',
  '1. MARKET HEADER first — 1-3 lines with NO ticker and NO ### heading: the scanner status line, then',
  '   bullets for scanned/gated, tilt, and suggestions count.',
  '2. Then ONE section per suggested stock, best first. Begin each with a heading that STARTS with the',
  '   ticker: "### TICKER — <verdict>" (e.g. "### OFSS — Top pick: broke out, OI live"). Put THAT stock\'s',
  '   evidence, ⚠ cautions, key levels and any now-vs-prior deltas inside its own section only.',
  '3. Finish with a "### Bottom line" section: the single best trade for the ₹5k goal, plus the',
  '   end-of-day retrospective when the window has closed. No per-stock detail belongs in header/bottom line.',
  '',
  'Hard rules:',
  '- Use ONLY numbers present in the JSON. Never invent premiums, Greeks, win-rates or targets.',
  '- If there are no suggestions, say so plainly and summarise why (the gated reasons / breadth).',
  '- Be specific and scannable. Markdown is fine (bold, bullets, ---). No hype, no disclaimers, no preamble.',
  '- Prefer compact inline deltas over tables — e.g. "R-Factor 4.02↑ from 3.88", "Entry 11,593 (was 11,474)".',
  '  Only use a markdown table if truly needed and keep it to ≤3 narrow columns.',
  '- Order the stock sections best-first (the Top pick is the first section). Max ~220 words.',
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
      // Reasoning model: reasoning_content is billed against this budget too, so
      // leave generous headroom — the richer top-pick + retrospective prompt needs
      // room for the thinking AND the ~220-word answer, else `content` comes back empty.
      max_tokens: 3200,
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
