'use client';

import { ArrowDown, ArrowUp, Check, CircleDashed, ChevronsUpDown, Target, TriangleAlert, Zap } from 'lucide-react';
import { cloneElement, type ReactElement, useMemo, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { BreakoutGrade } from '@/lib/breakout';
import { setupScore, type SetupVerdict } from '../_lib/setup-score';
import type { LiveUrgencyRow } from '../_lib/types';

const num = (n: number | null, d = 2): string => (n == null ? '—' : n.toFixed(d));

/** Compact Indian-style magnitude for OI / turnover (K / L / Cr). */
function fmtCompact(n: number | null): string {
  if (n == null || n <= 0) return '—';
  if (n >= 1e7) return `${(n / 1e7).toFixed(2)}Cr`;
  if (n >= 1e5) return `${(n / 1e5).toFixed(2)}L`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}

/** ₹ Crore value (already in Cr): whole Cr above 100, one decimal below. */
function fmtCr(n: number | null | undefined): string {
  if (n == null || n <= 0) return '—';
  return n >= 100 ? `₹${Math.round(n)}Cr` : `₹${n.toFixed(1)}Cr`;
}

/** Exact integer with Indian grouping (e.g. 72,706) — for NSE OI / volume counts,
 *  shown verbatim as NSE reports them (never abbreviated). */
function fmtInt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return '—';
  return Math.round(n).toLocaleString('en-IN');
}

/**
 * Options-share cell — options premium as a fraction of the fut+opt traded value.
 * High = the OI build is options-LED (the action is in options, our instrument);
 * low = futures-led. A ratio, so it doesn't ratchet through the day like the raw
 * cumulative values do. "—" when the feed doesn't cover the name.
 */
function OptShareCell({ v }: { v: number | null | undefined }) {
  if (v == null) return <span className="text-muted-foreground/50">—</span>;
  const pct = Math.round(v * 100);
  const cls =
    v >= 0.2
      ? 'font-semibold text-violet-600 dark:text-violet-400'
      : v >= 0.1
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-muted-foreground';
  const lead =
    v >= 0.2
      ? 'options-LED build — the money is in the options (our instrument)'
      : v >= 0.1
        ? 'meaningful options participation'
        : 'futures-led build';
  return (
    <span
      className={`tabular-nums ${cls}`}
      title={`Options premium is ${pct}% of this underlying's futures+options traded value — ${lead}. A ratio, so unlike the raw values it doesn't just grow through the day.`}
    >
      {pct}%
    </span>
  );
}

/** Spread %: tight = liquid/cheap to trade (green); wide = illiquid (red). */
function spreadCls(p: number | null): string {
  if (p == null) return 'text-muted-foreground/50';
  if (p < 0.1) return 'text-emerald-600 dark:text-emerald-400';
  if (p < 0.3) return 'text-amber-600 dark:text-amber-400';
  return 'text-red-600 dark:text-red-400';
}

/**
 * Intraday OI-build cell — the session's OI change so far, colored by urgency
 * (rate of build). Distinct from the static OI level. "—" until enough intraday
 * snapshots have accumulated today (never fabricated).
 */
function OiBuild({ r }: { r: LiveUrgencyRow }) {
  if (r.oiUrgency == null || r.sessionOiChangePct == null) {
    return <span className="text-muted-foreground/50">—</span>;
  }
  const up = r.sessionOiChangePct >= 0;
  const cls =
    r.oiUrgency >= 5
      ? 'font-semibold text-emerald-600 dark:text-emerald-400'
      : r.oiUrgency >= 3
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-muted-foreground';
  return (
    <span
      className={`tabular-nums ${cls}`}
      title={`urgency ${r.oiUrgency.toFixed(1)}/10 · velocity ${r.oiVelocity?.toFixed(2) ?? '—'}‰/min · accel ${r.oiAccel?.toFixed(2) ?? '—'} — rate of fresh OI build this session`}
    >
      {up ? '+' : ''}
      {r.sessionOiChangePct.toFixed(1)}% {up ? '▲' : '▼'}
    </span>
  );
}

/** Order-book imbalance bar: bid-heavy (green) vs ask-heavy (red). */
function Imbalance({ v }: { v: number | null }) {
  if (v == null) return <span className="text-muted-foreground/50">—</span>;
  const bidPct = Math.round(v * 100);
  const cls = v > 0.55 ? 'bg-emerald-500' : v < 0.45 ? 'bg-red-500' : 'bg-slate-400';
  const label = v > 0.55 ? 'bid-heavy' : v < 0.45 ? 'ask-heavy' : 'balanced';
  return (
    <div className="flex items-center justify-end gap-1.5" title={`${bidPct}% resting bid — ${label}`}>
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
        <div className={`h-full ${cls}`} style={{ width: `${bidPct}%` }} />
      </div>
      <span className="w-9 text-right text-muted-foreground tabular-nums">{bidPct}%</span>
    </div>
  );
}

