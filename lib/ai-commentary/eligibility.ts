import type { SuggestResponse } from '@/lib/trade-suggest/types';

export interface CommentaryEligibility {
  eligible: boolean;
  reason?: string;
}

/**
 * A completed scan is narratable even when its TF-only candidate universe is
 * empty. `scanned` counts symbols considered; it no longer proves whether the
 * scanner actually ran now that TF can correctly fail closed with zero names.
 */
export function commentaryEligibility(
  result: Pick<SuggestResponse, 'scanExecuted' | 'note'>
): CommentaryEligibility {
  if (result.scanExecuted) return { eligible: true };
  return {
    eligible: false,
    reason: result.note ?? 'no completed scan this pass (outside the configured window)',
  };
}
