'use client';

import { Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TFTradeItem } from '../_lib/types';
import { HumanVerifiedBadge } from './human-verified-badge';

interface TradeSearchProps {
  trades: TFTradeItem[];
  selectedIdx: number;
  onSelect: (idx: number) => void;
}

export function TradeSearch({ trades, selectedIdx, onSelect }: TradeSearchProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = trades
    .map((t, i) => ({ ...t, idx: i }))
    .filter((t) => {
      if (!query) return true;
      const q = query.toLowerCase();
      return (
        t.symbol.toLowerCase().includes(q) ||
        t.date.includes(q) ||
        `${t.optionType} ${t.strike}`.toLowerCase().includes(q)
      );
    });

  // Scroll highlighted item into view
  useEffect(() => {
    if (highlightIdx >= 0 && listRef.current) {
      const items = listRef.current.querySelectorAll('[data-trade-item]');
      items[highlightIdx]?.scrollIntoView({ block: 'nearest' });
    }
  }, [highlightIdx]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!open) {
        if (e.key === 'ArrowDown' || e.key === 'Enter') {
          setOpen(true);
          setQuery('');
          e.preventDefault();
        }
        return;
      }

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setHighlightIdx((prev) => (prev < filtered.length - 1 ? prev + 1 : 0));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setHighlightIdx((prev) => (prev > 0 ? prev - 1 : filtered.length - 1));
          break;
        case 'Enter':
          e.preventDefault();
          if (highlightIdx >= 0 && filtered[highlightIdx]) {
            onSelect(filtered[highlightIdx].idx);
            setOpen(false);
            setQuery('');
          }
          break;
        case 'Escape':
          setOpen(false);
          setQuery('');
          inputRef.current?.blur();
          break;
      }
    },
    [open, filtered, highlightIdx, onSelect],
  );

  const selected = selectedIdx >= 0 ? trades[selectedIdx] : null;
  const displayText = selected
    ? `${selected.humanReview ? '\u2705 ' : ''}${selected.date} | ${selected.symbol} ${selected.optionType} ${selected.strike} | ${selected.pnl >= 0 ? '+' : ''}\u20B9${selected.pnl.toLocaleString()}`
    : '';

  return (
    <div className="relative">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls="trade-search-listbox"
          aria-haspopup="listbox"
          aria-autocomplete="list"
          value={open ? query : displayText}
          onChange={(e) => {
            setQuery(e.target.value);
            setHighlightIdx(-1);
            setOpen(true);
          }}
          onFocus={() => {
            setOpen(true);
            setQuery('');
            setHighlightIdx(-1);
          }}
          onBlur={() => setTimeout(() => setOpen(false), 200)}
          onKeyDown={handleKeyDown}
          placeholder="Search by stock name, date, or strike..."
          className="w-full pl-10 pr-4 py-2.5 rounded-lg bg-card border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 transition-colors"
        />
        {open && filtered.length > 0 && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">
            {filtered.length} trade{filtered.length !== 1 ? 's' : ''} &middot; &uarr;&darr; navigate &middot; &crarr;
            select
          </span>
        )}
      </div>

      {open && (
        <div
          ref={listRef}
          id="trade-search-listbox"
          role="listbox"
          className="absolute z-50 w-full mt-1 max-h-80 overflow-y-auto rounded-lg bg-card border border-border shadow-2xl shadow-black/50"
        >
          {filtered.length === 0 && (
            <div className="px-4 py-3 text-sm text-muted-foreground">No trades match &ldquo;{query}&rdquo;</div>
          )}
          {filtered.map((t, listIdx) => {
            const isSelected = t.idx === selectedIdx;
            const isHighlighted = listIdx === highlightIdx;
            return (
              <button
                key={`${t.date}-${t.symbol}-${t.idx}`}
                data-trade-item
                type="button"
                role="option"
                aria-selected={isSelected}
                onMouseDown={() => {
                  onSelect(t.idx);
                  setOpen(false);
                  setQuery('');
                }}
                onMouseEnter={() => setHighlightIdx(listIdx)}
                className={`w-full text-left px-4 py-2.5 flex items-center gap-3 transition-colors border-b border-border/50 last:border-b-0 ${
                  isHighlighted ? 'bg-primary/15' : isSelected ? 'bg-primary/10' : 'hover:bg-accent'
                } ${isSelected ? 'border-l-2 border-l-primary' : ''} ${!t.hasData ? 'opacity-40' : ''}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <HumanVerifiedBadge show={t.humanReview} />
                    <span className="text-foreground font-semibold text-sm">{t.symbol}</span>
                    <span className={`text-xs ${t.optionType === 'CE' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                      {t.optionType} {t.strike}
                    </span>
                    {!t.hasData && (
                      <span className="text-[9px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">NO DATA</span>
                    )}
                  </div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">
                    {t.date}
                    {t.humanReview && t.entryPrice && (
                      <span className="text-muted-foreground ml-2">
                        {'\u20B9'}
                        {t.entryPrice} &rarr; {'\u20B9'}
                        {t.exitPrice}
                      </span>
                    )}
                  </div>
                </div>
                <span
                  className={`text-sm font-mono font-bold shrink-0 ${t.pnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}
                >
                  {t.pnl >= 0 ? '+' : ''}
                  {'\u20B9'}
                  {(t.pnl / 1000).toFixed(1)}K
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