const SETUP_STYLE: Record<SetupVerdict['level'], { cls: string; label: string }> = {
  strong: {
    cls: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
    label: 'Strong',
  },
  watch: {
    cls: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
    label: 'Watch',
  },
  quiet: {
    cls: 'bg-slate-500/10 text-slate-600 dark:text-slate-400',
    label: 'Quiet',
  },
  illiquid: { cls: 'bg-muted text-muted-foreground', label: 'Illiquid' },
};

function SignalTooltip({ children, items }: { children: ReactElement; items: string[] }) {
  const body = (
    <div className="flex flex-col gap-2 text-xs leading-relaxed">
      {items.map((item, index) => {
        const marker = item.at(0);
        const Icon =
          marker === '↗'
            ? ArrowUp
            : marker === '↘'
              ? ArrowDown
              : marker === '✓'
                ? Check
                : marker === '⚠'
                  ? TriangleAlert
                  : marker === '⚡'
                    ? Zap
                    : marker === '◎'
                      ? Target
                      : marker === '○'
                        ? CircleDashed
                        : null;
        const text = Icon ? item.slice(2) : item;
        return (
          <div key={`${item}-${index}`} className="flex items-start gap-2">
            {Icon != null && <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden />}
            <p>{text}</p>
          </div>
        );
      })}
    </div>
  );

  return (
    <>
      <span className="hidden sm:inline-flex">
        <TooltipProvider delayDuration={160}>
          <Tooltip>
            <TooltipTrigger asChild>{cloneElement(children)}</TooltipTrigger>
            <TooltipContent
              side="top"
              sideOffset={8}
              className="max-w-72 items-start border bg-popover whitespace-normal text-popover-foreground shadow-md [&>svg]:bg-popover [&>svg]:fill-popover"
            >
              {body}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </span>
      <span className="sm:hidden">
        <Popover>
          <PopoverTrigger asChild>{cloneElement(children)}</PopoverTrigger>
          <PopoverContent side="top" sideOffset={8} className="max-w-72 p-3">
            {body}
          </PopoverContent>
        </Popover>
      </span>
    </>
  );
}

function simpleSetupReason(reason: string): string {
  if (reason === 'price up + bid-heavy book (demand)')
    return '↗ Price is rising and more buyers are waiting than sellers.';
  if (reason === 'price down + ask-heavy book (supply)')
    return '↘ Price is falling and more sellers are waiting than buyers.';
  if (reason === 'price & book not aligned') return '⚠ Price and buyer/seller pressure do not agree yet.';
  if (reason === 'no order book' || reason === 'direction unavailable')
    return '○ There is not enough live buy-and-sell data yet.';
  if (reason.includes('too wide')) return '⚠ Buy and sell prices are too far apart, so trading may cost more.';
  if (reason.startsWith('liquid')) return '✓ Easy to trade right now: the buy/sell price gap is small.';
  if (reason.startsWith('OI building')) return '⚡ New positions are being added quickly, showing fresh interest.';
  if (reason.startsWith('OI '))
    return reason
      .replace(/^OI/, 'Open positions')
      .replace('heavy positioning', 'more positions than usual')
      .replace('near normal', 'close to normal');
  if (reason.startsWith('moved ') || reason.startsWith('already moved '))
    return "Most of today's move may already be over, so entering now could be late.";
  return reason.replace('OI level unknown (no baseline)', 'Position data is not available yet.');
}

function SetupBadge({ v }: { v: SetupVerdict }) {
  const s = SETUP_STYLE[v.level];
  const arrow = v.bias === 'bullish' ? '\u2191' : v.bias === 'bearish' ? '\u2193' : null;
  return (
    <SignalTooltip items={v.reasons.map(simpleSetupReason)}>
      <span
        tabIndex={0}
        className={`inline-flex cursor-default items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-semibold whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${s.cls}`}
      >
        <span>{s.label}</span>
        {arrow != null && <span aria-hidden="true">{arrow}</span>}
      </span>
    </SignalTooltip>
  );
}

/** TF-breakout badge styling per grade (see lib/breakout). */
const BREAKOUT_STYLE: Record<BreakoutGrade, { cls: string; label: string }> = {
  strong: {
    cls: 'bg-emerald-500/20 font-bold text-emerald-700 dark:text-emerald-300',
    label: 'Strong BO',
  },
  confirmed: {
    cls: 'bg-emerald-500/10 font-semibold text-emerald-700 dark:text-emerald-300',
    label: 'Breakout',
  },
  watch: {
    cls: 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
    label: 'Base held',
  },
  'fakeout-risk': {
    cls: 'bg-orange-500/15 font-semibold text-orange-700 dark:text-orange-300',
    label: 'Fakeout?',
  },
  none: { cls: '', label: '' },
};

/** Sortable rank for the TF-breakout verdict (grade first, then levels cleared). */
export function breakoutRank(r: LiveUrgencyRow): number {
  const b = r.breakout;
  if (b == null || b.grade === 'none') return 0;
  const base: Record<BreakoutGrade, number> = {
    strong: 4,
    confirmed: 3,
    watch: 2,
    'fakeout-risk': 1,
    none: 0,
  };
  return base[b.grade] + Math.min(b.levelsCleared, 9) / 10;
}

