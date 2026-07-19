/**
 * Auto-trade engine — the per-cycle orchestrator, called from the Fyers
 * poller's autonomous capture (right after the scan + commentary) and from
 * the manual "Run pass" action. Deterministic safety runs FIRST, the AI runs
 * LAST, and nothing here ever throws to the caller:
 *
 *   1. reconcile   — resolve fills of orders the last pass left pending
 *   2. expire      — time-out stale approval proposals
 *   3. guard       — code-enforced exits (stops/targets/15:12 square-off)
 *   4. AI pass     — the decision model manages positions + considers ONE entry
 *
 * Kill switch: steps 1–3 always run (they only reduce risk); step 4 entries
 * are gate-blocked, so the AI pass is skipped entirely to save tokens.
 */

import { isMarketHours, todayIST } from '@/lib/dhan/market-feed';
import { hasAzureConfig } from '@/lib/ai-assistant/azure-client';
import { buildPicks } from '@/lib/ai-commentary/picks';
import { getCommentary, insertCommentary } from '@/lib/ai-commentary/store';
import { hasMimo } from '@/lib/env';
import { recordPromptVersion } from '@/lib/prompts/store';
import { isTelegramConfigured, sendCommentaryToTelegram } from '@/lib/telegram';
import type { SuggestResponse } from '@/lib/trade-suggest/types';
import { expireStaleApprovals } from './approval';
import { reconcileOpenPositions, reconcileUnresolvedOrders as reconcileOrdersSafely } from './execution';
import { isEntryWindow, nowISTClock } from './config';
import { runToolLoop } from './decision/providers';
import { commentaryTimeContext } from '@/lib/ai-commentary/generate';
import { COMMENTARY_ENTRY_CUTOFF_MIN_DEFAULT } from '@/lib/ai-commentary/generate';
import { getNumberSetting } from '@/lib/config/feature-toggles';
import type { CycleTimelineRecorder } from '@/lib/ops/cycle-timeline';
import { releaseRuntimeLease, tryAcquireRuntimeLease } from '@/lib/runtime/lease';
import { AUTO_TRADER_SYSTEM } from './decision/system-prompt';
import { runPositionGuard } from './risk/position-guard';
import { getAutoTradeSettings } from './settings';
import { countEntriesToday, getOpenTrades, insertDecision } from './store';
import { AUTO_TRADE_TOOLS } from './tools/defs';
import { buildInitialDecisionContext, executeAutoTradeTool, type ToolRuntime } from './tools/execute';

const TAG = '[AutoTrade]';
const ENGINE_LEASE = 'auto-trade-engine-pass';
const ENGINE_LEASE_TTL_MS = 2 * 60_000;

export interface AutoTradePassOutcome {
  ran: boolean;
  reason?: string;
  guardActions: string[];
  aiSummary?: string;
  /** True when the AI pass's read was stored as this cycle's trade_commentary
   *  row — the poller then SKIPS the standalone MiMo commentary (one AI
   *  analysis per cycle, never two). */
  commentaryStored: boolean;
  /** Read tools repeated despite their data being preloaded in the first turn. */
  redundantReadTools?: number;
  error?: string;
}

// One pass at a time per process (poller serializes its own captures; this
// also covers a manual "Run pass" overlapping the autonomous one).
const g = globalThis as unknown as { __autoTradePassRunning?: boolean };

/** True while a full engine pass is in flight — the fast guard loop
 *  (guard-loop.ts) skips its tick rather than double-running the guard. */
export function isAutoTradePassRunning(): boolean {
  return g.__autoTradePassRunning === true;
}

function providerConfigured(provider: 'azure' | 'mimo'): boolean {
  return provider === 'azure' ? hasAzureConfig() : hasMimo();
}

/**
 * Run one full auto-trade pass. `scan` is this cycle's trade-suggest result
 * (null when no scan ran — management still proceeds). Never throws.
 * `timeline` (optional, from the poller's capture) records when each phase
 * started/ended so slow passes show WHERE the time went on /trade-commentary.
 */
