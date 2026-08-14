/**
 * Generate + persist one commentary for a scan result. Called by the poller's
 * autonomous capture (in-process, no external cron) and by the manual
 * POST /api/trade-commentary route.
 *
 * Only narrates when a REAL scan happened — marked explicitly after the
 * market/window guards. A completed TF-only scan with zero candidates is still
 * narrated because "no TF setup, and why" is operationally important.
 */
import { todayIST } from '@/lib/dhan/market-feed';
import { hasMimo } from '@/lib/env';
import type { CycleTimelineRecorder } from '@/lib/ops/cycle-timeline';
import { recordPromptVersion } from '@/lib/prompts/store';
import { isTelegramConfigured, sendCommentaryToTelegram } from '@/lib/telegram';
import { getAutoTradeSettings } from '@/lib/auto-trade/settings';
import { getTradesByDate } from '@/lib/auto-trade/store';
import type { SuggestResponse } from '@/lib/trade-suggest/types';
import { tfSelectedSuggestions } from '@/lib/trade-suggest/tf-provenance';
import { COMMENTARY_SYSTEM, generateCommentary } from './generate';
import { commentaryEligibility } from './eligibility';
import { buildPicks } from './picks';
import { getCommentary, insertCommentary } from './store';

export interface RunCommentaryOutcome {
  generated: boolean;
  reason?: string;
  text?: string;
}

/**
 * The EXECUTION TRUTH line — the ONLY source of real position state for the
 * narrator (2026-07-17: it narrated "EXIDEIND booked, done" for a trade that
 * was never placed, because the prompt's position model was "whatever I said
 * TRADE NOW about earlier"). Deterministic, from the auto_trades table; the
 * matching hard rule lives in COMMENTARY_HARD_RULES. Never throws — a store
 * hiccup falls back to null (read behaves exactly as before).
 */
export interface ExecutionTruth {
  line: string | null;
  /** True when at least one REAL trade (open/placing/closed) is in the line.
   *  The narration built from it is operator-only — it names the contract and
   *  its premiums, and the standalone narrator stores itself as an ordinary
   *  'trade-commentary' row, so promptKey alone cannot classify it (PR#22
   *  re-review). Defaults to TRUE on a lookup failure: if we cannot prove the
   *  book is empty, we must not publish. */
  hasRealPositions: boolean;
}

export async function buildExecutionTruth(date: string): Promise<ExecutionTruth> {
  try {
    const trades = await getTradesByDate(date);
    const real = trades.filter((t) => ['open', 'placing', 'closed'].includes(t.status));
    const body =
      real.length === 0
        ? 'NONE. No order was placed today. Every scanner pick and every TRADE NOW you may have called earlier went UNTAKEN — treat them as suggestions only, never as positions or results.'
        : real
            .map((t) => {
              const c = `${t.symbol} ${t.strike}${t.optionType}`;
              if (t.status === 'closed')
                return `${c}: CLOSED (entry ₹${t.entryFillPremium ?? t.entryPremium} → exit ₹${t.exitFillPremium ?? '?'}${t.exitReason ? `, ${t.exitReason}` : ''})`;
              if (t.status === 'open') return `${c}: OPEN (entry ₹${t.entryFillPremium ?? t.entryPremium})`;
              return `${c}: order in flight (not yet confirmed)`;
            })
            .join(' · ');
    return {
      line:
        'EXECUTION TRUTH (deterministic, from code — the ONLY source of real position state; names absent ' +
        `here were NEVER traded today): ${body}`,
      hasRealPositions: real.length > 0,
    };
  } catch (err) {
    console.warn(`[Commentary] execution-truth lookup failed: ${(err as Error).message}`);
    return { line: null, hasRealPositions: true };
  }
}

export async function runAndStoreCommentary(
  result: SuggestResponse,
  timeline?: CycleTimelineRecorder
): Promise<RunCommentaryOutcome> {
  // Timing wrapper — no-op passthrough when no cycle recorder was provided
  // (the manual "Generate now" route), so behavior is identical either way.
  const tstep = <T>(name: string, fn: () => Promise<T>, detail?: (r: T) => string | undefined): Promise<T> =>
    timeline ? timeline.step(name, fn, detail) : fn();
  if (!hasMimo()) return { generated: false, reason: 'MiMo not configured' };
  const eligibility = commentaryEligibility(result);
  if (!eligibility.eligible)
    return {
      generated: false,
      reason: eligibility.reason,
    };

  // Carry forward TODAY's earlier reads so this is the next turn of a running
  // conversation (oldest first). New day → empty → a fresh conversation.
  const today = todayIST();
  const settings = await getAutoTradeSettings();
  if (settings.mimoModelConfigurationError) {
    return {
      generated: false,
      reason: `${settings.mimoModelConfigurationError} — commentary skipped until a valid model is saved or deployed`,
    };
  }
  const priorToday = await tstep('commentary: load prior reads', () => getCommentary({ date: today, limit: 30 }));
  const priorReads = priorToday.map((r) => r.text).reverse(); // store returns newest-first

  const executionTruth = await buildExecutionTruth(today);
  const c = await tstep(
    'commentary: MiMo generate',
    async () => generateCommentary(result, priorReads, executionTruth.line, settings.mimoModel),
    (r) => `${r.model} · ${(r.promptTokens ?? 0).toLocaleString('en-IN')}+${(r.completionTokens ?? 0).toLocaleString('en-IN')} tok`
  );
  // Prompt-versioning stamp: record the system prompt used (new row only when
  // the text changed) and remember which version wrote this commentary.
  const promptVersion = await recordPromptVersion('trade-commentary', COMMENTARY_SYSTEM);
  const commentaryId = await tstep('commentary: store', () =>
    insertCommentary({
      date: today,
      asOf: result.window?.nowIST ? `${today} ${result.window.nowIST}` : new Date().toISOString(),
      windowActive: Boolean(result.window?.active),
      picksCount: tfSelectedSuggestions(result).length,
      model: c.model,
      text: c.text,
      picks: buildPicks(result),
      promptTokens: c.promptTokens,
      completionTokens: c.completionTokens,
      promptKey: 'trade-commentary',
      promptVersion,
      // Operator-only when a real position was in the model's context.
      containsExecutionState: executionTruth.hasRealPositions,
    })
  );
  timeline?.setCommentaryId(commentaryId);
  // Push the commentary to Telegram so the operator gets it in real-time —
  // rendered as Telegram-native HTML (headings→bold etc., see
  // lib/telegram/commentary.ts) so the phone reads as cleanly as the
  // /trade-commentary page, with near-duplicate 5-min repeats muted
  // (actionable TRADE NOW / EXIT NOW reads always go through).
  if (isTelegramConfigured() && c.text) {
    const previousText = priorToday[0]?.text ?? null;
    const tgT0 = Date.now();
    try {
      if (settings.telegramAlerts) {
        await sendCommentaryToTelegram(c.text, previousText);
      }
      timeline?.addSpan('commentary: telegram', tgT0, Date.now(), true);
    } catch (err) {
      // Settings are an operator control. A lookup failure must not bypass it.
      timeline?.addSpan('commentary: telegram', tgT0, Date.now(), false, (err as Error).message);
      console.warn(`[Commentary] Telegram settings/delivery failed: ${(err as Error).message}`);
    }
  }

  return { generated: true, text: c.text };
}
