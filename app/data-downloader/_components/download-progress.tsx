'use client';

interface DownloadProgressProps {
  isDownloading: boolean;
  cancelled: boolean;
  currentSymbol: string;
  currentStep: string;
  completedCount: number;
  totalCount: number;
  currentSteps: number;
  currentStepsTotal: number;
  totalRows: number;
  log: string[];
  errors: string[];
  onCancel: () => void;
}

export function DownloadProgress({
  isDownloading,
  cancelled,
  currentSymbol,
  currentStep,
  completedCount,
  totalCount,
  currentSteps,
  currentStepsTotal,
  totalRows,
  log,
  errors,
  onCancel,
}: DownloadProgressProps) {
  if (!isDownloading && log.length === 0 && !cancelled) return null;

  // Count finished legs of the in-flight symbol too, so a single-trade download
  // moves through ~33/66/100% instead of sitting at 0% until the end.
  const stepFraction = currentStepsTotal > 0 ? currentSteps / currentStepsTotal : 0;
  const pct = totalCount > 0 ? Math.round(((completedCount + stepFraction) / totalCount) * 100) : 0;

  return (
    <div className="rounded-xl bg-card border border-border overflow-hidden">
      {/* Progress header */}
      <div className="px-4 py-3 flex items-center gap-3">
        <div className="flex-1">
          {isDownloading ? (
            <>
              <div className="flex items-center justify-between text-sm mb-2">
                <span className="text-foreground font-medium">
                  Downloading {currentSymbol} <span className="text-muted-foreground font-normal">{currentStep}</span>
                </span>
                <span className="text-muted-foreground font-mono text-xs">
                  {completedCount}/{totalCount} symbols &middot; {totalRows.toLocaleString()} rows
                </span>
              </div>
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all duration-300"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </>
          ) : cancelled ? (
            <div className="text-sm text-amber-600 dark:text-amber-400 font-medium">
              Download cancelled &mdash; {totalRows.toLocaleString()} rows saved before stopping
            </div>
          ) : (
            <div className="text-sm text-emerald-600 dark:text-emerald-400 font-medium">
              Download complete &mdash; {totalRows.toLocaleString()} rows
              {errors.length > 0 && <span className="text-amber-600 dark:text-amber-400 ml-2">({errors.length} errors)</span>}
            </div>
          )}
        </div>
        {isDownloading && (
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1 text-xs rounded-md bg-red-100 dark:bg-red-500/20 text-red-600 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-500/30 border border-red-400 dark:border-red-500/30 shrink-0"
          >
            Cancel
          </button>
        )}
      </div>

      {/* Log */}
      {log.length > 0 && (
        <details className="border-t border-border">
          <summary className="px-4 py-2 text-[10px] text-muted-foreground uppercase cursor-pointer hover:text-muted-foreground">
            Log ({log.length} entries)
          </summary>
          <div className="px-4 pb-3 max-h-40 overflow-y-auto text-[11px] font-mono text-muted-foreground space-y-0.5">
            {/* Append-only list — position+content is a stable, collision-free key
                (identical lines can repeat, so the line alone is not). */}
            {log.map((line, i) => (
              <div key={`${i}:${line}`} className={line.startsWith('ERROR') ? 'text-red-600 dark:text-red-400' : ''}>
                {line}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