/**
 * TradeFinder breakout cell — the 3-check verdict (morning test · R-Factor
 * efficiency · levels cleared) with the level count and direction arrow.
 * "—" until today's candles are recorded (never fabricated).
 */
function BreakoutCell({ r }: { r: LiveUrgencyRow }) {
  const b = r.breakout;
  if (b == null) return <span className="text-muted-foreground/50">\u2014</span>;
  if (b.grade === 'none')
    return (
      <span className="text-muted-foreground/50" title={b.detail}>
        {b.morningTest === 'pending' ? '\u2026' : '\u2014'}
      </span>
    );

  const s = BREAKOUT_STYLE[b.grade];
  const arrow = b.direction === 'bullish' ? '\u2191' : b.direction === 'bearish' ? '\u2193' : null;
  const levelLabel = b.levelsCleared > 0 ? `${b.levelsCleared}L` : null;
  const details = [
    b.direction === 'bullish' ? '↗ Price is moving up.' : '↘ Price is moving down.',
    b.morningTest === 'held'
      ? b.direction === 'bullish'
        ? '✓ The early low is holding, so buyers are supporting dips.'
        : '✓ The early high is holding, so sellers remain in control.'
      : b.morningTest === 'pending'
        ? 'The first 15-minute check is not ready yet.'
        : '⚠ The early price level broke, so this could be a false breakout.',
    b.levelsCleared
      ? `Price crossed ${b.levelsCleared} key level${b.levelsCleared > 1 ? 's' : ''}: ${b.clearedNames.join(', ')}.`
      : 'Price has not crossed a key level yet.',
    b.grade === 'strong' ? '⚡ Price and trading activity are moving together well.' : '',
    b.nextLevel ? `Next level to watch: ${b.nextLevel.name} near ${b.nextLevel.price.toFixed(2)}.` : '',
  ].filter(Boolean) as string[];

  return (
    <SignalTooltip items={details}>
      <span
        tabIndex={0}
        className={`inline-flex cursor-default items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${s.cls}`}
      >
        <span>{s.label}</span>
        {levelLabel != null && <span>{levelLabel}</span>}
        {arrow != null && <span aria-hidden="true">{arrow}</span>}
      </span>
    </SignalTooltip>
  );
}

/**
 * "Since 9:45" cell — price change since the entry window opened. THE freshness
 * read: a big Chg% with ~0 here means the whole move came at the open
 * (gap-and-flat) and is likely spent. "—" before 09:45 / no recorded series.
 */
function SinceEntryCell({ r }: { r: LiveUrgencyRow }) {
  const v = r.sinceEntryPct;
  if (v == null) return <span className="text-muted-foreground/50">—</span>;
  const spent = r.changePctOpen != null && Math.abs(r.changePctOpen) >= 3 && Math.abs(v) < 1;
  const cls = spent
    ? 'font-semibold text-orange-600 dark:text-orange-400'
    : v >= 0
      ? 'text-emerald-600 dark:text-emerald-400'
      : 'text-red-600 dark:text-red-400';
  const tip = spent
    ? `Moved ${r.changePctOpen!.toFixed(1)}% today but only ${v >= 0 ? '+' : ''}${v.toFixed(2)}% since 09:45 — the move came at the open (gap-and-flat), likely spent. Chasing it is the classic trap.`
    : `Price change since 09:45 IST (when the entry window opens) — what the move has offered AFTER the open. Fresh trends keep giving here; spent spikes show ~0.`;
  return (
    <span className={`tabular-nums ${cls}`} title={tip}>
      {v >= 0 ? '+' : ''}
      {v.toFixed(2)}%{spent ? ' ⚠' : ''}
    </span>
  );
}

/**
 * NSE combined (fut+opt) %Chng in OI — the LIVE oi-spurts feed value (`avgInOI`),
 * shown exactly as NSE reports it (2 dp) so it matches NSE's site. This is the
 * number NSE ranks its F&O OI Build-up list by. NOT our recorded snapshot (that
 * lagged the feed — the source of the old 37.2% vs 38.51% mismatch).
 */
function NseChgOiCell({ v }: { v: number | null | undefined }) {
  if (v == null) return <span className="text-muted-foreground/50">—</span>;
  const cls =
    v >= 10
      ? 'font-semibold text-emerald-600 dark:text-emerald-400'
      : v >= 3
        ? 'text-emerald-600 dark:text-emerald-400'
        : v <= -3
          ? 'text-red-600 dark:text-red-400'
          : 'text-muted-foreground';
  return (
    <span
      className={`tabular-nums ${cls}`}
      title={`NSE oi-spurts %Chng in OI (avgInOI) = ${v >= 0 ? '+' : ''}${v.toFixed(2)}% — combined futures+options open interest vs yesterday's close, straight from NSE's live feed (matches nseindia.com exactly).`}
    >
      {v >= 0 ? '+' : ''}
      {v.toFixed(2)}%
    </span>
  );
}

/**
 * App-derived 30-min build RATE of NSE combined OI — computed by us from the
 * poller's recorded 5-min series (not an NSE column). Answers "is the OI still
 * piling on RIGHT NOW, or did it build earlier and stall?" "—" until enough
 * points are recorded.
 */
