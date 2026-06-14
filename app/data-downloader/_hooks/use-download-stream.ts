import { useCallback, useRef, useState } from 'react';
import type { DownloadEvent, TradeDataStatus } from '../_lib/types';

interface DownloadState {
  isDownloading: boolean;
  /** True when the user aborted the run — distinguishes it from a completed one. */
  cancelled: boolean;
  currentSymbol: string;
  currentStep: string;
  completedCount: number;
  totalCount: number;
  /** Steps finished for the symbol currently downloading. */
  currentSteps: number;
  /** Steps expected for the current symbol (2 without an option leg, 3 with). */
  currentStepsTotal: number;
  totalRows: number;
  log: string[];
  errors: string[];
}

export function useDownloadStream(onComplete?: () => void) {
  const [state, setState] = useState<DownloadState>({
    isDownloading: false,
    cancelled: false,
    currentSymbol: '',
    currentStep: '',
    completedCount: 0,
    totalCount: 0,
    currentSteps: 0,
    currentStepsTotal: 0,
    totalRows: 0,
    log: [],
    errors: [],
  });
  const abortRef = useRef<AbortController | null>(null);

  const start = useCallback(
    async (items: TradeDataStatus[]) => {
      const symbols = items.map((s) => ({
        symbol: s.symbol,
        optionType: s.optionType,
        strike: s.strike,
        date: s.date,
        spotPrice: s.spotPrice,
      }));
      if (symbols.length === 0) return;

      // equity + futures, plus the option leg when there is a strike
      const stepsFor = (s: { strike: number }) => (s.strike > 0 ? 3 : 2);

      abortRef.current = new AbortController();
      setState({
        isDownloading: true,
        cancelled: false,
        currentSymbol: symbols[0].symbol,
        currentStep: 'equity',
        completedCount: 0,
        totalCount: symbols.length,
        currentSteps: 0,
        currentStepsTotal: stepsFor(symbols[0]),
        totalRows: 0,
        log: [],
        errors: [],
      });

      try {
        const res = await fetch('/api/backtest/download-stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbols }),
          signal: abortRef.current.signal,
        });

        if (!res.body) throw new Error('No response stream');
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const event = JSON.parse(line.slice(6)) as DownloadEvent;

              if (event.type === 'progress') {
                // bhavcopy is a global, market-wide leg (not tied to one symbol) —
                // show it with a friendly label instead of the stale last symbol.
                const isBhav = event.step === 'bhavcopy';
                setState((prev) => ({
                  ...prev,
                  currentSymbol: isBhav ? 'NSE bhavcopy (all stocks)' : event.symbol ?? prev.currentSymbol,
                  currentStep: isBhav ? 'end-of-day OI totals' : event.step ?? prev.currentStep,
                }));
              } else if (event.type === 'step-done') {
                setState((prev) => ({
                  ...prev,
                  totalRows: prev.totalRows + (event.rows ?? 0),
                  // master-sync and bhavcopy are global steps, not per-symbol legs
                  currentSteps:
                    event.step === 'master-sync' || event.step === 'bhavcopy' ? prev.currentSteps : prev.currentSteps + 1,
                  log: [
                    ...prev.log,
                    event.step === 'bhavcopy'
                      ? `NSE bhavcopy: ${event.rows} rows`
                      : `${event.symbol} ${event.step}: ${event.rows} rows`,
                  ],
                }));
              } else if (event.type === 'symbol-done') {
                const nextIdx = (event.symbolIndex ?? 0) + 1;
                setState((prev) => ({
                  ...prev,
                  completedCount: nextIdx,
                  currentSteps: 0,
                  currentStepsTotal: nextIdx < symbols.length ? stepsFor(symbols[nextIdx]) : prev.currentStepsTotal,
                }));
              } else if (event.type === 'error') {
                setState((prev) => ({
                  ...prev,
                  errors: [...prev.errors, event.message ?? 'Unknown error'],
                  log: [...prev.log, `ERROR: ${event.message}`],
                }));
              } else if (event.type === 'complete') {
                setState((prev) => ({
                  ...prev,
                  isDownloading: false,
                  totalRows: event.totalRows ?? prev.totalRows,
                }));
                onComplete?.();
              }
            } catch {
              /* skip malformed events */
            }
          }
        }
      } catch (e) {
        if ((e as Error).name !== 'AbortError') {
          setState((prev) => ({
            ...prev,
            isDownloading: false,
            errors: [...prev.errors, (e as Error).message],
          }));
        }
      } finally {
        setState((prev) => ({ ...prev, isDownloading: false }));
        abortRef.current = null;
      }
    },
    [onComplete],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setState((prev) => ({ ...prev, isDownloading: false, cancelled: true }));
  }, []);

  return { ...state, start, cancel };
}
