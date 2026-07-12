'use client';

import { CloudDownload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useRole } from '@/lib/auth/use-role';

interface BhavStatus {
  rows: number;
  symbols: number;
  dates: number;
  latestDate: string | null;
}

const MON = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-06-08" → "8 Jun '26" — always shows the year so the date is unambiguous. */
function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${Number(d)} ${MON[Number(m)] ?? m} '${y.slice(2)}`;
}

/**
 * NSE bhavcopy freshness + explicit sync (official EOD data backing the
 * daily-context fallback). Sync is user-triggered only, per project convention.
 */
export function BhavcopySync({ onSynced }: { onSynced?: () => void }) {
  const [status, setStatus] = useState<BhavStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const { readOnly } = useRole();

  useEffect(() => {
    let ignore = false;
    fetch('/api/bhavcopy')
      .then((r) => r.json())
      .then((d) => {
        if (!ignore && d.success) setStatus(d.data as BhavStatus);
      })
      .catch(() => {});
    return () => {
      ignore = true;
    };
  }, []);

  const sync = async () => {
    setSyncing(true);
    setMsg(null);
    try {
      // No explicit window — the API auto-covers every loaded trade (earliest
      // downloaded date → today), fetching only dates not already synced.
      const res = await fetch('/api/bhavcopy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const d = await res.json();
      if (d.success) {
        setStatus(d.status as BhavStatus);
        setMsg(
          d.dates > 0
            ? `+${d.dates} day${d.dates > 1 ? 's' : ''} (${d.rows} rows)${d.skipped?.length ? `, ${d.skipped.length} unpublished` : ''}`
            : 'up to date',
        );
        if (d.dates > 0) onSynced?.();
      } else {
        setMsg(`error: ${d.error}`);
      }
    } catch (e) {
      setMsg(`error: ${(e as Error).message}`);
    } finally {
      setSyncing(false);
    }
  };

  // Viewers don't see operator actions at all (the server 403s the sync anyway).
  if (readOnly) return null;

  return (
    <span className="flex items-center gap-1.5">
      {/* Single sync ACTION. The freshness date + "global, all stocks" context
          lives in the tooltip — the per-trade "Futures OI · X/Y sessions" line in
          each trade's detail is where completeness is surfaced, so no visible chip
          is needed here. */}
      <button
        type="button"
        onClick={sync}
        disabled={syncing}
        title={
          status
            ? `Sync official NSE end-of-day data (bhavcopy) — the GLOBAL source behind the Futures OI & Turnover charts. One file covers ALL stocks, so it's shared by every trade. Current through ${status.latestDate ? fmtDate(status.latestDate) : '—'} (${status.dates} days). Click to fetch newer days; only downloads dates not already on disk.`
            : 'Sync official NSE end-of-day data (bhavcopy) — the global source behind the Futures OI & Turnover charts (covers all stocks). Click to fetch the latest days.'
        }
        className="flex items-center gap-1 px-2 py-1 rounded-md border border-border text-[11px] font-medium bg-card text-muted-foreground hover:bg-accent disabled:opacity-50"
      >
        <CloudDownload className={`w-3.5 h-3.5 ${syncing ? 'animate-pulse' : ''}`} />
        {syncing ? 'Syncing…' : 'Sync NSE data'}
      </button>
      {msg && <span className="text-[10px] text-muted-foreground">{msg}</span>}
    </span>
  );
}