function AppOiSlopeCell({ v }: { v: number | null | undefined }) {
  if (v == null) return <span className="text-muted-foreground/50">—</span>;
  const cls =
    v >= 0.5
      ? 'font-semibold text-emerald-600 dark:text-emerald-400'
      : v <= -0.5
        ? 'text-red-600 dark:text-red-400'
        : 'text-muted-foreground';
  const state = v >= 0.5 ? 'still building NOW' : v <= -0.5 ? 'unwinding' : 'flat — built earlier, stalled';
  return (
    <span
      className={`tabular-nums ${cls}`}
      title={`Our derived build rate: NSE combined-OI % change over the last ~30 min, from our recorded 5-min series — ${state}.`}
    >
      {v >= 0 ? '+' : ''}
      {v.toFixed(2)}
      {v >= 0.5 ? ' ▲' : v <= -0.5 ? ' ▼' : ''}
    </span>
  );
}

/** Turnover level — cumulative futures turnover vs its time-of-day-adjusted 20d norm. */
function TurnoverLvlCell({ v }: { v: number | null | undefined }) {
  if (v == null) return <span className="text-muted-foreground/50">—</span>;
  const cls =
    v >= 2
      ? 'font-semibold text-emerald-600 dark:text-emerald-400'
      : v >= 1.5
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-muted-foreground';
  return (
    <span
      className={`tabular-nums ${cls}`}
      title={`Futures turnover ${v.toFixed(2)}× its 20-day average, adjusted for the time of day — is real money flowing at an unusual pace RIGHT NOW. Decays through the day if the flow dies (unlike raw cumulative turnover).`}
    >
      {v.toFixed(2)}×
    </span>
  );
}

const BIAS_STYLE: Record<'buy' | 'sell' | 'neutral', { arrow: string; cls: string }> = {
  buy: { arrow: '▲', cls: 'text-emerald-600 dark:text-emerald-400' },
  sell: { arrow: '▼', cls: 'text-red-600 dark:text-red-400' },
  neutral: { arrow: '·', cls: 'text-muted-foreground' },
};

/**
 * R-Factor cell — the App's point-in-time approximation of TF's 0–10 score,
 * plus the App factor-vote direction. The estimate is display evidence only;
 * TF's captured value remains the trading selector's source of truth.
 */
function RFactorCell({ r }: { r: LiveUrgencyRow }) {
  if (r.rFactor == null) return <span className="text-muted-foreground/50">—</span>;
  const bias = r.rFactorBias ?? 'neutral';
  const b = BIAS_STYLE[bias];
  const strengthCls =
    r.rFactor >= 2
      ? 'font-bold text-emerald-600 dark:text-emerald-400'
      : r.rFactor >= 1
        ? 'font-semibold text-amber-600 dark:text-amber-400'
        : 'text-muted-foreground';

  const conf = r.rFactorConfidence != null ? `${Math.round(r.rFactorConfidence * 100)}%` : '—';
  const factors = r.rFactors ?? [];
  const active = factors
    .filter((f) => f.available)
    .map((f) => `• ${f.label}: ${f.score.toFixed(2)}${f.vote !== 'neutral' ? ` (${f.vote})` : ''} — ${f.detail}`)
    .join('\n');
  const naLabels = factors.filter((f) => !f.available).map((f) => f.label);

  const tip = [
    `App estimate ${r.rFactor.toFixed(2)} / 10 · factor-vote bias ${bias} · agreement ${conf}`,
    'Approximates TradeFinder R-Factor from the same-time App snapshot. Display evidence only: actual TF R-Factor and its measured gates remain the trading source of truth.',
    r.rFactorAfterEntry === false ? '⚠ before the 09:45 IST entry window — may be opening noise' : '',
    '',
    active,
    naLabels.length ? `\nNot available: ${naLabels.join(', ')}` : '',
    '\nCalibrated on 27,060 point-in-time pairs across 4 sessions; held-out-day MAE 0.31, correlation 0.59. Limited history means this remains approximate.',
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <span className={`inline-flex cursor-help items-center gap-1 tabular-nums ${strengthCls}`} title={tip}>
      {r.rFactor.toFixed(1)}
      <span className={b.cls}>{b.arrow}</span>
    </span>
  );
}


type SortKey =
  // identity / price
  | 'rank'
  | 'symbol'
  | 'ltp'
  | 'changePctOpen'
  // App block — our computed / derived signals
  | 'rFactor'
  | 'setup'
  | 'breakout'
  | 'sinceEntryPct'
  | 'spreadPct'
  | 'imbalance'
  | 'futOi'
  | 'oiLevel'
  | 'oiUrgency'
  | 'nseOptShare'
  | 'nseOiSlope30m'
  | 'turnoverLvl'
  | 'turnover'
  // NSE block — verbatim oi-spurts feed values
  | 'nseChgOiPct'
  | 'nseChangeInOi'
  | 'nseLatestOi'
  | 'nsePrevOi'
  | 'nseVolume'
  | 'nseFutValueCr'
  | 'nsePremValueCr'
  | 'nseOptValueCr'
  | 'nseTotalValueCr'
  | 'nseUnderlyingValue'
  | 'tfRFactor';
