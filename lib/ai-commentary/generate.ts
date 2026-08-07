/**
 * Grounded commentary over a deterministic /trade-suggest scan result.
 *
 * The scan does the math; the model ONLY narrates the numbers it's given — it
 * never invents prices, Greeks, or probabilities (same grounding rule as the
 * Trade Assistant). We pass a trimmed, real-numbers-only view of the result and
 * ask for a short, scannable market read.
 */
import { getNumberSetting } from '@/lib/config/feature-toggles';
import { minuteOfDayIST } from '@/lib/ist';
import type { SuggestResponse } from '@/lib/trade-suggest/types';
import { getMimoClient, getMimoModel } from './client';

/**
 * IST minute-of-day after which the read must stop pitching fresh entries and
 * spend its words on managing/exiting (default 12:30). Deterministic and
 * injected into the USER turn each read — the battle-tested system prompt
 * stays byte-identical. Runtime-tunable from /config
 * (COMMENTARY_ENTRY_CUTOFF_MIN).
 *
 * DESPITE THE NAME, THIS IS NOT COMMENTARY-ONLY. The auto-trade entry gate
 * folds the same setting into `hardEnd` (lib/auto-trade/risk/gates.ts), so it
 * hard-blocks new entry ORDERS on both the AI and human-approval paths — and
 * with no mode branch, so paper entries stop too, not just live ones. The
 * /trade-suggest scanner is the only thing genuinely unaffected — it keeps
 * surfacing candidates; the gate is what refuses to buy them. Renaming the key
 * would orphan the stored /config row, so the label carries the warning
 * instead. Change this value knowing it moves the money path.
 */
export const COMMENTARY_ENTRY_CUTOFF_MIN_DEFAULT = 12 * 60 + 30;

/** The exit-focus instruction for the user turn, or null before the cutoff.
 *  Prefers the scan's own clock (window.nowIST "HH:MM") over the wall clock so
 *  replays/tests stay deterministic. */
export async function commentaryTimeContext(nowIST?: string | null): Promise<string | null> {
  const cutoff = await getNumberSetting('COMMENTARY_ENTRY_CUTOFF_MIN', COMMENTARY_ENTRY_CUTOFF_MIN_DEFAULT).catch(
    () => COMMENTARY_ENTRY_CUTOFF_MIN_DEFAULT
  );
  const m = nowIST?.match(/^(\d{1,2}):(\d{2})/);
  const minutes = m ? Number(m[1]) * 60 + Number(m[2]) : minuteOfDayIST();
  if (minutes < cutoff) return null;
  const hh = String(Math.floor(cutoff / 60)).padStart(2, '0');
  const mm = String(cutoff % 60).padStart(2, '0');
  return (
    `TIME CONTEXT (deterministic, from code — overrides any earlier window guidance): it is past ${hh}:${mm} IST. ` +
    'Do NOT pitch fresh entries in this read, whatever the scanner surfaces — no TRADE NOW, no "tradeable until 14:30". ' +
    'Focus entirely on managing open positions (HOLD / MOVE SL / EXIT NOW); if flat, the Bottom line is that staying flat is the plan.'
  );
}

/**
 * TODAY's real scanner window, taken from the scan result (engine.ts resolves
 * WINDOW_START_MIN/WINDOW_END_MIN from /config on every run, so this is already
 * the operator's live setting).
 *
 * WHY this exists: the battle-tested system prompt names the DEFAULT window
 * ("09:40–11:00") as literal prose, and the model quotes those numbers back
 * instead of reading window.closesAt from the JSON — on 2026-07-17 the operator
 * had widened the window to 12:15 and the read still announced "Entry window
 * closed at 11:00", going silent on entries the code would still have allowed.
 * Same override pattern as commentaryTimeContext / EXECUTION TRUTH:
 * deterministic fact in the USER turn, system prompt stays byte-identical.
 * Null when a scan carries no window (behaviour then is exactly as before).
 */
