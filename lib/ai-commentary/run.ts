/**
 * Generate + persist one commentary for a scan result. Called by the poller's
 * autonomous capture (in-process, no external cron) and by the manual
 * POST /api/trade-commentary route.
 *
 * Only narrates when a REAL scan happened (`scanned > 0`) — which the engine
 * decides per the config window (in-window always; outside-window only when
 * SCAN_OUTSIDE_WINDOW is on). So this respects the /config page setting.
 */
import { todayIST } from '@/lib/dhan/market-feed';
import { hasMimo } from '@/lib/env';
import { recordPromptVersion } from '@/lib/prompts/store';
import { sendMessage, isTelegramConfigured } from '@/lib/telegram';
import { getAutoTradeSettings } from '@/lib/auto-trade/settings';
import type { SuggestResponse } from '@/lib/trade-suggest/types';
import { COMMENTARY_SYSTEM, generateCommentary } from './generate';
import { buildPicks } from './picks';
import { getCommentary, insertCommentary } from './store';

export interface RunCommentaryOutcome {
  generated: boolean;
  reason?: string;
  text?: string;
}

export async function runAndStoreCommentary(result: SuggestResponse): Promise<RunCommentaryOutcome> {
  if (!hasMimo()) return { generated: false, reason: 'MiMo not configured' };
  if ((result.scanned ?? 0) <= 0) return { generated: false, reason: 'no scan this pass (out of window per config)' };

  // Carry forward TODAY's earlier reads so this is the next turn of a running
  // conversation (oldest first). New day → empty → a fresh conversation.
  const today = todayIST();
  const priorToday = await getCommentary({ date: today, limit: 30 });
  const priorReads = priorToday.map((r) => r.text).reverse(); // store returns newest-first

  const c = await generateCommentary(result, priorReads);
  // Prompt-versioning stamp: record the system prompt used (new row only when
  // the text changed) and remember which version wrote this commentary.
  const promptVersion = await recordPromptVersion('trade-commentary', COMMENTARY_SYSTEM);
  await insertCommentary({
    date: today,
    asOf: result.window?.nowIST ? `${today} ${result.window.nowIST}` : new Date().toISOString(),
    windowActive: Boolean(result.window?.active),
    picksCount: result.suggestions?.length ?? 0,
    model: c.model,
    text: c.text,
    picks: buildPicks(result),
    promptTokens: c.promptTokens,
    completionTokens: c.completionTokens,
    promptKey: 'trade-commentary',
    promptVersion,
  });
  // Push the commentary to Telegram so the operator gets it in real-time.
  // Telegram limit is 4096 chars; commentary is ~220 words max so it fits.
  // Plain text (no parse_mode) — the commentary uses ### headings, • bullets,
  // and inline * or _ that Telegram's Markdown parser doesn't handle cleanly.
  if (isTelegramConfigured() && c.text) {
    try {
      const settings = await getAutoTradeSettings();
      if (settings.telegramAlerts) {
        sendMessage(`📊 Trade Commentary\n\n${c.text}`);
      }
    } catch {
      // Fail-open: send if settings can't be loaded
      sendMessage(`📊 Trade Commentary\n\n${c.text}`);
    }
  }

  return { generated: true, text: c.text };
}