/** `origRank` = the row's 1-based position in the incoming watchlist (= NSE Movers order). */
type Row = LiveUrgencyRow & { verdict: SetupVerdict; origRank: number };

// ── Sticky-table styling (opaque backgrounds required on sticky cells so scrolled
//    content never shows through; color-mix keeps zebra/hover states theme-correct
//    in light AND dark because it derives from the same --muted/--card tokens). ──
/** Opaque header background for both sticky header rows. */
const HDR_BG = 'bg-[color-mix(in_oklab,var(--muted)_75%,var(--card))]';
/** Sticky body-cell background, matching the row's zebra + hover states. */
const STICKY_TD =
  'sticky z-10 bg-card group-even:bg-[color-mix(in_oklab,var(--muted)_30%,var(--card))] group-hover:bg-[color-mix(in_oklab,var(--muted)_60%,var(--card))]';
/** Hairline marking the right edge of the sticky identity columns. */
const STICKY_EDGE = 'border-r border-border';
/** Hairline marking the start of a column block (App / NSE). */
const BLOCK_EDGE = 'border-l border-border';

/** Sortable header cell — top-level so React doesn't remount it every render. */
function Th({
  label,
  col,
  align = 'right',
  title,
  className = '',
  sortKey,
  sortDir,
  onSort,
}: {
  label: string;
  col: SortKey;
  align?: 'left' | 'right' | 'center';
  title?: string;
  /** Extra classes — sticky offsets / block hairlines. */
  className?: string;
  sortKey: SortKey;
  sortDir: 'asc' | 'desc';
  onSort: (key: SortKey) => void;
}) {
  const active = sortKey === col;
  const justify = align === 'left' ? 'justify-start' : align === 'center' ? 'justify-center' : 'justify-end';
  const textAlign = align === 'left' ? 'text-left' : align === 'center' ? 'text-center' : 'text-right';
  return (
    <th
      className={`sticky top-6 z-20 border-b border-border ${HDR_BG} px-1.5 py-1 font-semibold ${textAlign} ${className}`}
      title={title}
    >
      <button
        type="button"
        onClick={() => onSort(col)}
        className={`flex w-full items-center gap-1 whitespace-nowrap ${justify} hover:text-foreground ${active ? 'text-foreground' : ''}`}
      >
        <span>{label}</span>
        {active ? (
          sortDir === 'asc' ? (
            <ArrowUp className="h-3 w-3" />
          ) : (
            <ArrowDown className="h-3 w-3" />
          )
        ) : (
          <ChevronsUpDown className="h-3 w-3 opacity-30" />
        )}
      </button>
    </th>
  );
}

const sortValue = (r: Row, key: SortKey): number | string => {
  if (key === 'rank') return r.origRank;
  if (key === 'setup') return r.verdict.rank;
  if (key === 'symbol') return r.symbol;
  if (key === 'rFactor') return r.rFactor ?? Number.NEGATIVE_INFINITY;
  if (key === 'breakout') return breakoutRank(r);
  // Since-9:45 sorts by MAGNITUDE, not signed value: what matters is how far a
  // name has travelled since the entry window opened, and a hard move down is
  // as informative as one up (it is the PE side of the same board). So −7.6
  // outranks +6.0 outranks −5.9 outranks +3.0 (operator's own example,
  // 2026-08-11). Direction is still visible in the cell's colour and sign.
  if (key === 'sinceEntryPct') {
    const v = r.sinceEntryPct;
    return v == null ? Number.NEGATIVE_INFINITY : Math.abs(v);
  }
  return (r[key] as number | null) ?? Number.NEGATIVE_INFINITY;
};