export async function runAutoTradePass(
  scan: SuggestResponse | null,
  timeline?: CycleTimelineRecorder
): Promise<AutoTradePassOutcome> {
  // Timing wrapper — a no-op passthrough when no recorder was provided
  // (manual "Run pass" route), so behavior is identical either way.
  const tstep = <T>(name: string, fn: () => Promise<T>, detail?: (r: T) => string | undefined): Promise<T> =>
    timeline ? timeline.step(name, fn, detail) : fn();
  const settings = await getAutoTradeSettings();
  if (g.__autoTradePassRunning) {
    return {
      ran: false,
      reason: 'previous pass still running',
      guardActions: [],
      commentaryStored: false,
    };
  }
  g.__autoTradePassRunning = true;
  const date = todayIST();
  let leaseHeld = false;
  let leaseRenewal: ReturnType<typeof setInterval> | null = null;

  try {
    leaseHeld = await tryAcquireRuntimeLease(ENGINE_LEASE, ENGINE_LEASE_TTL_MS);
    if (!leaseHeld) {
      return {
        ran: false,
        reason: 'another process owns the auto-trade pass',
        guardActions: [],
        commentaryStored: false,
      };
    }
    leaseRenewal = setInterval(() => {
      void tryAcquireRuntimeLease(ENGINE_LEASE, ENGINE_LEASE_TTL_MS);
    }, 30_000);

    // 1–2. Reconcile pending fills + position-level truth, expire stale approvals.
    const reconcileNotes = await tstep('reconcile: orders', () => reconcileOrdersSafely(), (n) =>
      n.length > 0 ? `${n.length} note(s)` : undefined
    );
    const positionNotes = await tstep('reconcile: positions', () => reconcileOpenPositions({ verifyBroker: true }), (n) =>
      n.length > 0 ? `${n.length} note(s)` : undefined
    );
    const expired = await tstep('approvals: expire stale', () => expireStaleApprovals(date, settings.approvalTtlMin), (e) =>
      e.length > 0 ? `${e.length} expired` : undefined
    );

    // 3. Deterministic guard — always, kill switch or not.
    const guard = await tstep('position guard', () => runPositionGuard(date), (g) =>
      g.actions.length > 0 ? g.actions.join(' · ') : 'no exits due'
    );
    const { actions: guardActions } = guard;
    const systemNotes = [
      ...reconcileNotes,
      ...positionNotes,
      ...expired.map((e) => `approval expired: ${e}`),
      ...(guard.coalesced ? [] : guardActions),
    ];
    if (systemNotes.length > 0) {
      await insertDecision({
        date,
        pass: 'guard',
        provider: null,
        model: null,
        summary: systemNotes.join(' · '),
        toolTrace: [],
        promptTokens: null,
        completionTokens: null,
      });
    }

    if (settings.mode === 'off' || settings.killSwitch) {
      return {
        ran: true,
        reason:
          settings.mode === 'off'
            ? 'new entries off — reconciliation and guard only'
            : 'kill switch on — reconciliation and guard only',
        guardActions,
        commentaryStored: false,
      };
    }

    // 4. AI pass — only when there is something to decide.
    const openTrades = await getOpenTrades();
    const entriesToday = await countEntriesToday(date);
    const entryCutoffMin = await getNumberSetting(
      'COMMENTARY_ENTRY_CUTOFF_MIN',
      COMMENTARY_ENTRY_CUTOFF_MIN_DEFAULT
    ).catch(() => COMMENTARY_ENTRY_CUTOFF_MIN_DEFAULT);
    const effectiveEntryEndMin = Math.min(settings.entryEndMin, entryCutoffMin - 1, settings.squareOffMin - 1);
    const entryPossible =
      isMarketHours() &&
      isEntryWindow(undefined, settings.entryStartMin, effectiveEntryEndMin) &&
      entriesToday < settings.maxTradesPerDay &&
      (scan?.suggestions?.length ?? 0) > 0;
    if (openTrades.length === 0 && !entryPossible) {
      return {
        ran: true,
        reason: 'nothing to decide (no positions, no entry opportunity)',
        guardActions,
        commentaryStored: false,
      };
    }
    if (!providerConfigured(settings.aiProvider)) {
      const summary = `AI provider '${settings.aiProvider}' is not configured — pass skipped (guard still ran)`;
      await insertDecision({
        date,
        pass: 'system',
        provider: settings.aiProvider,
        model: null,
        summary,
        toolTrace: [],
        promptTokens: null,
        completionTokens: null,
      });
      return {
        ran: true,
        reason: summary,
        guardActions,
        commentaryStored: false,
      };
    }

    const rt: ToolRuntime = { scan, settings, date };
    const now = nowISTClock();
    // Build routine context in parallel before the first model call. Reuse the
    // guard's batched quotes so positions do not issue another Dhan request.
    const [initialContext, previousRows, timeContext] = await tstep('AI: build context', () =>
      Promise.all([
        buildInitialDecisionContext(rt, {
          optionQuotes: guard.optionQuotes,
          attemptedOptionIds: guard.attemptedOptionIds,
          spotBySymbol: guard.spotBySymbol,
        }),
        getCommentary({ date, limit: 1 }),
        commentaryTimeContext(now),
      ])
    );
    const previousRead = previousRows[0]?.text ?? null;
    const user = JSON.stringify({
      nowIST: now,
      date,
      contextAlreadyLoaded: initialContext,
      previousRead,
      ...(timeContext ? { timeContext } : {}),
      instruction:
        'Use the loaded context immediately. Do not call get_account_state, get_open_positions, or get_scan_picks unless a field is missing or you need a deliberate refresh. Manage positions first, then consider at most one entry, then end with the day-thread read.',
    });
    const result = await tstep(
      'AI: decision loop',
      () =>
        runToolLoop({
          provider: settings.aiProvider,
          system: AUTO_TRADER_SYSTEM,
          user,
          tools: AUTO_TRADE_TOOLS,
          execute: (name, args) => executeAutoTradeTool(rt, name, args),
        }),
      // Per-call breakdown: WHERE the loop's time went (model vs tools).
      (r) => `${r.model} · ${r.spans.map((s) => `${s.name} ${(s.ms / 1000).toFixed(1)}s`).join(' · ')}`
    );
    const preloadedReads = new Set(['get_account_state', 'get_open_positions', 'get_scan_picks']);
    const redundantReadTools = result.trace.filter((step) => preloadedReads.has(step.name)).length;
    console.log(`${TAG} latency metric: redundant preloaded read tools=${redundantReadTools}`);
    await insertDecision({
      date,
      pass: 'ai',
      provider: settings.aiProvider,
      model: result.model,
      summary: result.text,
      toolTrace: result.trace,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
    });
    // The pass's read IS this cycle's commentary — store it so /trade-commentary
    // shows it and the poller skips the standalone MiMo call (one AI per cycle).
    // `previousRead` (fetched above for the AI thread) doubles as the
    // near-duplicate baseline for the Telegram push below.
    let commentaryStored = false;
    const commentaryT0 = Date.now();
    try {
      const promptVersion = await recordPromptVersion('auto-trader', AUTO_TRADER_SYSTEM);
      const commentaryId = await insertCommentary({
        date,
        asOf: scan?.window?.nowIST ? `${date} ${scan.window.nowIST}` : new Date().toISOString(),
        windowActive: Boolean(scan?.window?.active),
        picksCount: scan?.suggestions?.length ?? 0,
        model: result.model,
        text: result.text,
        picks: scan ? buildPicks(scan) : [],
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        promptKey: 'auto-trader',
        promptVersion,
      });
      timeline?.setCommentaryId(commentaryId);
      commentaryStored = true;
      // Push commentary to Telegram — same rendering + near-duplicate muting
      // as runAndStoreCommentary() (lib/telegram/commentary.ts).
      if (isTelegramConfigured() && result.text) {
        try {
          const settings = await getAutoTradeSettings();
          if (settings.telegramAlerts) await sendCommentaryToTelegram(result.text, previousRead);
        } catch (err) {
          console.warn(`${TAG} Telegram settings/delivery failed: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      // Retry once before falling back — the DB may have been briefly locked
      console.warn(`${TAG} commentary store failed, retrying once: ${(err as Error).message}`);
      try {
        const promptVersion = await recordPromptVersion('auto-trader', AUTO_TRADER_SYSTEM);
        const commentaryId = await insertCommentary({
          date,
          asOf: scan?.window?.nowIST ? `${date} ${scan.window.nowIST}` : new Date().toISOString(),
          windowActive: Boolean(scan?.window?.active),
          picksCount: scan?.suggestions?.length ?? 0,
          model: result.model,
          text: result.text,
          picks: scan ? buildPicks(scan) : [],
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          promptKey: 'auto-trader',
          promptVersion,
        });
        timeline?.setCommentaryId(commentaryId);
        commentaryStored = true;
      } catch (retryErr) {
        console.warn(`${TAG} commentary store failed (poller will fall back): ${(retryErr as Error).message}`);
      }
    }
    timeline?.addSpan(
      'commentary: store + telegram',
      commentaryT0,
      Date.now(),
      commentaryStored,
      commentaryStored ? undefined : 'store failed — poller falls back to standalone commentary'
    );
    console.log(`${TAG} AI pass done: ${result.text.slice(0, 140)}`);
    return {
      ran: true,
      guardActions,
      aiSummary: result.text,
      commentaryStored,
      redundantReadTools,
    };
  } catch (err) {
    const message = (err as Error).message;
    console.warn(`${TAG} pass failed: ${message}`);
    try {
      await insertDecision({
        date,
        pass: 'system',
        provider: null,
        model: null,
        summary: `pass error: ${message}`,
        toolTrace: [],
        promptTokens: null,
        completionTokens: null,
      });
    } catch {
      // audit best-effort — never compound the failure
    }
    return {
      ran: true,
      guardActions: [],
      commentaryStored: false,
      error: message,
    };
  } finally {
    if (leaseRenewal) clearInterval(leaseRenewal);
    if (leaseHeld) await releaseRuntimeLease(ENGINE_LEASE);
    g.__autoTradePassRunning = false;
  }
}
