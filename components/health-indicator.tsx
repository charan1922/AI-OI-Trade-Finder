'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type Status = 'ok' | 'warn' | 'down' | 'idle';

interface ServiceBase {
  status: Status;
  detail: string;
}
interface CycleError {
  symbol: string;
  stage: string;
  message: string;
}
interface LastCycle {
  startedAt: string;
  symbolsProcessed: number;
  universeSize: number;
  errors: CycleError[];
  skipped?: string;
}
interface HealthResp {
  ok: boolean;
  ts: string;
  marketOpen: boolean;
  services: {
    dhan: ServiceBase & { tokenExpiresAt: number | null };
    fyers: ServiceBase & { tokenExpiresAt: number | null; lastCycle: LastCycle | null };
    nse: ServiceBase & { lastSuccessAt: number };
  };
}

const POLL_MS = 60_000;

const DOT: Record<Status, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  down: 'bg-red-500',
  idle: 'bg-slate-400',
};
const TEXT: Record<Status, string> = {
  ok: 'text-emerald-600 dark:text-emerald-400',
  warn: 'text-amber-600 dark:text-amber-400',
  down: 'text-red-600 dark:text-red-400',
  idle: 'text-muted-foreground',
};
const LABEL: Record<Status, string> = { ok: 'OK', warn: 'Warning', down: 'Down', idle: 'Idle' };

/** Worst status wins for the collapsed summary dot. */
const RANK: Record<Status, number> = { down: 3, warn: 2, idle: 1, ok: 0 };

function fmtClock(ms: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
}
function fmtAgo(ms: number | null): string {
  if (!ms) return '—';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export function HealthIndicator() {
  const [data, setData] = useState<HealthResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/health/services', { cache: 'no-store' });
      const j = (await res.json()) as HealthResp;
      setData(j);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    let stopped = false;
    const kick = setTimeout(() => {
      if (!stopped) void load();
    }, 0);
    const t = setInterval(() => {
      if (!stopped) void load();
    }, POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(kick);
      clearInterval(t);
    };
  }, [load]);

  // Close the panel on outside click.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const svc = data?.services;
  const statuses: Status[] = svc ? [svc.dhan.status, svc.fyers.status, svc.nse.status] : ['idle', 'idle', 'idle'];
  const worst = statuses.reduce<Status>((w, s) => (RANK[s] > RANK[w] ? s : w), 'ok');

  const rows: { key: string; name: string; s?: ServiceBase; extra?: React.ReactNode }[] = svc
    ? [
        {
          key: 'dhan',
          name: 'Dhan',
          s: svc.dhan,
          extra: svc.dhan.tokenExpiresAt ? <>token → {fmtClock(svc.dhan.tokenExpiresAt)}</> : null,
        },
        {
          key: 'fyers',
          name: 'Fyers',
          s: svc.fyers,
          extra: (
            <>
              {svc.fyers.tokenExpiresAt ? <>token → {fmtClock(svc.fyers.tokenExpiresAt)} · </> : null}
              {svc.fyers.lastCycle ? <>cycle {fmtAgo(Date.parse(svc.fyers.lastCycle.startedAt))}</> : 'no cycle yet'}
            </>
          ),
        },
        {
          key: 'nse',
          name: 'NSE',
          s: svc.nse,
          extra: svc.nse.lastSuccessAt ? <>fetched {fmtAgo(svc.nse.lastSuccessAt)}</> : null,
        },
      ]
    : [];

  return (
    <div className="relative" ref={boxRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Data provider health — click for details"
        className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <span className="flex items-center gap-1">
          {(['D', 'F', 'N'] as const).map((letter, i) => (
            <span key={letter} className="flex items-center gap-0.5">
              <span className={`inline-block h-1.5 w-1.5 rounded-full ${DOT[statuses[i]]} ${worst === 'down' ? 'animate-pulse' : ''}`} />
              <span className="text-[10px]">{letter}</span>
            </span>
          ))}
        </span>
        <span className="hidden sm:inline">Health</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-72 rounded-lg border border-border bg-popover p-2 text-xs shadow-lg">
          <div className="mb-1.5 flex items-center justify-between px-1">
            <span className="font-semibold text-foreground">Data providers</span>
            <span className="text-[10px] text-muted-foreground">
              {data ? (data.marketOpen ? 'market open' : 'market closed') : '…'}
            </span>
          </div>

          {error && <div className="px-1 py-2 text-red-600">{error}</div>}

          <div className="space-y-1.5">
            {rows.map((r) => (
              <div key={r.key} className="rounded-md border border-border/60 px-2 py-1.5">
                <div className="flex items-center gap-2">
                  <span className={`inline-block h-2 w-2 rounded-full ${DOT[r.s?.status ?? 'idle']}`} />
                  <span className="font-semibold text-foreground">{r.name}</span>
                  <span className={`ml-auto text-[10px] font-medium ${TEXT[r.s?.status ?? 'idle']}`}>
                    {LABEL[r.s?.status ?? 'idle']}
                  </span>
                </div>
                <div className="mt-0.5 pl-4 text-[10.5px] leading-snug text-muted-foreground">{r.s?.detail}</div>
                {r.extra && <div className="pl-4 text-[10px] text-muted-foreground/70">{r.extra}</div>}
                {r.key === 'fyers' && svc?.fyers.lastCycle?.errors?.length ? (
                  <div className="mt-0.5 pl-4 text-[10px] text-amber-600 dark:text-amber-400">
                    {svc.fyers.lastCycle.errors.length} error(s): {svc.fyers.lastCycle.errors[0]?.message?.slice(0, 60)}
                  </div>
                ) : null}
              </div>
            ))}
          </div>

          <div className="mt-1.5 flex items-center justify-between px-1 text-[10px] text-muted-foreground/70">
            <span>checked {data ? fmtAgo(Date.parse(data.ts)) : '…'}</span>
            <button type="button" onClick={() => void load()} className="hover:text-foreground">
              refresh
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
