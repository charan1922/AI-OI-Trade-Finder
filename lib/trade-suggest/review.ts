/**
 * Same-day scorecard for /trade-suggest calls.
 *
 * For each of today's persisted suggestions, replays the symbol's 5-min EQ
 * candles AFTER the suggestion time (from fyers_candles) and records, in SPOT
 * terms relative to spotAtSuggest:
 *   maxUpPct   — best upward excursion (favorable for CE)
 *   maxDownPct — worst downward excursion (favorable for PE)
 *   closePct   — where the last recorded bar closed
 *
 * MUST run the same day — fyers_candles keeps only today and clears at the
 * next session's first poll. The skill triggers this after 15:30 (or on the
 * loop's last pass).
 */

import { todayIST } from '@/lib/dhan/market-feed';
import { getFyersCandles } from '@/lib/fyers/candle-store';
import { getSuggestions, recordOutcome } from '@/lib/trade-suggest/store';
import type { StoredSuggestion } from '@/lib/trade-suggest/types';

const TAG = '[TradeSuggestReview]';

export interface ReviewResult {
  date: string;
  reviewed: number;
  skipped: number;
  suggestions: StoredSuggestion[];
}

export async function reviewToday(): Promise<ReviewResult> {
  const date = todayIST();
  const suggestions = await getSuggestions(date);
  let reviewed = 0;
  let skipped = 0;

  for (const s of suggestions) {
    const sinceSec = Math.floor(Date.parse(s.suggestedAt) / 1000);
    const bars = (await getFyersCandles(s.symbol, date, 'EQ')).filter((b) => b.bucketTs >= sinceSec && b.high > 0);
    if (bars.length === 0 || s.spotAtSuggest <= 0) {
      skipped++;
      continue;
    }
    const hi = Math.max(...bars.map((b) => b.high));
    const lo = Math.min(...bars.map((b) => b.low));
    const close = bars[bars.length - 1].close;
    const pct = (v: number) => Math.round(((v - s.spotAtSuggest) / s.spotAtSuggest) * 10000) / 100;
    await recordOutcome(date, s.symbol, s.optionType, {
      maxUpPct: pct(hi),
      maxDownPct: pct(lo),
      closePct: pct(close),
    });
    reviewed++;
  }

  console.log(`${TAG} ${date}: reviewed ${reviewed}, skipped ${skipped}`);
  return { date, reviewed, skipped, suggestions: await getSuggestions(date) };
}
