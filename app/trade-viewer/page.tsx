'use client';

import { Database, ExternalLink, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { TradeDetailSection } from './_components/trade-detail';
import type { DataStatus } from './_lib/types';

export default function TradeViewerPage() {
  const [status, setStatus] = useState<DataStatus | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/backtest/tf-validate');
      const data = await res.json();
      if (data.success) setStatus(data.data);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    // Fetch-on-mount: setState runs after the awaited fetch resolves (async),
    // not synchronously in the effect body — so it doesn't cause a render cascade.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchStatus();
  }, [fetchStatus]);

  return (
    <div className="p-4 max-w-7xl mx-auto space-y-3">
      {/* Compact Header */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2 shrink-0">
          <Database className="w-5 h-5 text-primary" />
          <h1 className="text-lg font-bold text-foreground">Trade Viewer</h1>
        </div>
        {status && (
          <div className="flex items-center gap-3 text-xs font-mono">
            <span className="text-muted-foreground">
              EQ <span className="text-foreground">{status.equityRows.toLocaleString()}</span>
            </span>
            <span className="text-muted-foreground">
              FUT <span className="text-foreground">{status.futuresRows.toLocaleString()}</span>
            </span>
            <span className="text-muted-foreground">
              OPT <span className="text-foreground">{status.optionsRows.toLocaleString()}</span>
            </span>
            <span className="text-muted-foreground">|</span>
            <span className="text-muted-foreground font-bold">{status.totalRows.toLocaleString()}</span>
          </div>
        )}
        <div className="flex items-center gap-2 ml-auto">
          <a
            href="/data-downloader"
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 text-[11px] font-medium"
          >
            <ExternalLink className="w-3 h-3" /> Manage Data
          </a>
          <button
            type="button"
            onClick={fetchStatus}
            className="p-1.5 rounded-md bg-muted hover:bg-accent text-muted-foreground"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Trade Detail Section */}
      <TradeDetailSection />
    </div>
  );
}