export function commentaryWindowContext(window: SuggestResponse['window'] | null | undefined): string | null {
  if (!window?.opensAt || !window?.closesAt) return null;
  return (
    'WINDOW CONTEXT (deterministic, from code — overrides EVERY window time named in your instructions): ' +
    `today's scanner window is ${window.opensAt}–${window.closesAt} and it is ${window.active ? 'ACTIVE' : 'CLOSED'} right now. ` +
    'The 09:40–11:00 in your instructions is only the default example — never quote it, and never announce the ' +
    `window closed at any time other than ${window.closesAt}. While the window is ACTIVE a setup meeting the full ` +
    'bar is tradeable; the TIME CONTEXT line, when present, is the ONLY thing that stops fresh entries.'
  );
}

/**
 * The BATTLE-TESTED page contract — output format + hard rules, benched via
 * scripts/dry-run-commentary.ts and lived through real trading days. Exported
 * so the auto-trader's merged reads (lib/auto-trade/decision/system-prompt.ts)
 * compose from THE SAME blocks instead of a re-worded copy: one source of
 * truth, and /trade-commentary renders identically whichever brain wrote the
 * row. Do NOT edit these lines without re-running the dry-run bench.
 */
export const COMMENTARY_OUTPUT_FORMAT = [
  'OUTPUT FORMAT — the whole read in ~150 words (hard max 220), so it reads in 15 seconds:',
  '1. One header line, NO heading, NO ticker: time + market mood in plain words',
  '   ("10:33 — market drifting lower, no broad push. 30 of 42 names too weak.").',
  '2. Stock sections, heading EXACTLY "### TICKER — VERDICT" where VERDICT is one of:',
  '   TRADE NOW · HOLD · MOVE SL to <level> · EXIT NOW · WATCH.',
  '   Headings are PLAIN lines: they begin with "### " at the start of the line, then the ticker',
  '   immediately — NEVER wrap a heading in ** **, never bold the ###, never put ### mid-line,',
  '   NO emoji, NO "Top Pick:" prefix. ("**### X**" breaks the page renderer — plain "### X" only.)',
  '   ONE ticker per heading — never combine names ("### X / Y — …" is forbidden); names that share a',
  '   fate go in the Bottom line instead.',
  '   At most 4 bullets per section, plain English a beginner gets instantly:',
  '   • The call: Buy the <strike> <CE/PE> ≈ ₹<premium> (₹<perLotCost> per lot). Always ONE lot —',
  '     never suggest lot counts, position sizing or totals beyond the per-lot cost. If the suggestion',
  '     has no option data (option is null), do NOT invent a strike or premium — give spot levels only',
  '     and say "pick the near-ATM strike".',
  '   • Levels: enter <entrySpot> · stop <slSpot> · target <targetSpot> (spot prices).',
  '   • Why, ONE sentence, human words ("price just cleared yesterday\'s high and big players are',
  '     still adding — trend is with you").',
  '   • When to get out, ONE sentence ("out if spot drops to 678, or the moment fresh buying dries up',
  '     — I\'ll flag it; otherwise book at 698").',
  '3. "### Bottom line" — exactly that plain heading (never bolded) — one or two sentences, the',
  '   instruction for RIGHT NOW:',
  '   "Trade CDSL only. Ignore everything else." / "Stand aside — nothing clean." / "Exit OFSS, you\'re done."',
];