export function UrgencyTable({ rows, sectors }: { rows: LiveUrgencyRow[]; sectors?: Record<string, string> }) {
  // Default: biggest move SINCE 09:45, either direction first (operator request,
  // 2026-08-11). This used to open in watchlist order to mirror /nse/movers, but
  // that order says nothing about which names are actually doing something right
  // now — Since-9:45 is the freshness read, so the board opens on whatever has
  // travelled furthest since the entry window opened. Headers stay sortable, and
  // 'rank' is still one click away for the /nse/movers ordering.
  const [sortKey, setSortKey] = useState<SortKey>('sinceEntryPct');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const onSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir(key === 'rank' || key === 'symbol' || key === 'spreadPct' ? 'asc' : 'desc');
    }
  };

  const sorted = useMemo<Row[]>(() => {
    const withVerdict: Row[] = rows.map((r, i) => ({
      ...r,
      verdict: setupScore(r),
      origRank: i + 1,
    }));
    const dir = sortDir === 'asc' ? 1 : -1;
    return withVerdict.sort((a, b) => {
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      let cmp = typeof av === 'string' || typeof bv === 'string' ? String(av).localeCompare(String(bv)) : av - bv;
      // Tie-break: stronger setup first, then tighter spread.
      if (cmp === 0) cmp = b.verdict.rank - a.verdict.rank;
      if (cmp === 0) cmp = (a.spreadPct ?? Infinity) - (b.spreadPct ?? Infinity);
      return cmp * dir;
    });
  }, [rows, sortKey, sortDir]);

  const th = { sortKey, sortDir, onSort };

  return (
    // Both axes scroll INSIDE this card (max-h) so the block captions + sort
    // headers stay pinned on top and #/Symbol stay pinned left — the page body
    // itself never scrolls horizontally.
    <div className="relative max-h-[75vh] overflow-auto rounded-xl border border-border bg-card">
      <table className="w-full text-[10px]">
        <thead className="text-muted-foreground">
          {/* Column-block captions — the source split the columns are named for. */}
          <tr className="text-[9px] font-semibold tracking-wider uppercase">
            <th
              colSpan={2}
              className={`sticky top-0 left-0 z-40 h-6 border-b border-border ${HDR_BG} ${STICKY_EDGE}`}
              aria-hidden
            />
            <th
              colSpan={17}
              className={`sticky top-0 z-30 h-6 border-b border-border ${HDR_BG} ${BLOCK_EDGE} px-2 text-left`}
            >
              App + TF — TF R-Factor is TradeFinder&apos;s own number, everything else computed by us (live Dhan/Fyers signals)
            </th>
            <th
              colSpan={10}
              className={`sticky top-0 z-30 h-6 border-b border-border ${HDR_BG} ${BLOCK_EDGE} px-2 text-left`}
            >
              NSE — oi-spurts feed, verbatim (matches nseindia.com)
            </th>
          </tr>
          <tr>
            {/* identity / price */}
            <Th
              label="#"
              col="rank"
              align="right"
              className="left-0 !z-30 w-10 min-w-10"
              title="Watchlist order — same as NSE Movers. Default sort; click any header to re-rank."
              {...th}
            />
            <Th
              label="Symbol"
              col="symbol"
              align="left"
              className={`left-10 !z-30 min-w-[7.5rem] ${STICKY_EDGE}`}
              {...th}
            />
            {/* ── App block: our computed / derived signals (NOT NSE feed values) ── */}
            <Th
              label="App R-Factor"
              col="rFactor"
              align="right"
              className={BLOCK_EDGE}
              title="Our point-in-time estimate of TradeFinder's 0–10 R-Factor, calibrated on captured TF boards. Approximate and display-only; the actual TF R-Factor column remains the source of truth for trading. Hover for validation evidence and factor details."
              {...th}
            />
            <Th
              label="TF R-Factor"
              col="tfRFactor"
              align="right"
              title="TradeFinder's OWN R-Factor for this stock, from the most recent successful capture on /tf — not our estimate of it. Captured periodically, not live: can lag by minutes to a day. '—' until /tf has captured this symbol at least once."
              {...th}
            />
            <Th
              label="App Setup"
              col="setup"
              align="left"
              title="Our one-word verdict for this stock right now: Strong / Watch / Quiet / Illiquid. It combines the other columns so you don't have to. Click to sort strongest first — full rules in 'How to read'."
              {...th}
            />
            <Th
              label="App Breakout"
              col="breakout"
              align="left"
              title="Our breakout check — 3 simple tests: (1) did the morning low hold all day? (buyers defending every dip), (2) is the move smooth, not forced?, (3) how many important price levels did it cross (opening range, yesterday's high, 20-day high…)? 'Fakeout?' = price is crossing levels but the morning floor already broke — those breakouts usually fail. Hover a badge for details."
              {...th}
            />
            <Th label="LTP" col="ltp" align="right" title="Last traded price, live." {...th} />
            <Th
              label="Chg%"
              col="changePctOpen"
              align="right"
              title="How far the price has moved since today's open."
              {...th}
            />
            <Th
              label="App Since 9:45"
              col="sinceEntryPct"
              align="right"
              title="Price change since 09:45 (when our entry window opens). This is the FRESHNESS check: a big Chg% but almost 0 here means the whole move happened at the open — it's probably over. Chasing that is the classic trap. The board sorts on this by default, by SIZE of move regardless of direction, so the hardest fallers rank alongside the hardest risers."
              {...th}
            />
            <Th
              label="App Spread%"
              col="spreadPct"
              align="right"
              title="The gap between the best buy and sell price. Small = easy and cheap to trade. Big = you lose money just getting in and out."
              {...th}
            />
            <Th
              label="App Bid/Ask"
              col="imbalance"
              align="right"
              title="Who is pushing right now: more buyers waiting (green) or more sellers (red). From the live order book — it can flip fast."
              {...th}
            />
            <Th
              label="App Fut OI"
              col="futOi"
              align="right"
              title="Open positions in this stock's FUTURES only (live). Note: this is NOT NSE's combined futures+options number — that one is in the NSE columns to the right."
              {...th}
            />
            <Th
              label="App OI Lvl"
              col="oiLevel"
              align="right"
              title="Today's futures OI compared to its own 20-day average. 1.25× or more = unusually heavy positioning — big players are committed."
              {...th}
            />
            <Th
              label="App OI Build"
              col="oiUrgency"
              align="right"
              title="How fast NEW positions are being added TODAY (% change since the session's first reading). Bright green = piling on right now. Different from OI Lvl, which says how heavy positioning already is."
              {...th}
            />
            <Th
              label="App Opt%"
              col="nseOptShare"
              align="right"
              title="Of all the money traded in this stock's F&O today, the share sitting in OPTIONS premium. High = the action is in options — the exact thing we trade. Low = it's mostly futures. We compute this from the NSE values on the right; being a ratio, it stays comparable all day."
              {...th}
            />
            <Th
              label="App OIΔ30m"
              col="nseOiSlope30m"
              align="right"
              title="Our 30-minute speed check on NSE's combined OI. ▲ = positions still building right NOW. ▼ = they're unwinding. Flat = the build happened earlier and has stalled since."
              {...th}
            />
            <Th
              label="App Turn Lvl"
              col="turnoverLvl"
              align="right"
              title="Money-flow speed: today's futures turnover vs its own 20-day average, adjusted for the time of day. 2× = money flowing twice as fast as normal RIGHT NOW. Falls back toward 1× if the flow dies — unlike raw Turnover, which only grows."
              {...th}
            />
            <Th
              label="App Turnover"
              col="turnover"
              align="right"
              title="Total money traded in this stock's futures so far today (≈ average price × volume). The reality check: real moves have real money behind them."
              {...th}
            />
            {/* ── NSE block: verbatim NSE oi-spurts feed values (matches nseindia.com) ── */}
            <Th
              label="NSE %Chng in OI"
              col="nseChgOiPct"
              align="right"
              className={BLOCK_EDGE}
              title="Straight from NSE: combined futures + options open interest change vs yesterday, in %. Shown EXACTLY as NSE reports it — this is the number NSE ranks its OI Build-up list by. '—' = the stock isn't in NSE's list right now."
              {...th}
            />
            <Th
              label="NSE Chng in OI"
              col="nseChangeInOi"
              align="right"
              title="Straight from NSE: how many contracts of combined open interest were added (or removed) vs yesterday."
              {...th}
            />
            <Th
              label="NSE OI (Today)"
              col="nseLatestOi"
              align="right"
              title="Straight from NSE: today's total combined (futures + options) open interest, in contracts — full number, never shortened."
              {...th}
            />
            <Th
              label="NSE OI (Prev)"
              col="nsePrevOi"
              align="right"
              title="Straight from NSE: yesterday's combined open interest — the base the %Chng column is measured against."
              {...th}
            />
            <Th
              label="NSE Volume"
              col="nseVolume"
              align="right"
              title="Straight from NSE: contracts traded today."
              {...th}
            />
            <Th
              label="NSE Fut Value"
              col="nseFutValueCr"
              align="right"
              title="Straight from NSE: money traded in the FUTURES today. NSE reports it in ₹ Lakhs; we display ₹ Crore (÷100) — same value, friendlier unit."
              {...th}
            />
            <Th
              label="NSE Opt Value (Prem)"
              col="nsePremValueCr"
              align="right"
              title="Straight from NSE: option PREMIUM traded today — the real cash moving through options, the pool we actually trade in. NSE reports ₹ Lakhs; we display ₹ Crore (÷100)."
              {...th}
            />
            <Th
              label="NSE Opt Value (Notl)"
              col="nseOptValueCr"
              align="right"
              title="Straight from NSE: options traded at FULL contract value (notional) — a much bigger number than the premium, because it counts the whole contract, not just the price paid. Displayed in ₹ Crore."
              {...th}
            />
            <Th
              label="NSE Total Value"
              col="nseTotalValueCr"
              align="right"
              title="Straight from NSE: futures money + option premium added together — today's total. NSE reports ₹ Lakhs; we display ₹ Crore (÷100)."
              {...th}
            />
            <Th
              label="NSE Underlying"
              col="nseUnderlyingValue"
              align="right"
              title="Straight from NSE: the stock's spot price as their feed reports it."
              {...th}
            />
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr
              key={r.symbol}
              className="group border-t border-border even:bg-[color-mix(in_oklab,var(--muted)_30%,var(--card))] hover:bg-[color-mix(in_oklab,var(--muted)_60%,var(--card))]"
            >
              {/* identity (sticky left, opaque bg so scrolled columns never show through) */}
              <td
                className={`${STICKY_TD} left-0 w-10 min-w-10 px-1.5 py-0.5 text-right text-[10px] text-muted-foreground tabular-nums`}
              >
                {r.origRank}
              </td>
              <td
                className={`${STICKY_TD} left-10 min-w-[7.5rem] ${STICKY_EDGE} px-3 py-1 font-medium whitespace-nowrap text-foreground`}
              >
                <button
                  type="button"
                  onClick={() =>
                    window.open(
                      `https://in.tradingview.com/chart/?symbol=NSE%3A${encodeURIComponent(r.symbol)}&interval=5`,
                      '_blank',
                      'noopener,noreferrer'
                    )
                  }
                  className="cursor-pointer font-medium text-foreground underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                  title={`Open ${r.symbol} chart on TradingView`}
                >
                  {r.symbol}
                </button>
                {sectors?.[r.symbol] && (
                  <span className="ml-1.5 rounded bg-muted px-1 py-0.5 text-[9px] font-normal text-muted-foreground">
                    {sectors[r.symbol]}
                  </span>
                )}
              </td>
              {/* App block */}
              <td className={`${BLOCK_EDGE} px-1.5 py-0.5 text-right`}>
                <RFactorCell r={r} />
              </td>
              <td className="px-1.5 py-0.5 text-right font-semibold tabular-nums text-violet-600 dark:text-violet-400">
                {r.tfRFactor != null ? r.tfRFactor.toFixed(1) : <span className="font-normal text-muted-foreground/50">—</span>}
              </td>
              <td className="px-2 py-1">
                <div className="flex items-center gap-1">
                  <SetupBadge v={r.verdict} />
                  {r.verdict.extended && (
                    <span
                      className="inline-block rounded bg-orange-500/15 px-1 py-0.5 text-[9px] font-semibold text-orange-700 dark:text-orange-300"
                      title="Already moved a lot today — the move is behind you. Chasing it is risky; wait for a pullback."
                    >
                      moved
                    </span>
                  )}
                </div>
              </td>
              <td className="px-2 py-1">
                <BreakoutCell r={r} />
              </td>
              <td className="px-1.5 py-0.5 text-right tabular-nums">{r.ltp != null ? `₹${num(r.ltp)}` : '—'}</td>
              <td
                className={`px-1.5 py-0.5 text-right tabular-nums ${
                  r.changePctOpen == null
                    ? 'text-muted-foreground/50'
                    : r.changePctOpen >= 0
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-red-600 dark:text-red-400'
                }`}
              >
                {r.changePctOpen != null ? `${r.changePctOpen >= 0 ? '+' : ''}${num(r.changePctOpen)}%` : '—'}
              </td>
              <td className="px-1.5 py-0.5 text-right">
                <SinceEntryCell r={r} />
              </td>
              <td className={`px-1.5 py-0.5 text-right font-medium tabular-nums ${spreadCls(r.spreadPct)}`}>
                {r.spreadPct != null ? `${num(r.spreadPct, 3)}%` : '—'}
              </td>
              <td className="px-2 py-1">
                <Imbalance v={r.imbalance} />
              </td>
              <td className="px-1.5 py-0.5 text-right text-muted-foreground tabular-nums">{fmtCompact(r.futOi)}</td>
              <td
                className={`px-1.5 py-0.5 text-right tabular-nums ${
                  (r.oiLevel ?? 0) >= 1.25
                    ? 'font-semibold text-emerald-600 dark:text-emerald-400'
                    : 'text-muted-foreground'
                }`}
              >
                {r.oiLevel != null ? `${num(r.oiLevel)}×` : '—'}
              </td>
              <td className="px-1.5 py-0.5 text-right">
                <OiBuild r={r} />
              </td>
              <td className="px-1.5 py-0.5 text-right">
                <OptShareCell v={r.nseOptShare} />
              </td>
              <td className="px-1.5 py-0.5 text-right">
                <AppOiSlopeCell v={r.nseOiSlope30m} />
              </td>
              <td className="px-1.5 py-0.5 text-right">
                <TurnoverLvlCell v={r.turnoverLvl} />
              </td>
              <td className="px-1.5 py-0.5 text-right text-muted-foreground tabular-nums">{fmtCompact(r.turnover)}</td>
              {/* NSE block — verbatim oi-spurts feed values */}
              <td className={`${BLOCK_EDGE} px-1.5 py-0.5 text-right`}>
                <NseChgOiCell v={r.nseChgOiPct} />
              </td>
              <td className="px-1.5 py-0.5 text-right text-muted-foreground tabular-nums">{fmtInt(r.nseChangeInOi)}</td>
              <td className="px-1.5 py-0.5 text-right text-muted-foreground tabular-nums">{fmtInt(r.nseLatestOi)}</td>
              <td className="px-1.5 py-0.5 text-right text-muted-foreground tabular-nums">{fmtInt(r.nsePrevOi)}</td>
              <td className="px-1.5 py-0.5 text-right text-muted-foreground tabular-nums">{fmtInt(r.nseVolume)}</td>
              <td className="px-1.5 py-0.5 text-right text-muted-foreground tabular-nums">{fmtCr(r.nseFutValueCr)}</td>
              <td className="px-1.5 py-0.5 text-right text-muted-foreground tabular-nums">{fmtCr(r.nsePremValueCr)}</td>
              <td className="px-1.5 py-0.5 text-right text-muted-foreground tabular-nums">{fmtCr(r.nseOptValueCr)}</td>
              <td className="px-1.5 py-0.5 text-right text-muted-foreground tabular-nums">
                {fmtCr(r.nseTotalValueCr)}
              </td>
              <td className="px-1.5 py-0.5 text-right text-muted-foreground tabular-nums">
                {r.nseUnderlyingValue != null && r.nseUnderlyingValue > 0
                  ? `₹${r.nseUnderlyingValue.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                  : '—'}
              </td>
            </tr>
          ))}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={29} className="px-2 py-8 text-center text-muted-foreground">
                No data.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
