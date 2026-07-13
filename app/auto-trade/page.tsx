'use client';

/**
 * /auto-trade — operator console for the AI execution layer (lib/auto-trade).
 * Admin-only page (lib/auth/rbac.ts). Top: mode/broker/AI selectors + kill
 * switch + caps. Middle: pending approvals (approve/reject) and open/closed
 * trades. Bottom: the append-only decision audit.
 */

import { AlertTriangle, Loader2, Play, RefreshCw, ShieldAlert, Zap } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

interface Settings {
  mode: 'off' | 'paper' | 'approval' | 'live';
  broker: 'fyers' | 'dhan';
  aiProvider: 'azure' | 'mimo';
  killSwitch: boolean;
  maxTradesPerDay: number;
  maxOpenLots: number;
  maxCapitalRupees: number;
  dailyLossHaltRupees: number;
  approvalTtlMin: number;
}
interface TradeRow {
  id: number;
  symbol: string;
  direction: string;
  optionType: string;
  strike: number;
  expiryDate: string;
  lotSize: number;
  lots: number;
  broker: string;
  mode: string;
  status: string;
  entrySpot: number;
  slSpot: number | null;
  targetSpot: number | null;
  entryPremium: number;
  slPremium: number;
  targetPremium: number;
  entryFillPremium: number | null;
  exitFillPremium: number | null;
  exitReason: string | null;
  aiReasonEntry: string;
  aiReasonExit: string | null;
  realizedPnlRupees: number | null;
  proposedAt: string;
  orders?: OrderRow[];
}
interface OrderRow {
  id: number;
  side: string;
  status: string;
  brokerOrderId: string | null;
  avgFillPrice: number | null;
  error: string | null;
  createdAt: string;
}
interface DecisionRow {
  id: number;
  at: string;
  pass: string;
  provider: string | null;
  model: string | null;
  summary: string;
}
interface ApiResponse {
  success: boolean;
  error?: string;
  date?: string;
  nowIST?: string;
  settings?: Settings;
  liveEnvEnabled?: boolean;
  entryWindow?: { opensAt: string; closesAt: string; active: boolean };
  today?: { entriesUsed: number; openLots: number; deployedRupees: number; realizedPnlRupees: number };
  trades?: TradeRow[];
  pending?: TradeRow[];
  decisions?: DecisionRow[];
}

const POLL_MS = 30_000;

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
}

const MODE_DESCRIPTIONS: Record<Settings['mode'], string> = {
  off: 'Dormant — no passes run.',
  paper: 'Simulated fills at real live quotes. Zero risk; full pipeline.',
  approval: 'AI proposes real orders — each one waits for your Approve below.',
  live: 'Fully autonomous real orders. Needs AUTO_TRADE_LIVE_ENABLED=true in env too.',
};

