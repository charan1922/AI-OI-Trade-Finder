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
import { insertCommentary } from './store';

export interface RunCommentaryOutcome {
  generated: boolean;
  reason?: string;
  text?: string;
}

export async function runAndStoreCommentary(result: SuggestResponse): Promise<RunCommentaryOutcome> {
  if (!hasMimo()) return { generated: false, reason: 'MiMo not configured' };
  if ((result.scanned ?? 0) <= 0) return { generated: false, reason: 'no scan this pass (out of window per config)' };

  const c = await generateCommentary(result);
  await insertCommentary({
    date: todayIST(),
    asOf: result.window?.nowIST ? `${todayIST()} ${result.window.nowIST}` : new Date().toISOString(),
    windowActive: Boolean(result.window?.active),
    picksCount: result.suggestions?.length ?? 0,
    model: c.model,
    text: c.text,
    promptTokens: c.promptTokens,
    completionTokens: c.completionTokens,
  });
  return { generated: true, text: c.text };
}