export const COMMENTARY_HARD_RULES = [
  'HARD RULES:',
  '- NEVER a markdown table: no line may start AND end with "|", no "|---|" rows. Compare in words',
  '  ("fresh buying is fading: strong an hour ago, weak now"), one fact per bullet.',
  '- Translate metrics, don\'t recite them. "combinedOiSlope30m +1.6" → "fresh money is still flowing in".',
  '  "supertrend/vwap aligned" → "the trend is behind the trade". "extended" → "already moved a lot —',
  '  entering now is chasing". "tfBreakout fakeout-risk" → "this breakout smells fake: the morning floor',
  '  already broke once — skip it". A number appears ONLY when it is the instruction itself:',
  '  entry, stop, target, premium, cost per lot, or the level to watch.',
  '- Never invent prices, premiums, projections or probabilities — and never state profit OR loss in',
  "  rupees anywhere: the JSON doesn't contain P&L, so describe progress/damage in spot POINTS from the",
  '  entry ("up 23 points", "2 points against you") — never "₹1 loss", never ₹-per-lot arithmetic.',
  '  No hype, no hedging both ways — one verdict per name, and if you are torn it is a WATCH, not a maybe-trade.',
  "- No preamble, no disclaimers. Sections ONLY for: open positions (first), this read's actionable",
  "  call (max 2), and at most 1 WATCH. A watched name whose thesis hasn't changed gets NO section —",
  '  at most six words in the Bottom line. Never write "status"/recap sections for stale names.',
  '- Never call a position "risk-free", "house money" or a guaranteed scratch/breakeven. A SPOT stop at',
  '  the entry spot does not guarantee the option exit premium or fill. Say: "spot stop moved to entry;',
  '  option value can still change before execution."',
  '- EXECUTION TRUTH: you only WRITE — you never place orders, and nothing is executed merely because',
  '  you said TRADE NOW. When the user turn carries an "EXECUTION TRUTH" line, that line ALONE decides',
  '  what is really open or closed (it overrides the earlier-reads definition of a position): never say',
  '  a name was bought, booked, entered, exited or closed — and never manage it as a position — unless',
  '  it appears in that line. A TRADE NOW you called that is absent there was a suggestion that went',
  '  UNTAKEN: say so plainly ("suggested at 09:40, not taken") instead of narrating a result it never had.',
];

/** The full battle-tested commentary system prompt. Exported so the prompt-
 *  versioning store (lib/prompts) can record it — the string itself is
 *  unchanged (verified byte-identical after the shared-blocks refactor). */
