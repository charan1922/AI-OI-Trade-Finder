'use client';

import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { useMemo, useState } from 'react';
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
      <span className="w-9 text-right tabular-nums text-muted-foreground">{bidPct}%</span>
    </div>
  );
}

const SETUP_STYLE: Record<SetupVerdict['level'], { cls: string; label: string }> = {
  strong: { cls: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300', label: 'Strong' },
  watch: { cls: 'bg-amber-500/15 text-amber-700 dark:text-amber-300', label: 'Watch' },
  quiet: { cls: 'bg-slate-500/10 text-slate-600 dark:text-slate-400', label: 'Quiet' },
  illiquid: { cls: 'bg-muted text-muted-foreground', label: 'Illiquid' },
};

function SetupBadge({ v }: { v: SetupVerdict }) {
  const s = SETUP_STYLE[v.level];
  const arrow = v.bias === 'bullish' ? ' ↑' : v.bias === 'bearish' ? ' ↓' : '';
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${s.cls}`}
      title={v.reasons.join(' · ')}
    >
      {s.label}
      {arrow}
    </span>
  );
}

/** TF-breakout badge styling per grade (see lib/breakout). */
const BREAKOUT_STYLE: Record<BreakoutGrade, { cls: string; label: string }> = {
  strong: { cls: 'bg-emerald-500/20 font-bold text-emerald-700 dark:text-emerald-300', label: 'Strong BO' },
  confirmed: { cls: 'bg-emerald-500/10 font-semibold text-emerald-700 dark:text-emerald-300', label: 'Breakout' },
  watch: { cls: 'bg-sky-500/10 text-sky-700 dark:text-sky-300', label: 'Base held' },
  'fakeout-risk': { cls: 'bg-orange-500/15 font-semibold text-orange-700 dark:text-orange-300', label: 'Fakeout?' },
  none: { cls: '', label: '' },
};

/** Sortable rank for the TF-breakout verdict (grade first, then levels cleared). */
export function breakoutRank(r: LiveUrgencyRow): number {
  const b = r.breakout;
  if (b == null || b.grade === 'none') return 0;
  const base: Record<BreakoutGrade, number> = { strong: 4, confirmed: 3, watch: 2, 'fakeout-risk': 1, none: 0 };
  return base[b.grade] + Math.min(b.levelsCleared, 9) / 10;
}

/**
 * TradeFinder breakout cell — the 3-check verdict (morning test · R-Factor
 * efficiency · levels cleared) with the level count and direction arrow.
 * "—" until today's candles are recorded (never fabricated).
 */
function BreakoutCell({ r }: { r: LiveUrgencyRow }) {
  const b = r.breakout;
  if (b == null) return <span className="text-muted-foreground/50">—</span>;
  if (b.grade === 'none') {
    return (
      <span className="text-muted-foreground/50" title={b.detail}>
        {b.morningTest === 'pending' ? '…' : '—'}
      </span>
    );
  }
  const s = BREAKOUT_STYLE[b.grade];
  const arrow = b.direction === 'bullish' ? ' ↑' : b.direction === 'bearish' ? ' ↓' : '';
  const tip = [
    `TF breakout — ${b.grade}${b.direction ? ` (${b.direction})` : ''}`,
    `Morning test: ${b.morningTest}`,
    `Levels cleared: ${b.levelsCleared}${b.clearedNames.length ? ` (${b.clearedNames.join(', ')})` : ''}`,
    b.nextLevel ? `Next level: ${b.nextLevel.name} @ ${b.nextLevel.price.toFixed(2)}` : '',
    '',
    b.detail,
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <span className={`inline-block cursor-help rounded px-1.5 py-0.5 text-[10px] ${s.cls}`} title={tip}>
      {s.label}
      {b.levelsCleared > 0 ? ` ${b.levelsCleared}L` : ''}
      {arrow}
    </span>
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

/** NSE combined (fut+opt) OI % — the oi-spurts feed value, with the 30-min build rate. */
function NseOiCell({ r }: { r: LiveUrgencyRow }) {
  const v = r.nseOiPct;
  if (v == null) return <span className="text-muted-foreground/50">—</span>;
  const cls =
    v >= 10
      ? 'font-semibold text-emerald-600 dark:text-emerald-400'
      : v >= 3
        ? 'text-emerald-600 dark:text-emerald-400'
        : v <= -3
          ? 'text-red-600 dark:text-red-400'
          : 'text-muted-foreground';
  const slope = r.nseOiSlope30m;
  const tip = [
    `NSE combined OI (futures + options) ${v >= 0 ? '+' : ''}${v.toFixed(1)}% vs yesterday's close — NSE's own oi-spurts number, the one the F&O OI Build-up list is ranked by.`,
    slope != null
      ? `Last ~30 min: ${slope >= 0 ? '+' : ''}${slope.toFixed(2)} pts — ${slope >= 0.5 ? 'still building NOW' : slope <= -0.5 ? 'unwinding' : 'flat (built earlier, stalled)'}`
      : 'Build rate: not enough recorded points yet',
  ].join('\n');
  return (
    <span className={`tabular-nums ${cls}`} title={tip}>
      {v >= 0 ? '+' : ''}
      {v.toFixed(1)}%{slope != null && slope >= 0.5 ? ' ▲' : ''}
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
 * R-Factor cell — the live institutional-interest score (1.0–8.0) plus its
 * directional bias arrow, colored by strength. The hover tooltip breaks down every
 * contributing factor. Values are provisional until the blend weights are
 * calibrated to TradeFinder. "—" when there's no usable price (never fabricated).
 */
function RFactorCell({ r }: { r: LiveUrgencyRow }) {
  if (r.rFactor == null) return <span className="text-muted-foreground/50">—</span>;
  const bias = r.rFactorBias ?? 'neutral';
  const b = BIAS_STYLE[bias];
  // Thresholds on the 1–8 scale (rescaled from the old 1–5: 4/5 → 6.25, 3/5 → 4.5)
  const strengthCls =
    r.rFactor >= 6.25
      ? 'font-bold text-emerald-600 dark:text-emerald-400'
      : r.rFactor >= 4.5
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
    `R-Factor ${r.rFactor.toFixed(2)} / 8 · bias ${bias} · agreement ${conf}`,
    'Measures big-money PARTICIPATION today (where money is) — not entry timing. It ratchets up through a heavy day and stays high after the move is done; use Setup + Breakout + Since 9:45 for the "enter now?" question.',
    r.rFactorAfterEntry === false ? '⚠ before the 09:45 IST entry window — may be opening noise' : '',
    '',
    active,
    naLabels.length ? `\nNot available: ${naLabels.join(', ')}` : '',
    '\nProvisional — blend weights not yet calibrated to TradeFinder.',
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
  | 'rank'
  | 'setup'
  | 'symbol'
  | 'rFactor'
  | 'breakout'
  | 'ltp'
  | 'changePctOpen'
  | 'sinceEntryPct'
  | 'spreadPct'
  | 'imbalance'
  | 'futOi'
  | 'oiLevel'
  | 'nseOiPct'
  | 'oiUrgency'
  | 'nseOptShare'
  | 'nsePremValueCr'
  | 'nseFutValueCr'
  | 'nseOptValueCr'
  | 'nseTotalValueCr'
  | 'nseLatestOi'
  | 'nsePrevOi'
  | 'turnoverLvl'
  | 'turnover';
/** `origRank` = the row's 1-based position in the incoming watchlist (= NSE Movers order). */
type Row = LiveUrgencyRow & { verdict: SetupVerdict; origRank: number };

/** Sortable header cell — top-level so React doesn't remount it every render. */
function Th({
  label,
  col,
  align = 'right',
  title,
  sortKey,
  sortDir,
  onSort,
}: {
  label: string;
  col: SortKey;
  align?: 'left' | 'right' | 'center';
  title?: string;
  sortKey: SortKey;
  sortDir: 'asc' | 'desc';
  onSort: (key: SortKey) => void;
}) {
  const active = sortKey === col;
  const justify = align === 'left' ? 'justify-start' : align === 'center' ? 'justify-center' : 'justify-end';
  const textAlign = align === 'left' ? 'text-left' : align === 'center' ? 'text-center' : 'text-right';
  return (
    <th className={`px-1.5 py-1 font-semibold ${textAlign}`} title={title}>
      <button
        type="button"
        onClick={() => onSort(col)}
        className={`flex w-full items-center gap-1 ${justify} hover:text-foreground ${active ? 'text-foreground' : ''}`}
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
  return (r[key] as number | null) ?? Number.NEGATIVE_INFINITY;
};

export function UrgencyTable({ rows, sectors }: { rows: LiveUrgencyRow[]; sectors?: Record<string, string> }) {
  // Default to the watchlist order (= the NSE Movers / sector-leaders order the
  // list was built in), so /live mirrors /nse/movers. Headers stay sortable.
  const [sortKey, setSortKey] = useState<SortKey>('rank');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const onSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir(key === 'rank' || key === 'symbol' || key === 'spreadPct' ? 'asc' : 'desc');
    }
  };

  const sorted = useMemo<Row[]>(() => {
    const withVerdict: Row[] = rows.map((r, i) => ({ ...r, verdict: setupScore(r), origRank: i + 1 }));
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
    <div className="overflow-x-auto rounded-xl border border-border bg-card">
      <table className="w-full text-[10px]">
        <thead className="bg-muted/50 text-muted-foreground">
          <tr>
            <Th label="#" col="rank" align="right" title="Watchlist order — same as NSE Movers. Default sort; click any header to re-rank." {...th} />
            <Th label="Symbol" col="symbol" align="left" {...th} />
            <Th
              label="R-Factor"
              col="rFactor"
              align="right"
              title="Big-money PARTICIPATION today, 1.0–8.0 (higher = more institutional activity) + bias arrow. It answers WHERE money is — NOT 'enter now': it ratchets up through a heavy day and stays high after the move is done. For timing use Setup + Breakout + Since 9:45. Hover a value for the factor breakdown."
              {...th}
            />
            <Th label="Setup" col="setup" align="left" title="Combined verdict — see 'How to read'. Click to rank strongest first." {...th} />
            <Th
              label="Breakout"
              col="breakout"
              align="left"
              title="TradeFinder 3-check breakout: (1) morning test — first-15-min low held all day = smart money absorbing dips; (2) R-Factor efficiency; (3) levels cleared at once (OR high, prev-day high, 5d/20d base, swing highs). 'Fakeout?' = clearing levels but the morning test broke earlier — the failed-breakout profile. Hover a badge for the breakdown."
              {...th}
            />
            <Th label="LTP" col="ltp" align="right" title="Last price" {...th} />
            <Th label="Chg%" col="changePctOpen" align="right" title="Change since the day's open" {...th} />
            <Th
              label="Since 9:45"
              col="sinceEntryPct"
              align="right"
              title="Price change since 09:45 IST (when the entry window opens) — the freshness read. Big Chg% + ~0 here = the move came at the open (gap-and-flat) and is likely spent; chasing it is the classic trap."
              {...th}
            />
            <Th label="Spread%" col="spreadPct" align="right" title="(ask − bid) ÷ mid. Tight = liquid / cheap to execute." {...th} />
            <Th label="Bid/Ask" col="imbalance" align="right" title="Resting bid ÷ (bid+ask) — order-flow pressure." {...th} />
            <Th label="Fut OI" col="futOi" align="right" title="Live futures open interest" {...th} />
            <Th label="OI Lvl" col="oiLevel" align="right" title="Live futures OI ÷ 20-session average (conviction)" {...th} />
            <Th
              label="OI Build"
              col="oiUrgency"
              align="right"
              title="Intraday OI build this session (% since first snapshot), colored by urgency = rate of fresh OI piling on now. Distinct from the static OI level."
              {...th}
            />
            <Th
              label="NSE OI%"
              col="nseOiPct"
              align="right"
              title="NSE's combined OI change (futures + options) vs yesterday — the oi-spurts feed number the F&O OI Build-up list is ranked by. ▲ = still building in the last ~30 min (hover for the rate). '—' = not in NSE's feed."
              {...th}
            />
            <Th
              label="NSE Opt%"
              col="nseOptShare"
              align="right"
              title="Options premium ÷ (futures + options) traded value — is the OI build options-led (high) or futures-led (low)? Since we trade options, an options-led build is the one that concerns us. It's a ratio, so it doesn't just grow through the day. From NSE's oi-spurts feed."
              {...th}
            />
            <Th
              label="NSE Opt Prem"
              col="nsePremValueCr"
              align="right"
              title="Options PREMIUM traded value in this underlying today (₹ Cr) — the actual money moving through its options, i.e. the pool we'd trade in. Cumulative since yesterday's close."
              {...th}
            />
            <Th
              label="NSE Fut Val"
              col="nseFutValueCr"
              align="right"
              title="Futures traded value today (₹ Cr) — from NSE's oi-spurts feed. Cumulative since yesterday's close."
              {...th}
            />
            <Th
              label="NSE Opt Val"
              col="nseOptValueCr"
              align="right"
              title="Options notional traded value today (₹ Cr) — the full contract value (not premium). Cumulative since yesterday's close."
              {...th}
            />
            <Th
              label="NSE Tot Val"
              col="nseTotalValueCr"
              align="right"
              title="Futures + options-premium total traded value today (₹ Cr) — NSE's own 'total' column. Cumulative since yesterday's close."
              {...th}
            />
            <Th
              label="NSE Comb OI"
              col="nseLatestOi"
              align="right"
              title="Combined futures + options open interest today, in contracts (NSE oi-spurts 'latestOI'). The absolute scale behind the NSE OI% change."
              {...th}
            />
            <Th
              label="NSE Prev OI"
              col="nsePrevOi"
              align="right"
              title="Yesterday's combined futures + options open interest, in contracts (NSE oi-spurts 'prevOI') — the baseline the NSE OI% change is measured from."
              {...th}
            />
            <Th
              label="Turn Lvl"
              col="turnoverLvl"
              align="right"
              title="Futures turnover ÷ 20-day average, adjusted for time of day — is real money flowing at an unusual pace RIGHT NOW. Decays if the flow dies; the raw Turnover next door only ever grows."
              {...th}
            />
            <Th label="Turnover" col="turnover" align="right" title="Live futures turnover ≈ VWAP × volume (quality)" {...th} />
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr
              key={r.symbol}
              onClick={() =>
                window.open(
                  `https://in.tradingview.com/chart/?symbol=NSE%3A${encodeURIComponent(r.symbol)}&interval=5`,
                  '_blank',
                  'noopener,noreferrer',
                )
              }
              title={`Open ${r.symbol} chart on TradingView`}
              className="cursor-pointer border-t border-border hover:bg-muted/30"
            >
              <td className="px-1.5 py-0.5 text-right tabular-nums text-[10px] text-muted-foreground">{r.origRank}</td>
              <td className="px-3 py-1 font-medium text-foreground">
                {r.symbol}
                {sectors?.[r.symbol] && (
                  <span className="ml-1.5 rounded bg-muted px-1 py-0.5 text-[9px] font-normal text-muted-foreground">
                    {sectors[r.symbol]}
                  </span>
                )}
              </td>
              <td className="px-1.5 py-0.5 text-right">
                <RFactorCell r={r} />
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
              <td className="px-1.5 py-0.5 text-right tabular-nums text-muted-foreground">{fmtCompact(r.futOi)}</td>
              <td
                className={`px-1.5 py-0.5 text-right tabular-nums ${
                  (r.oiLevel ?? 0) >= 1.25 ? 'font-semibold text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'
                }`}
              >
                {r.oiLevel != null ? `${num(r.oiLevel)}×` : '—'}
              </td>
              <td className="px-1.5 py-0.5 text-right">
                <OiBuild r={r} />
              </td>
              <td className="px-1.5 py-0.5 text-right">
                <NseOiCell r={r} />
              </td>
              <td className="px-1.5 py-0.5 text-right">
                <OptShareCell v={r.nseOptShare} />
              </td>
              <td className="px-1.5 py-0.5 text-right tabular-nums text-muted-foreground">{fmtCr(r.nsePremValueCr)}</td>
              <td className="px-1.5 py-0.5 text-right tabular-nums text-muted-foreground">{fmtCr(r.nseFutValueCr)}</td>
              <td className="px-1.5 py-0.5 text-right tabular-nums text-muted-foreground">{fmtCr(r.nseOptValueCr)}</td>
              <td className="px-1.5 py-0.5 text-right tabular-nums text-muted-foreground">{fmtCr(r.nseTotalValueCr)}</td>
              <td className="px-1.5 py-0.5 text-right tabular-nums text-muted-foreground">{fmtCompact(r.nseLatestOi ?? null)}</td>
              <td className="px-1.5 py-0.5 text-right tabular-nums text-muted-foreground">{fmtCompact(r.nsePrevOi ?? null)}</td>
              <td className="px-1.5 py-0.5 text-right">
                <TurnoverLvlCell v={r.turnoverLvl} />
              </td>
              <td className="px-3 py-1 text-right tabular-nums text-muted-foreground">{fmtCompact(r.turnover)}</td>
            </tr>
          ))}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={23} className="px-2 py-8 text-center text-muted-foreground">
                No data.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
