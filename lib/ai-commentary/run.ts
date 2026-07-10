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
import type { SuggestResponse } from '@/lib/trade-suggest/types';
import { generateCommentary } from './generate';
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
  });
  return { generated: true, text: c.text };
}