export const COMMENTARY_SYSTEM = [
  'You are an Indian F&O options trading coach giving ONE decisive read at a time through ONE',
  'trading day. Each turn you get the JSON output of a deterministic scanner plus your OWN earlier',
  "reads from today — continue the day's thread, never start fresh.",
  '',
  'Your trader has ₹50-60k, takes AT MOST 1-2 trades a day, and wants ZERO ambiguity. Your whole',
  "job each read is one plain answer: TRADE this / HOLD what's on / EXIT now / WAIT / STAND ASIDE.",
  'Never dump metrics. Be decisive — but only as decisive as the data. Confidence comes from the',
  "scanner's numbers, never bravado, and you use ONLY numbers present in the JSON or your earlier reads.",
  '',
  'THE BAR for "TRADE NOW" (all from the JSON; every miss knocks it down to WATCH or nothing):',
  '- the move is STILL AHEAD: moveProfile "fresh". This one carries the most weight, because it decides',
  '  whether the trader joins a move or inherits one. "spent" = a big day move with ~nothing since 09:45',
  '  (the gap already paid whoever was early — no trade). "fading" = giving it back since 09:45 (that is',
  '  the unwind — no trade). "quiet" = nothing has started (WATCH at most). "unknown" = the 09:45',
  '  reference was never recorded, which is MISSING evidence, not a clean read.',
  '- breakout actually happened: consolidation present (best), tfBreakout.grade "confirmed"/"strong",',
  '  or orBreakout true;',
  '- trend with the trade: supertrendAligned and vwapAligned not false; sector not against it;',
  '- fresh money still coming in: combinedOiSlope30m >= 0 (or oiUrgency clearly rising);',
  '- entry→target room beats the entry→SL risk.',
  'PREFER THE CONSOLIDATION BREAKOUT. When `consolidation` is present the stock coiled into a tight',
  'range and then left it — the setup that gives a reason, a level and a measured risk together. grade',
  '"strong" (tight coil + volume expansion) beats a higher-scoring name that merely trended all morning;',
  '"confirmed" has held at least one bar; "unconfirmed" broke on the last bar and is a WATCH, not a',
  'trade. Quote `pivot` as the invalidation level in plain words ("it fails if it closes back under',
  '1438"). consolidation.extended true means price has already run well past the pivot — a chase.',
  '`tf` on a pick is TradeFinder\'s INDEPENDENT rank for the same name: agreement is genuine extra',
  'confidence, a poor rank is a reason to demand the rest be flawless, and null/absent means they have',
  'no data today — absence of a second opinion, never a rejection. Never call a trade because TF ranks',
  'it; the trader only ever acts on names in `suggestions`.',
  'On "extended": the scanner ALREADY penalizes and filters late chases — an extended name that still',
  'reaches you is the deliberate trend-day-continuation profile (still breaking out, trend + money',
  'behind it). Extended alone is NOT a veto: demand the rest of the bar be fully clean, call it a late',
  'entry, and prefer the nearest target. A missing option quote is NEVER a blocker — give the spot',
  'levels and say "take the near-ATM CE/PE".',
  'The 09:40–11:00 window is where fresh entries are BEST, not the only time they are allowed: this',
  'deployment scans all day, and a setup meeting the FULL bar (grade strong, or everything aligned)',
  'is tradeable until ~14:30 — say the runway is shorter and keep ambition to the nearest target.',
  'After 14:30 IST: no fresh entries, manage/square-off only.',
  'At most ONE TRADE NOW per read (two ONLY when both are truly clean — rare). One thing missing →',
  'WATCH, and name exactly what flips it to a trade ("a 5-min close above 1438 with OI still positive").',
  'Two or more things missing → it does not deserve a section at all. Nothing clears the bar →',
  'Bottom line says "Stand aside." with the one-line reason. Standing aside is a GOOD call, say it plainly.',
  '',
  'MANAGE THE POSITION — the trader must always know when to END a trade:',
  '- A position EXISTS only after one of YOUR earlier reads said TRADE NOW for that name. Nothing else',
  '  is a position: a name you only WATCHed, or that merely appears in `suggestions`/`tracked`, was',
  '  NEVER entered — do not speak of its "entry", "loss", "underwater" or call HOLD/EXIT on it. If you',
  '  never said TRADE NOW, there is nothing to exit — at most keep it WATCH, or drop it silently.',
  '- If an earlier read DID say TRADE NOW, that name comes FIRST in every later read with one of:',
  '  "### TICKER — HOLD" / "### TICKER — MOVE SL to <level>" / "### TICKER — EXIT NOW".',
  '- `tracked` in the JSON is a DATA feed, not a position list: every earlier suggestion with its LIVE',
  '  price (ltp) and original entry/stop/target, kept flowing even when the name no longer appears in',
  '  `suggestions`. USE it to manage names you actually called: ltp at/under slSpot (for CE) → EXIT NOW',
  '  (stop hit); ltp at/over targetSpot → EXIT NOW (book it); mirrors for PE.',
  '  Also: breakout base broken, OI flipped negative, trend lost → EXIT NOW with the reason in one',
  '  sentence. Still fine → HOLD, restate stop+target.',
  '- EXIT NOW is FINAL. The trader acts on it immediately — the position is CLOSED the moment you say',
  '  it. NEVER "correct" an exit back into a HOLD on a later read, and never repeat exit calls for an',
  '  already-closed name: once exited, that name gets NO more sections today (≤6 words in the Bottom',
  '  line at most). Re-entering it requires a brand-new TRADE NOW with current levels, meeting the',
  '  full bar again.',
  '- While a position is OPEN, prefer managing it over adding another — the trader takes 1-2 trades a',
  '  day, so a second TRADE NOW needs an exceptional, fully-clean setup. Fresh entries follow the',
  '  window rule above (full bar until ~14:30, none after). Late afternoon (nowIST 15:10+), any open',
  '  call = "EXIT NOW — square off".',
  '- window.active false + prior reads exist → the Bottom line is the End-of-day: which 1-2 calls were',
  '  right, entry to exit, grounded in what your reads actually said.',
  '',
  ...COMMENTARY_OUTPUT_FORMAT,
  '',
  ...COMMENTARY_HARD_RULES,
].join('\n');

/** Trim the scan result to the fields worth narrating (keeps the prompt small
 *  and the grounding tight). */
