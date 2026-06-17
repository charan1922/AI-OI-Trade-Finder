'use client';

import { CalendarDays, ChevronsUpDown, Database, Download, Loader2, Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DateRange } from 'react-day-picker';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { SimulatorConfig } from '@/lib/simulator/config';
import type { SimDataset, SimInstrumentKind, SimInterval } from '@/lib/simulator/types';
import type { UseSimulator } from '../_hooks/use-simulator';

interface Suggestion {
  symbol: string;
  name: string;
  securityId: string;
}

const KINDS: { value: SimInstrumentKind; label: string }[] = [
  { value: 'EQUITY', label: 'Equity' },
  { value: 'FUTSTK', label: 'Futures' },
];

const INTERVALS: SimInterval[] = ['1', '5', '15', '60'];

const fieldCls = 'h-9 rounded-md border border-border bg-background px-2 text-sm outline-none focus:border-primary';
const labelCls = 'mb-1 block text-[10px] font-medium uppercase tracking-wider text-muted-foreground';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
/** Date → YYYY-MM-DD (local). */
function toYMD(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
/** YYYY-MM-DD → local Date. */
function fromYMD(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
/** Indian display: 29 May 2026. */
function fmtIN(d: Date): string {
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Configure an F&O stock + date window, download exact real data, then replay it. */
export default function SymbolBar({ sim }: { sim: UseSimulator }) {
  const [symbol, setSymbol] = useState('RELIANCE');
  const [kind, setKind] = useState<SimInstrumentKind>('EQUITY');
  const [interval, setInterval] = useState<SimInterval>('5');
  // Default window: the last weekday (single recent trading session). Computed as
  // lazy initial state — no effect needed, so no setState-in-effect cascade.
  const [range, setRange] = useState<DateRange | undefined>(() => {
    const d = new Date();
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
    return { from: d, to: d };
  });
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [showSuggest, setShowSuggest] = useState(false);
  const [datasets, setDatasets] = useState<SimDataset[]>([]);
  const [downloading, setDownloading] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchDatasets = useCallback(async () => {
    try {
      const res = await fetch('/api/simulator/download');
      const json = await res.json();
      if (json.success) setDatasets(json.data as SimDataset[]);
    } catch {
      // catalog is best-effort
    }
  }, []);

  useEffect(() => {
    // Fetch-on-mount: setState runs after the awaited fetch resolves (async),
    // not synchronously in the effect body — so it doesn't cause a render cascade.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchDatasets();
  }, [fetchDatasets]);

  const querySuggest = (q: string) => {
    setSymbol(q.toUpperCase());
    if (debounce.current) clearTimeout(debounce.current);
    if (q.trim().length < 1) {
      setSuggestions([]);
      return;
    }
    debounce.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/simulator/search?q=${encodeURIComponent(q)}`);
        const json = await res.json();
        if (json.success) {
          setSuggestions(json.data as Suggestion[]);
          setShowSuggest(true);
        }
      } catch {
        // ignore search failures
      }
    }, 200);
  };

  const dates = (): { fromDate: string; toDate: string } | null => {
    if (!range?.from) return null;
    const from = toYMD(range.from);
    const to = toYMD(range.to ?? range.from);
    return { fromDate: from, toDate: to };
  };

  const currentConfig = (): Partial<SimulatorConfig> | null => {
    const d = dates();
    if (!d) return null;
    return {
      symbol: symbol.trim().toUpperCase(),
      instrumentKind: kind,
      interval,
      fromDate: d.fromDate,
      toDate: d.toDate,
      startPaused: true,
    };
  };

  const download = async () => {
    setShowSuggest(false);
    const config = currentConfig();
    if (!config) {
      setMsg({ text: 'Pick a date or date range first.', ok: false });
      return;
    }
    setDownloading(true);
    setMsg(null);
    try {
      const res = await fetch('/api/simulator/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      const json = await res.json();
      if (!res.ok) {
        const hint =
          json.code === 'MASTER_NOT_SYNCED'
            ? 'Sync Master Contracts first (Trading Lab → Master Contracts).'
            : json.code === 'DATA_API_NOT_SUBSCRIBED'
              ? 'Dhan account not subscribed to Data APIs (needed for historical intraday).'
              : json.code === 'DHAN_AUTH'
                ? 'Dhan auth failed — check DHAN_* credentials.'
                : (json.error ?? 'Download failed');
        setMsg({ text: hint, ok: false });
      } else {
        setMsg({
          text: `Downloaded ${json.data.candles} real ${interval}-min candles for ${json.data.symbol}.`,
          ok: true,
        });
        await fetchDatasets();
      }
    } catch (err) {
      setMsg({ text: (err as Error).message, ok: false });
    } finally {
      setDownloading(false);
    }
  };

  const loadCurrent = () => {
    setShowSuggest(false);
    const config = currentConfig();
    if (!config) {
      setMsg({ text: 'Pick a date or date range first.', ok: false });
      return;
    }
    setMsg(null);
    sim.load(config);
  };

  const loadDataset = (key: string) => {
    const d = datasets.find((x) => x.key === key);
    if (!d) return;
    setSymbol(d.symbol);
    setKind(d.instrumentKind);
    setInterval(d.interval as SimInterval);
    setRange({ from: fromYMD(d.fromDate), to: fromYMD(d.toDate) });
    setMsg(null);
    sim.load({
      symbol: d.symbol,
      instrumentKind: d.instrumentKind,
      interval: d.interval as SimInterval,
      fromDate: d.fromDate,
      toDate: d.toDate,
      startPaused: true,
    });
  };

  const rangeLabel = range?.from
    ? range.to && toYMD(range.to) !== toYMD(range.from)
      ? `${fmtIN(range.from)} → ${fmtIN(range.to)}`
      : fmtIN(range.from)
    : 'Pick date(s)';

  return (
    <div className="border-b border-border bg-card/30">
      <div className="flex flex-wrap items-end gap-2.5 px-3 py-2.5">
        {/* Symbol combobox */}
        <div className="relative">
          <span className={labelCls}>F&amp;O Stock</span>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={symbol}
              onChange={(e) => querySuggest(e.target.value)}
              onFocus={() => {
                if (symbol.trim()) querySuggest(symbol);
                setShowSuggest(true);
              }}
              onBlur={() => setTimeout(() => setShowSuggest(false), 150)}
              onKeyDown={(e) => e.key === 'Enter' && download()}
              className={`${fieldCls} w-44 pl-7 pr-7 font-semibold uppercase`}
              placeholder="Search F&O…"
            />
            <ChevronsUpDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          </div>
          {showSuggest && suggestions.length > 0 && (
            <div className="absolute z-40 mt-1 max-h-64 w-72 overflow-auto rounded-md border border-border bg-background py-1 shadow-xl">
              {suggestions.map((s) => (
                <button
                  type="button"
                  key={s.securityId}
                  onMouseDown={() => {
                    setSymbol(s.symbol);
                    setShowSuggest(false);
                  }}
                  className="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs hover:bg-accent"
                >
                  <span className="font-semibold text-foreground">{s.symbol}</span>
                  <span className="ml-2 truncate text-muted-foreground">{s.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Instrument */}
        <div>
          <span className={labelCls}>Instrument</span>
          <div className="flex h-9 overflow-hidden rounded-md border border-border">
            {KINDS.map((k) => (
              <button
                type="button"
                key={k.value}
                onClick={() => setKind(k.value)}
                className={`px-3 text-xs font-medium transition-colors ${
                  kind === k.value
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-background text-muted-foreground hover:bg-accent'
                }`}
              >
                {k.label}
              </button>
            ))}
          </div>
        </div>

        {/* Interval */}
        <div>
          <span className={labelCls}>Interval</span>
          <select value={interval} onChange={(e) => setInterval(e.target.value as SimInterval)} className={fieldCls}>
            {INTERVALS.map((i) => (
              <option key={i} value={i}>
                {i} min
              </option>
            ))}
          </select>
        </div>

        {/* Date range picker (Google-style) */}
        <div>
          <span className={labelCls}>Trading dates (IST)</span>
          <Popover>
            <PopoverTrigger asChild>
              <button type="button" className={`${fieldCls} flex min-w-56 items-center gap-2 text-left`}>
                <CalendarDays className="size-4 text-muted-foreground" />
                <span className={range?.from ? 'text-foreground' : 'text-muted-foreground'}>{rangeLabel}</span>
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="range"
                numberOfMonths={2}
                selected={range}
                onSelect={setRange}
                defaultMonth={range?.from}
                disabled={{ after: new Date() }}
                autoFocus
              />
              <div className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
                NSE/BSE session 09:15–15:30 IST · single day = click one date
              </div>
            </PopoverContent>
          </Popover>
        </div>

        <Button size="sm" variant="outline" className="h-9" onClick={download} disabled={downloading}>
          {downloading ? <Loader2 className="animate-spin" /> : <Download />}
          Download
        </Button>
        <Button size="sm" className="h-9" onClick={loadCurrent} disabled={sim.loading}>
          {sim.loading ? <Loader2 className="animate-spin" /> : null}
          Load Replay
        </Button>

        {/* Saved datasets */}
        {datasets.length > 0 && (
          <div className="ml-auto flex items-center gap-1.5">
            <Database className="size-3.5 text-muted-foreground" />
            <select
              defaultValue=""
              onChange={(e) => e.target.value && loadDataset(e.target.value)}
              className={`${fieldCls} max-w-60`}
              title="Replay a previously downloaded dataset"
            >
              <option value="">Saved data ({datasets.length})…</option>
              {datasets.map((d) => (
                <option key={d.key} value={d.key}>
                  {d.symbol} {d.instrumentKind === 'EQUITY' ? 'EQ' : 'FUT'} {d.interval}m · {d.fromDate}
                  {d.toDate !== d.fromDate ? `→${d.toDate}` : ''} ({d.candles})
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {msg && <div className={`px-3 pb-2 text-xs ${msg.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>{msg.text}</div>}
    </div>
  );
}
