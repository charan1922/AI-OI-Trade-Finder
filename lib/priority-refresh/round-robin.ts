/**
 * Pure fair round-robin feed selection (see plan §6). No DB / provider / AI.
 *
 * Round N takes rank N from each feed in FEED_ORDER, so no single feed can eat
 * the whole cap. Duplicates (a hot name on several feeds) consume ONE slot.
 * `maxUnique` counts only NEWLY selected symbols — pre-seeded `exclude` names
 * (e.g. Tier 0, or an already-built base) are skipped and never counted.
 */
import { FEED_ORDER } from './config';
import type { FeedPicks } from './types';

export function selectRoundRobinCandidates(
  feedPicks: FeedPicks,
  perFeedLimit: number,
  maxUnique: number,
  exclude: ReadonlySet<string> = new Set()
): string[] {
  const ordered: string[] = [];
  if (maxUnique <= 0 || perFeedLimit <= 0) return ordered;
  const seen = new Set<string>(exclude);

  for (let rankIndex = 0; rankIndex < perFeedLimit; rankIndex += 1) {
    for (const source of FEED_ORDER) {
      const pick = feedPicks[source]?.[rankIndex];
      if (!pick?.symbol || seen.has(pick.symbol)) continue;
      seen.add(pick.symbol);
      ordered.push(pick.symbol);
      if (ordered.length >= maxUnique) return ordered;
    }
  }
  return ordered;
}
