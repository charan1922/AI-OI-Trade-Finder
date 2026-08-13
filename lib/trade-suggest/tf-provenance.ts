import type { SuggestResponse, TradeSuggestion } from './types';

/**
 * Return only suggestions proven to have come from this scan's tradeable TF
 * Running Race. This is a second, pure fail-closed boundary around the scanner:
 * a missing/stale TF summary, a symbol mismatch, or a CE/PE mismatch exposes no
 * entry candidate to commentary or Auto-Trade.
 */
export function tfSelectedSuggestions(scan: SuggestResponse | null | undefined): TradeSuggestion[] {
  if (!scan?.tfSelection?.available) return [];

  const selected = new Map(
    scan.tfSelection.selected.map((candidate) => [candidate.symbol.toUpperCase(), candidate.side] as const)
  );

  return (scan.suggestions ?? []).filter((suggestion) => {
    const expectedSide = selected.get(suggestion.symbol.toUpperCase());
    if (!expectedSide) return false;
    const actualSide = suggestion.option?.optionType ?? (suggestion.direction === 'bullish' ? 'CE' : 'PE');
    return actualSide === expectedSide;
  });
}

export function findTfSelectedSuggestion(
  scan: SuggestResponse | null | undefined,
  symbol: string
): TradeSuggestion | null {
  const normalized = symbol.toUpperCase();
  return tfSelectedSuggestions(scan).find((suggestion) => suggestion.symbol.toUpperCase() === normalized) ?? null;
}