function SelectorRow<T extends string>({
  label,
  value,
  options,
  disabledOptions = [],
  busy,
  onSelect,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  disabledOptions?: T[];
  busy: boolean;
  onSelect: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-24 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      <div className="flex flex-wrap gap-1">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            disabled={busy || disabledOptions.includes(o.value)}
            onClick={() => onSelect(o.value)}
            className={`rounded border px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              o.value === value
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-background text-foreground hover:bg-muted'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * One editable risk cap. Commits on blur / Enter (only when changed), so the
 * budget follows your actual account — set it to your Dhan balance and the
 * scanner picks 1-lot contracts that fit while the auto-trader caps deployed
 * premium here. Server-side validation (settings.ts) is the real guard; min/max
 * are UI hints. /auto-trade is admin-only (rbac ADMIN_ONLY_PAGES), so no extra
 * role gate is needed.
 */
function CapField({
  label,
  value,
  min,
  max,
  step,
  unit = '',
  busy,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  busy: boolean;
  onCommit: (v: string) => void;
}) {
  // Sync the server value into the draft on change WITHOUT an effect (React's
  // "adjust state during render" pattern): a background poll re-sync mid-edit is
  // avoided because `synced` only trips when the committed value actually moves.
  const [draft, setDraft] = useState(String(value));
  const [synced, setSynced] = useState(value);
  if (synced !== value) {
    setSynced(value);
    setDraft(String(value));
  }
  const commit = () => {
    const n = Math.round(Number(draft));
    if (Number.isFinite(n) && n >= min && n <= max && n !== value) onCommit(String(n));
    else setDraft(String(value)); // out-of-range / unchanged → snap back
  };
  return (
    <label className="flex items-center gap-1 text-[11px] text-muted-foreground" title={`${label}: ${min.toLocaleString('en-IN')}–${max.toLocaleString('en-IN')}`}>
      <span>{label}</span>
      {unit && <span>{unit}</span>}
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={step}
        value={draft}
        disabled={busy}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
        className="w-20 rounded border border-border bg-background px-1.5 py-0.5 text-right tabular-nums text-foreground focus:border-primary focus:outline-none disabled:opacity-50"
      />
    </label>
  );
}

function Cap({ label, used, max, unit = '' }: { label: string; used: number; max: number; unit?: string }) {
  const danger = used >= max;
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-sm font-bold tabular-nums ${danger ? 'text-red-600 dark:text-red-400' : 'text-foreground'}`}>
        {unit}{used.toLocaleString('en-IN')} <span className="font-normal text-muted-foreground">/ {unit}{max.toLocaleString('en-IN')}</span>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'open'
      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
      : status === 'closed'
        ? 'bg-slate-100 text-slate-700 dark:bg-slate-500/15 dark:text-slate-300'
        : status === 'pending_approval'
          ? 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300'
          : 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300';
  return <span className={`rounded px-1.5 py-px text-[10px] font-bold uppercase ${cls}`}>{status.replace('_', ' ')}</span>;
}

function TradeCard({ trade, onAction, busy }: { trade: TradeRow; onAction: (action: string, id: number) => void; busy: boolean }) {
  const pnl = trade.realizedPnlRupees;
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm font-bold">{trade.symbol}</span>
        <span className="text-xs text-muted-foreground">
          {trade.strike} {trade.optionType} · exp {trade.expiryDate} · {trade.lots} lot × {trade.lotSize}
        </span>
        <StatusBadge status={trade.status} />
        <span className="rounded border border-border px-1.5 py-px text-[10px] uppercase text-muted-foreground">
          {trade.broker} · {trade.mode}
        </span>
        {pnl != null && (
          <span className={`ml-auto text-sm font-bold tabular-nums ${pnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
            {pnl >= 0 ? '+' : ''}₹{pnl.toLocaleString('en-IN')}
          </span>
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span>spot: entry <b className="text-foreground">{trade.entrySpot}</b> · SL <b className="text-red-600 dark:text-red-400">{trade.slSpot ?? '—'}</b> · target <b className="text-emerald-600 dark:text-emerald-400">{trade.targetSpot ?? '—'}</b></span>
        <span>premium: in ₹{trade.entryFillPremium ?? trade.entryPremium}{trade.exitFillPremium != null ? ` · out ₹${trade.exitFillPremium}` : ` · stop ₹${trade.slPremium} · target ₹${trade.targetPremium}`}</span>
      </div>
      <div className="mt-1.5 text-xs text-foreground/90">{trade.aiReasonEntry}</div>
      {trade.exitReason && <div className="mt-0.5 text-[11px] text-muted-foreground">exit: {trade.exitReason}</div>}
      {trade.orders && trade.orders.length > 0 && (
        <div className="mt-2 rounded border border-border/60 bg-muted/40 p-2 font-mono text-[10.5px] leading-relaxed text-muted-foreground">
          <div className="mb-0.5 font-sans font-semibold uppercase tracking-wide text-[9px] text-muted-foreground/80">Order log</div>
          {trade.orders.map((o) => (
            <div key={o.id} className="flex flex-wrap gap-x-2">
              <span className="text-foreground/80">{fmtTime(o.createdAt)}</span>
              <span className={o.side === 'BUY' ? 'text-sky-600 dark:text-sky-400' : 'text-amber-600 dark:text-amber-400'}>{o.side}</span>
              <span className={o.status === 'filled' ? 'text-emerald-600 dark:text-emerald-400' : o.status === 'rejected' || o.status === 'cancelled' ? 'text-red-600 dark:text-red-400' : ''}>{o.status}</span>
              {o.brokerOrderId && <span>#{o.brokerOrderId}</span>}
              {o.avgFillPrice != null && <span>@₹{o.avgFillPrice}</span>}
              {o.error && <span className="w-full text-red-600 dark:text-red-400">↳ {o.error}</span>}
            </div>
          ))}
        </div>
      )}
      <div className="mt-2 flex gap-2">
        {trade.status === 'pending_approval' && (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => onAction('approve', trade.id)}
              className="rounded bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              Approve — place real order
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onAction('reject', trade.id)}
              className="rounded border border-border px-3 py-1 text-xs font-semibold hover:bg-muted disabled:opacity-50"
            >
              Reject
            </button>
          </>
        )}
        {trade.status === 'open' && trade.entryFillPremium != null && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onAction('exit', trade.id)}
            className="rounded border border-red-500/60 px-3 py-1 text-xs font-semibold text-red-600 hover:bg-red-500/10 disabled:opacity-50 dark:text-red-400"
          >
            Exit now at market
          </button>
        )}
        {trade.status === 'open' && trade.entryFillPremium == null && (
          <button
            type="button"
            disabled={busy}
            title="This entry never confirmed a broker fill — there is no real position. Void clears it without placing any order."
            onClick={() => onAction('void', trade.id)}
            className="rounded border border-amber-500/60 px-3 py-1 text-xs font-semibold text-amber-600 hover:bg-amber-500/10 disabled:opacity-50 dark:text-amber-400"
          >
            Void — no fill confirmed
          </button>
        )}
      </div>
    </div>
  );
}

export default function AutoTradePage() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/auto-trade', { cache: 'no-store' });
      setData((await res.json()) as ApiResponse);
    } catch (err) {
      setData({ success: false, error: (err as Error).message });
    } finally {
      setLoading(false);
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

  const setSetting = useCallback(
    async (key: string, value: string) => {
      setBusy(true);
      setNotice(null);
      try {
        const res = await fetch('/api/auto-trade/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, value }),
        });
        const out = (await res.json()) as { success: boolean; error?: string };
        if (!out.success) setNotice(out.error ?? 'setting update failed');
        await load();
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const doAction = useCallback(
    async (action: string, tradeId?: number) => {
      if (action === 'exit' && !window.confirm('Exit this position at market now?')) return;
      if (action === 'approve' && !window.confirm('Approve and place a REAL order at the broker?')) return;
      if (action === 'void' && !window.confirm('Void this unfilled trade? No broker order is placed — it just clears a row that never confirmed a fill.')) return;
      setBusy(true);
      setNotice(null);
      try {
        const res = await fetch('/api/auto-trade/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, tradeId }),
        });
        const out = (await res.json()) as { success: boolean; message?: string; error?: string; aiSummary?: string };
        setNotice(out.message ?? out.aiSummary ?? out.error ?? (out.success ? 'done' : 'failed'));
        await load();
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const s = data?.settings;
  const today = data?.today;
  const openTrades = (data?.trades ?? []).filter((t) => t.status === 'open');
  const doneTrades = (data?.trades ?? []).filter((t) => t.status !== 'open' && t.status !== 'pending_approval');

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <div className="flex items-center gap-2">
        <Zap className="size-5" />
        <h1 className="text-lg font-bold">Auto Trade</h1>
        <span className="text-xs text-muted-foreground">
          AI executes the scanner&apos;s picks — gates in code, audit below.
          {data?.entryWindow && (
            <> Entry window {data.entryWindow.opensAt}–{data.entryWindow.closesAt}{data.entryWindow.active ? ' · ACTIVE' : ''}</>
          )}
        </span>
        <button
          type="button"
          onClick={() => void load()}
          className="ml-auto rounded border border-border p-1.5 hover:bg-muted"
          title="Refresh"
        >
          {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
        </button>
      </div>

      {data && !data.success && (
        <div className="rounded-md border border-red-500/50 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
          {data.error}
        </div>
      )}
      {notice && (
        <div className="rounded-md border border-border bg-muted/50 p-2 text-xs">{notice}</div>
      )}

      {s && (
        <div className="space-y-3 rounded-lg border border-border bg-card p-4">
          <SelectorRow
            label="Mode"
            value={s.mode}
            busy={busy}
            options={[
              { value: 'off', label: 'Off' },
              { value: 'paper', label: 'Paper' },
              { value: 'approval', label: 'Approval' },
              { value: 'live', label: 'Live' },
            ]}
            onSelect={(v) => void setSetting('mode', v)}
          />
          <p className="pl-26 text-[11px] text-muted-foreground">
            {MODE_DESCRIPTIONS[s.mode]}
            {s.mode === 'live' && !data?.liveEnvEnabled && (
              <span className="ml-1 inline-flex items-center gap-1 font-semibold text-amber-600 dark:text-amber-400">
                <AlertTriangle className="size-3" /> AUTO_TRADE_LIVE_ENABLED is not set — live orders stay blocked.
              </span>
            )}
          </p>
          <SelectorRow
            label="Broker"
            value={s.broker}
            busy={busy}
            options={[
              { value: 'fyers', label: 'Fyers' },
              { value: 'dhan', label: 'Dhan' },
            ]}
            onSelect={(v) => void setSetting('broker', v)}
          />
          <SelectorRow
            label="Decision AI"
            value={s.aiProvider}
            busy={busy}
            options={[
              { value: 'azure', label: 'Azure OpenAI' },
              { value: 'mimo', label: 'MiMo' },
            ]}
            onSelect={(v) => void setSetting('aiProvider', v)}
          />
          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => void setSetting('killSwitch', s.killSwitch ? '0' : '1')}
              className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-bold ${
                s.killSwitch
                  ? 'bg-red-600 text-white hover:bg-red-700'
                  : 'border border-red-500/60 text-red-600 hover:bg-red-500/10 dark:text-red-400'
              }`}
            >
              <ShieldAlert className="size-3.5" />
              {s.killSwitch ? 'KILL SWITCH ON — click to resume' : 'Kill switch'}
            </button>
            <button
              type="button"
              disabled={busy || s.mode === 'off'}
              onClick={() => void doAction('run-pass')}
              className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-xs font-semibold hover:bg-muted disabled:opacity-50"
            >
              <Play className="size-3.5" /> Run a pass now
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-3">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Caps</span>
            <CapField label="Trades/day" value={s.maxTradesPerDay} min={1} max={4} step={1} busy={busy} onCommit={(v) => void setSetting('maxTradesPerDay', v)} />
            <CapField label="Max lots" value={s.maxOpenLots} min={1} max={4} step={1} busy={busy} onCommit={(v) => void setSetting('maxOpenLots', v)} />
            <CapField label="Budget" unit="₹" value={s.maxCapitalRupees} min={10_000} max={200_000} step={5_000} busy={busy} onCommit={(v) => void setSetting('maxCapitalRupees', v)} />
            <CapField label="Loss halt" unit="₹" value={s.dailyLossHaltRupees} min={500} max={20_000} step={500} busy={busy} onCommit={(v) => void setSetting('dailyLossHaltRupees', v)} />
          </div>
          <p className="text-[11px] text-muted-foreground">
            Set <b>Budget</b> to your account balance — the scanner only picks 1-lot contracts that fit it, and the
            auto-trader caps deployed premium here. Always <b>1 lot per trade</b>; <b>Max lots</b> is how many can be open
            at once. E.g. ₹30k budget + 1 lot = one affordable lot at a time; ₹60k + 2 = up to two.
          </p>
        </div>
      )}

      {today && s && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Cap label="Entries today" used={today.entriesUsed} max={s.maxTradesPerDay} />
          <Cap label="Open lots" used={today.openLots} max={s.maxOpenLots} />
          <Cap label="Deployed" used={today.deployedRupees} max={s.maxCapitalRupees} unit="₹" />
          <div className="rounded-md border border-border bg-card px-3 py-2">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Realized P&L</div>
            <div className={`text-sm font-bold tabular-nums ${today.realizedPnlRupees >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
              {today.realizedPnlRupees >= 0 ? '+' : ''}₹{today.realizedPnlRupees.toLocaleString('en-IN')}
            </div>
          </div>
        </div>
      )}

      {(data?.pending?.length ?? 0) > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-bold text-amber-600 dark:text-amber-400">Waiting for your approval</h2>
          {data?.pending?.map((t) => (
            <TradeCard key={t.id} trade={t} onAction={(a, id) => void doAction(a, id)} busy={busy} />
          ))}
        </section>
      )}

      {openTrades.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-bold">Open positions</h2>
          {openTrades.map((t) => (
            <TradeCard key={t.id} trade={t} onAction={(a, id) => void doAction(a, id)} busy={busy} />
          ))}
        </section>
      )}

      {doneTrades.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-bold">Today&apos;s completed</h2>
          {doneTrades.map((t) => (
            <TradeCard key={t.id} trade={t} onAction={(a, id) => void doAction(a, id)} busy={busy} />
          ))}
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-bold">Decision log</h2>
        {(data?.decisions?.length ?? 0) === 0 && (
          <p className="text-xs text-muted-foreground">No passes recorded today.</p>
        )}
        {data?.decisions?.map((d) => (
          <div key={d.id} className="rounded-md border border-border bg-card p-2.5">
            <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wide text-muted-foreground">
              <span>{fmtTime(d.at)}</span>
              <span className="rounded border border-border px-1 py-px font-bold">{d.pass}</span>
              {d.provider && <span>{d.provider}{d.model ? ` · ${d.model}` : ''}</span>}
            </div>
            <div className="mt-1 whitespace-pre-wrap text-xs text-foreground/90">{d.summary}</div>
          </div>
        ))}
      </section>
    </div>
  );
}