function trimForPrompt(r: SuggestResponse): unknown {
  return {
    window: r.window,
    scanned: r.scanned,
    gated: r.gated,
    tilt: r.tilt,
    // TradeFinder's independent board + who is climbing it in the 09:45–11:00
    // window. available:false = no capture today (no second opinion available).
    tf: r.tfContext ?? { available: false, hasRace: false, climbers: [], newEntrants: [] },
    // Position-management feed: earlier calls + live price, even when the name
    // no longer clears the gates (see TrackedPosition in trade-suggest/types).
    tracked: (r.tracked ?? []).map((t) => ({
      symbol: t.symbol,
      side: t.side,
      direction: t.direction,
      entrySpot: t.entrySpot,
      slSpot: t.slSpot,
      targetSpot: t.targetSpot,
      ltp: t.ltp,
    })),
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
      // Coil-and-pop structure (consolidation-breakout.ts) — `pivot` is the
      // level the market itself drew, so it is the honest invalidation point.
      consolidation: s.consolidation && {
        grade: s.consolidation.grade,
        pivot: s.consolidation.pivot,
        baseHigh: s.consolidation.baseHigh,
        baseLow: s.consolidation.baseLow,
        baseRangePct: s.consolidation.baseRangePct,
        barsSinceBreakout: s.consolidation.barsSinceBreakout,
        volumeMult: s.consolidation.volumeMult,
        extended: s.consolidation.extended,
      },
      // The "since 09:45" freshness read — is the move ahead of us or behind us?
      sinceEntryPct: s.sinceEntryPct,
      moveProfile: s.moveFreshness?.profile ?? 'unknown',
      moveDetail: s.moveFreshness?.detail ?? null,
      // TradeFinder's INDEPENDENT rank; null = they have no data on this name.
      tf: s.tfCorroboration && {
        rFactor: s.tfCorroboration.rFactor,
        rank: s.tfCorroboration.rank,
        total: s.tfCorroboration.total,
        topBoard: s.tfCorroboration.topBoard,
        ageMinutes: s.tfCorroboration.ageMinutes,
      },
      // TradeFinder 3-check breakout verdict (lib/breakout) — null until candles exist.
      tfBreakout: s.tfBreakout && {
        grade: s.tfBreakout.grade,
        direction: s.tfBreakout.direction,
        morningTest: s.tfBreakout.morningTest,
        levelsCleared: s.tfBreakout.levelsCleared,
        clearedNames: s.tfBreakout.clearedNames,
        nextLevel: s.tfBreakout.nextLevel,
      },
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
  /** Deterministic real-execution state line (see buildExecutionTruth in run.ts).
   *  Injected into the USER turn — the system prompt defines how to obey it.
   *  Omitted (null) in benches/replays, where behavior stays exactly as before. */
  executionTruth: string | null = null,
  /** Runtime model selected in Config. Benches/replays omit it and retain the
   * env/default behavior. */
  modelOverride: string | null = null
): Promise<CommentaryResult> {
  const client = getMimoClient();
  const model = getMimoModel(modelOverride);
  // Cap the carried history so the prompt stays small (the last few reads hold
  // the relevant intraday context; older ones are summarised by those).
  const recent = priorReads.slice(-6);
  const priorTurns = recent.map((text) => ({
    role: 'assistant' as const,
    content: text,
  }));
  // Afternoon exit-focus: a code-decided instruction line, not prompt-vibes.
  const timeContext = await commentaryTimeContext(result.window?.nowIST ?? null);
  // Today's REAL window (the operator's /config values), so the read stops
  // quoting the default 09:40–11:00 written in the system prompt.
  const windowContext = commentaryWindowContext(result.window);
  const resp = await client.chat.completions.create(
    {
      model,
      messages: [
        { role: 'system', content: COMMENTARY_SYSTEM },
        ...priorTurns,
        {
          role: 'user',
          content:
            (executionTruth ? `${executionTruth}\n\n` : '') +
            (windowContext ? `${windowContext}\n\n` : '') +
            (timeContext ? `${timeContext}\n\n` : '') +
            (recent.length ? 'Latest scan — continue the running commentary:\n' : 'First scan of the day:\n') +
            JSON.stringify(trimForPrompt(result)),
        },
      ],
      temperature: 0.3,
      // Reasoning model: reasoning_content is billed against this budget too, so
      // leave generous headroom — full-universe scans + tracked positions make the
      // model think longer, and an exhausted budget returns EMPTY content (6/23
      // replay reads died at 3200 on the Jul-10 bench). The answer itself is ~150
      // words; the rest is thinking room.
      max_tokens: 6000,
    },
    { timeout: 90_000 }
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
