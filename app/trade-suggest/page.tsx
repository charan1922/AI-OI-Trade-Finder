'use client';

import { ExternalLink, Loader2, RefreshCw, Target } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

/** Mirrors lib/trade-suggest API shapes (leaderboard + suggestions). */
interface BoardRow {
  rank: number;
  symbol: string;
  sector: string;
  rFactor: number;
  spreadRatio: number;
  turnoverRatio: number | null;
  pctChange: number | null;
  close: number;
}
interface Board {
  success: boolean;
  date: string;
  universe: number;
  rows: BoardRow[];
  suggestionRanks: { symbol: string; optionType: string; rank: number | null }[];
  error?: string;
}
interface Stored {
  symbol: string;
  optionType: string;
  strike: number;
  expiryDate: string;
  spotAtSuggest: number;
  slSpot: number | null;
  targetSpot: number | null;
  lotSize: number;
  sector: string;
  rFactor: number;
  score: number;
  rank: number;
  premiumAtSuggest: number | null;
  timesSeen: number;
  suggestedAt: string;
  maxUpPct: number | null;
  maxDownPct: number | null;
  closePct: number | null;
  outcomeAt: string | null;
}
interface PickFactors {
  vwap: number | null;
  vwapAligned: boolean | null;
  supertrend: 'up' | 'down' | null;
  supertrendLine: number | null;
  supertrendAligned: boolean | null;
  atr: number | null;
  atrPct: number | null;
  eqTurnoverRatio: number | null;
  combinedOiLevel: number | null;
  nseOiPct: number | null;
  onOiSpurtList: boolean;
}
interface LivePick {
  rank: number;
  symbol: string;
  sector: string;
  direction: 'bullish' | 'bearish';
  score: number;
  option: {
    optionType: string;
    strike: number;
    expiryDate: string;
    lotSize: number;
    premium: {
      ltp: number;
      spreadPct: number | null;
      perLotCost: number;
      slPremium: number;
      targetPremium: number;
      liquidityWarning: string | null;
    } | null;
  } | null;
  plan: { entrySpot: number; slSpot: number | null; targetSpot: number | null; slBasis: string };
  rFactor: number;
  rFactorConfidence: number;
  oiLevel: number;
  oiUrgency: number | null;
  changePctOpen: number | null;
  spreadPct: number | null;
  imbalance: number | null;
  orBreakout: boolean;
  extended: boolean;
  /** Coil-and-pop structure; null when no intact consolidation breakout exists. */
  consolidation: {
    grade: 'unconfirmed' | 'confirmed' | 'strong';
    pivot: number;
    baseHigh: number;
    baseLow: number;
    baseRangePct: number;
    barsSinceBreakout: number;
    volumeMult: number | null;
    extensionPct: number;
    extended: boolean;
    detail: string;
  } | null;
  sinceEntryPct: number | null;
  moveFreshness: {
    profile: 'fresh' | 'quiet' | 'spent' | 'fading' | 'unknown';
    sinceEntryDirectional: number | null;
    freshShare: number | null;
    detail: string;
  } | null;
  /** TradeFinder's independent rank; null = they have no data on this name. */
  tfCorroboration: {
    rFactor: number;
    rank: number;
    total: number;
    topBoard: boolean;
    ageMinutes: number | null;
    detail: string;
  } | null;
  factors: PickFactors | null;
  reasons: string[];
}
interface SuggestResp {
  success: boolean;
  window: { active: boolean; opensAt: string; closesAt: string; nowIST: string };
  marketOpen: boolean;
  date: string;
  suggestions?: LivePick[];
  tilt?: { up: number; down: number; flat: number; basis: string; lean: 'CE' | 'PE' | 'neutral' };
  sectorFlow?: { sector: string; names: number; avgChgPct: number | null; oiSpurts: number }[];
  earlierToday: Stored[];
  error?: string;
}

const pctCls = (v: number | null) =>
  v == null ? '' : v >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400';
const fmtPct = (v: number | null) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);

/** TradingView 5-min chart for an NSE symbol — same deep-link shape as /live and /nse/movers. */
const tvUrl = (symbol: string) =>
  `https://in.tradingview.com/chart/?symbol=NSE%3A${encodeURIComponent(symbol)}&interval=5`;

/** Symbol rendered as a TradingView deep-link — the enterprise "click to chart" affordance. */
function SymbolLink({ symbol, className = '' }: { symbol: string; className?: string }) {
  return (
    <a
      href={tvUrl(symbol)}
      target="_blank"
      rel="noopener noreferrer"
      title={`Open ${symbol} chart on TradingView`}
      className={`group inline-flex items-center gap-0.5 hover:text-primary hover:underline ${className}`}
    >
      {symbol}
      <ExternalLink className="h-2.5 w-2.5 opacity-0 transition-opacity group-hover:opacity-70" />
    </a>
  );
}

/** One factor reading: label + value, colored by verdict, tooltip explains it. */
function FactorChip({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: string;
  tone: 'good' | 'warn' | 'info';
  title: string;
}) {
  const toneCls =
    tone === 'good'
      ? 'border-emerald-400/50 bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'
      : tone === 'warn'
        ? 'border-amber-400/50 bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300'
        : 'border-border bg-muted/40 text-muted-foreground';
  return (
    <span title={title} className={`inline-flex cursor-help items-baseline gap-1 rounded border px-1.5 py-0.5 ${toneCls}`}>
      <span className="text-[9px] uppercase tracking-wide opacity-75">{label}</span>
      <span className="text-[10.5px] font-semibold tabular-nums">{value}</span>
    </span>
  );
}

/** One live pick as a readable desk ticket: plan block + factor grid + evidence. */
function PickCard({ p }: { p: LivePick }) {
  const bull = p.direction === 'bullish';
  const f = p.factors;
  const prem = p.option?.premium ?? null;
  const riskRupees = prem != null ? Math.round(prem.perLotCost * 0.4) : null;
  const fmt = (v: number | null | undefined, d = 2) => (v == null ? '—' : v.toFixed(d));
  const chips: { label: string; value: string; tone: 'good' | 'warn' | 'info'; title: string }[] = [
    // Freshness first — it answers "is the move ahead of me or behind me?",
    // which decides whether the rest of the evidence is worth reading.
    ...(p.moveFreshness && p.moveFreshness.profile !== 'unknown'
      ? [
          {
            label: 'Since 9:45',
            value:
              p.moveFreshness.sinceEntryDirectional == null
                ? p.moveFreshness.profile
                : `${p.moveFreshness.sinceEntryDirectional >= 0 ? '+' : ''}${p.moveFreshness.sinceEntryDirectional.toFixed(2)}% ${p.moveFreshness.profile}`,
            tone: (p.moveFreshness.profile === 'fresh'
              ? 'good'
              : p.moveFreshness.profile === 'quiet'
                ? 'info'
                : 'warn') as 'good' | 'warn' | 'info',
            title: `Move since the 09:45 entry window opened, signed toward the trade. ${p.moveFreshness.detail}`,
          },
        ]
      : []),
    ...(p.consolidation
      ? [
          {
            label: 'Coil',
            value: `${p.consolidation.grade} @ ${p.consolidation.pivot}`,
            tone: (p.consolidation.extended
              ? 'warn'
              : p.consolidation.grade === 'strong'
                ? 'good'
                : p.consolidation.grade === 'confirmed'
                  ? 'good'
                  : 'info') as 'good' | 'warn' | 'info',
            title: `Consolidation breakout — ${p.consolidation.detail}. The pivot ${p.consolidation.pivot} is the structural invalidation level (the one the market drew, not a % guess).`,
          },
        ]
      : []),
    ...(p.tfCorroboration
      ? [
          {
            label: 'TF rank',
            value: `#${p.tfCorroboration.rank}/${p.tfCorroboration.total}`,
            tone: (p.tfCorroboration.topBoard ? 'good' : 'warn') as 'good' | 'warn',
            title: p.tfCorroboration.detail,
          },
        ]
      : []),
    {
      label: 'R-Factor',
      value: `${p.rFactor.toFixed(2)}`,
      tone: p.rFactor >= 3.6 ? 'good' : 'warn',
      title: `Institutional-interest strength, 1–8 scale (gate ≥ 3.6) · bias ${p.direction} · factor agreement ${(p.rFactorConfidence * 100).toFixed(0)}%`,
    },
    {
      label: 'Fut OI',
      value: `${fmt(p.oiLevel)}×`,
      tone: p.oiLevel >= 1.1 ? 'good' : 'info',
      title: 'Live futures open interest ÷ its 20-day average. ≥1.1× = sustained positioning (the TF fingerprint).',
    },
    ...(f?.nseOiPct != null
      ? [
          {
            label: 'NSE OI Δ',
            value: `${f.nseOiPct >= 0 ? '+' : ''}${f.nseOiPct.toFixed(1)}%`,
            tone: (f.nseOiPct >= 5 ? 'good' : 'info') as 'good' | 'info',
            title: "NSE's combined futures+options OI change today — catches options-led builds futures-only OI misses.",
          },
        ]
      : []),
    ...(f?.combinedOiLevel != null
      ? [
          {
            label: 'Comb OI',
            value: `${f.combinedOiLevel.toFixed(2)}×`,
            tone: (f.combinedOiLevel >= 1.1 ? 'good' : 'info') as 'good' | 'info',
            title: "Combined fut+opt OI vs its 20-day average — derived: yesterday's bhavcopy total × NSE's live % change.",
          },
        ]
      : []),
    ...(f?.eqTurnoverRatio != null
      ? [
          {
            label: 'EQ Turn',
            value: `${f.eqTurnoverRatio.toFixed(1)}×`,
            tone: (f.eqTurnoverRatio >= 3 ? 'good' : 'info') as 'good' | 'info',
            title: 'Equity turnover vs time-adjusted 20-day pace. Mornings naturally over-read ~2× (volume is U-shaped) — ≥3–4× is genuinely elevated.',
          },
        ]
      : []),
    {
      label: 'OR',
      value: p.orBreakout ? 'breakout' : 'inside',
      tone: p.orBreakout ? 'good' : 'info',
      title: 'Opening range (09:15–09:45) — trading beyond it in the trade direction confirms the move; inside = not yet confirmed.',
    },
    ...(f?.supertrend != null
      ? [
          {
            label: 'Supertrend',
            value: `${f.supertrend === 'up' ? '↑' : '↓'} ${fmt(f.supertrendLine)}`,
            tone: (f.supertrendAligned ? 'good' : 'warn') as 'good' | 'warn',
            title: `Supertrend(10,3) on the 5-min bars. ${f.supertrendAligned ? 'Agrees with the trade direction.' : 'DISAGREES with the trade direction — misaligned picks went 0/3 on the replay benchmark.'}`,
          },
        ]
      : []),
    ...(f?.vwap != null
      ? [
          {
            label: 'VWAP',
            value: `${fmt(f.vwap)}`,
            tone: (f.vwapAligned ? 'good' : 'warn') as 'good' | 'warn',
            title: `Session VWAP. Price is ${f.vwapAligned ? 'on the favorable side' : 'on the WRONG side'} for a ${bull ? 'long' : 'short'} (context only — did not discriminate on the benchmark day).`,
          },
        ]
      : []),
    ...(f?.atrPct != null
      ? [
          {
            label: 'ATR',
            value: `${f.atrPct.toFixed(2)}%`,
            tone: 'info' as const,
            title: `ATR(14) of the 5-min series = ${fmt(f.atr)} — the noise unit; your SL should sit outside it.`,
          },
        ]
      : []),
    {
      label: 'Spread',
      value: `${fmt(p.spreadPct, 3)}%`,
      tone: (p.spreadPct ?? 1) <= 0.15 ? 'good' : 'info',
      title: 'Equity bid-ask spread as % of mid — the execution cost (gate ≤ 0.3%).',
    },
    ...(p.imbalance != null
      ? [
          {
            label: 'Book',
            value: `${(p.imbalance * 100).toFixed(0)}% bid`,
            tone: ((bull ? p.imbalance >= 0.55 : p.imbalance <= 0.45) ? 'good' : 'info') as 'good' | 'info',
            title: 'Resting order-book: bid share of total quantity. >55% = demand-heavy, <45% = supply-heavy.',
          },
        ]
      : []),
    ...(f?.onOiSpurtList
      ? [
          {
            label: 'OI list',
            value: 'yes',
            tone: 'good' as const,
            title: "On NSE's OI build-up (spurts) list this scan — big-player positioning marker.",
          },
        ]
      : []),
  ];

  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-bold text-muted-foreground">#{p.rank}</span>
        <SymbolLink symbol={p.symbol} className="font-mono text-[13px] font-bold" />
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${bull ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300' : 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300'}`}
        >
          BUY {p.option ? `${p.option.strike} ${p.option.optionType}` : bull ? 'CE' : 'PE'}
        </span>
        {p.option && (
          <span className="text-[10px] text-muted-foreground">
            exp {p.option.expiryDate} · lot {p.option.lotSize}
          </span>
        )}
        <span className="ml-auto text-[10px] text-muted-foreground">
          {p.sector} · score {p.score.toFixed(3)}
          {p.changePctOpen != null && ` · ${p.changePctOpen >= 0 ? '+' : ''}${p.changePctOpen.toFixed(1)}% since open`}
        </span>
      </div>

      {prem?.liquidityWarning && (
        <div className="mt-2 rounded border border-amber-400/60 bg-amber-50 px-2 py-1 text-[10.5px] font-medium text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
          ⚠ {prem.liquidityWarning}
        </div>
      )}

      {/* The trade plan — the numbers you act on, big and unambiguous. */}
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 rounded-md bg-muted/40 p-2 text-[11px] sm:grid-cols-4">
        <div>
          <div className="text-[9px] uppercase tracking-wide text-muted-foreground">Spot entry</div>
          <div className="font-semibold tabular-nums">{p.plan.entrySpot}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-wide text-muted-foreground">Spot SL ({p.plan.slBasis})</div>
          <div className="font-semibold tabular-nums text-red-600 dark:text-red-400">{p.plan.slSpot ?? '—'}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-wide text-muted-foreground">Spot target (1:2)</div>
          <div className="font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">{p.plan.targetSpot ?? '—'}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-wide text-muted-foreground">Premium / lot cost</div>
          <div className="font-semibold tabular-nums">
            {prem ? `₹${prem.ltp} / ₹${Math.round(prem.perLotCost).toLocaleString('en-IN')}` : 'check broker'}
          </div>
        </div>
        {prem && (
          <div className="col-span-2 sm:col-span-4 text-[10px] text-muted-foreground">
            Premium backstop ₹{prem.slPremium} (−40%, ≈₹{riskRupees?.toLocaleString('en-IN')} max loss/lot) · premium target ₹
            {prem.targetPremium} (≈₹5k/lot)
            {prem.spreadPct != null && ` · option spread ${prem.spreadPct}%`}
          </div>
        )}
      </div>

      {/* Factor grid — every input, its reading, and (on hover) what it means. */}
      <div className="mt-2 flex flex-wrap gap-1">
        {chips.map((c) => (
          <FactorChip key={c.label} {...c} />
        ))}
      </div>

      <ul className="mt-2 space-y-0.5 text-[10.5px] leading-relaxed text-muted-foreground">
        {p.reasons.map((r) => (
          <li key={r}>· {r}</li>
        ))}
      </ul>
    </div>
  );
}

export default function TradeSuggestPage() {
  const [board, setBoard] = useState<Board | null>(null);
  const [sug, setSug] = useState<SuggestResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [b, s] = await Promise.all([
        fetch('/api/trade-suggest?view=leaderboard&limit=20').then((r) => r.json() as Promise<Board>),
        fetch('/api/trade-suggest').then((r) => r.json() as Promise<SuggestResp>),
      ]);
      setBoard(b.success ? b : null);
      setSug(s.success ? s : null);
      setError(b.success || s.success ? null : (b.error ?? s.error ?? 'Failed to load'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let stopped = false;
    const t = setTimeout(() => {
      if (!stopped) void refresh();
    }, 0);
    return () => {
      stopped = true;
      clearTimeout(t);
    };
  }, [refresh]);

  const suggested = new Set((sug?.earlierToday ?? []).map((s) => s.symbol));

  return (
    <div className="mx-auto max-w-5xl space-y-3 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="flex items-center gap-2 text-sm font-semibold">
          <Target className="h-4 w-4 text-primary" />
          Trade Suggest — picks &amp; EOD leaderboard
        </h1>
        <div className="flex items-center gap-2">
          {sug && (
            <span className="text-[11px] text-muted-foreground">
              window {sug.window.opensAt}–{sug.window.closesAt} ·{' '}
              {sug.window.active ? 'ACTIVE' : sug.marketOpen ? 'outside window' : 'market closed'} · use{' '}
              <code className="rounded bg-muted px-1">/trade-suggest</code> in Claude for live scans
            </span>
          )}
          <button
            type="button"
            onClick={() => void refresh()}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Refresh"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {error && <div className="rounded border border-red-300 px-3 py-2 text-[11px] text-red-600">{error}</div>}
      {loading && !board && !sug && (
        <div className="flex items-center gap-2 px-3 py-6 text-[11px] text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-primary" /> Loading…
        </div>
      )}

      {sug?.tilt && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-[10.5px]">
          <span className="font-semibold uppercase tracking-wide text-muted-foreground">Market tilt</span>
          <span className="text-emerald-600 dark:text-emerald-400">▲ {sug.tilt.up}</span>
          <span className="text-red-600 dark:text-red-400">▼ {sug.tilt.down}</span>
          <span className="text-muted-foreground">— {sug.tilt.flat}</span>
          <span
            title="Breadth among scanned candidates, % since open. Context only — never a gate (a tilt gate would have blocked the benchmark day's one winner)."
            className={`cursor-help rounded px-1.5 py-0.5 font-bold ${
              sug.tilt.lean === 'CE'
                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
                : sug.tilt.lean === 'PE'
                  ? 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300'
                  : 'bg-muted text-muted-foreground'
            }`}
          >
            lean {sug.tilt.lean}
          </span>
          {(sug.sectorFlow ?? []).slice(0, 3).map((s) => (
            <span key={s.sector} className="text-muted-foreground" title={`${s.names} scanned names · ${s.oiSpurts} on NSE's OI build-up list`}>
              {s.sector} <b className={(s.avgChgPct ?? 0) >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>{fmtPct(s.avgChgPct)}</b>
              {s.oiSpurts > 0 && <span className="text-amber-600 dark:text-amber-400"> ·{s.oiSpurts} OI</span>}
            </span>
          ))}
        </div>
      )}

      {sug && (sug.suggestions?.length ?? 0) > 0 && (
        <div className="space-y-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wide">
            Live scan picks · {sug.window.nowIST} IST
            <span className="ml-2 font-normal normal-case text-muted-foreground">
              signal analysis, not financial advice — check premium &amp; liquidity on the broker; no order is placed
            </span>
          </h2>
          {sug.suggestions?.map((p) => (
            <PickCard key={`${p.symbol}-${p.option?.optionType ?? p.direction}`} p={p} />
          ))}
        </div>
      )}

      {sug && (
        <div className="rounded-lg border border-border bg-card p-2.5">
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide">
            Today&apos;s suggestions ({sug.date})
            <span className="ml-2 font-normal normal-case text-muted-foreground">
              persisted first-sightings; outcomes fill after the 15:30 review
            </span>
          </h2>
          {sug.earlierToday.length === 0 ? (
            <div className="px-1 py-2 text-[11px] text-muted-foreground">No suggestions persisted today.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[10px]">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="px-1.5 py-1 font-medium">#</th>
                    <th className="px-1.5 py-1 font-medium">Contract</th>
                    <th className="px-1.5 py-1 text-right font-medium">Spot@call</th>
                    <th className="px-1.5 py-1 text-right font-medium">SL / Target</th>
                    <th className="px-1.5 py-1 text-right font-medium">Premium</th>
                    <th className="px-1.5 py-1 text-right font-medium">R</th>
                    <th className="px-1.5 py-1 text-right font-medium">Max fav / adv</th>
                    <th className="px-1.5 py-1 text-right font-medium">Close vs call</th>
                  </tr>
                </thead>
                <tbody>
                  {sug.earlierToday.map((s) => {
                    const fav = s.outcomeAt == null ? null : s.optionType === 'PE' ? -(s.maxDownPct ?? 0) : (s.maxUpPct ?? 0);
                    const adv = s.outcomeAt == null ? null : s.optionType === 'PE' ? (s.maxUpPct ?? 0) : -(s.maxDownPct ?? 0);
                    const cls = s.outcomeAt == null ? null : (s.closePct ?? 0) * (s.optionType === 'PE' ? -1 : 1);
                    return (
                      <tr key={`${s.symbol}-${s.optionType}`} className="border-b border-border/30">
                        <td className="px-1.5 py-0.5 tabular-nums">{s.rank}</td>
                        <td className="px-1.5 py-0.5 font-mono font-medium">
                          <SymbolLink symbol={s.symbol} /> {s.strike} {s.optionType}
                          <span className="ml-1 text-muted-foreground">lot {s.lotSize} · ×{s.timesSeen}</span>
                        </td>
                        <td className="px-1.5 py-0.5 text-right tabular-nums">{s.spotAtSuggest}</td>
                        <td className="px-1.5 py-0.5 text-right tabular-nums">
                          {s.slSpot ?? '—'} / {s.targetSpot ?? '—'}
                        </td>
                        <td className="px-1.5 py-0.5 text-right tabular-nums">
                          {s.premiumAtSuggest != null ? `₹${s.premiumAtSuggest}` : '—'}
                        </td>
                        <td className="px-1.5 py-0.5 text-right tabular-nums">{s.rFactor.toFixed(2)}</td>
                        <td className="px-1.5 py-0.5 text-right tabular-nums">
                          <span className={pctCls(fav)}>{fmtPct(fav)}</span> /{' '}
                          <span className={pctCls(adv == null ? null : -adv)}>{fmtPct(adv)}</span>
                        </td>
                        <td className={`px-1.5 py-0.5 text-right tabular-nums ${pctCls(cls)}`}>{fmtPct(cls)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {board && (
        <div className="rounded-lg border border-border bg-card p-2.5">
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide">
            EOD TF-style leaderboard · {board.date}
            <span className="ml-2 font-normal normal-case text-muted-foreground">
              spread-linear model (R = 1.56 × spread ratio, parent-repo validated) · {board.universe} F&amp;O names ·
              turnover shown as context only
            </span>
          </h2>
          <div className="max-h-96 overflow-auto">
            <table className="w-full text-[10px]">
              <thead className="sticky top-0 bg-card text-left text-muted-foreground">
                <tr>
                  <th className="px-1.5 py-1 font-medium">#</th>
                  <th className="px-1.5 py-1 font-medium">Symbol</th>
                  <th className="px-1.5 py-1 font-medium">Sector</th>
                  <th className="px-1.5 py-1 text-right font-medium">R</th>
                  <th className="px-1.5 py-1 text-right font-medium">Spread×</th>
                  <th className="px-1.5 py-1 text-right font-medium">Turn×</th>
                  <th className="px-1.5 py-1 text-right font-medium">Chg%</th>
                  <th className="px-1.5 py-1 text-right font-medium">Close</th>
                </tr>
              </thead>
              <tbody>
                {board.rows.map((r) => (
                  <tr
                    key={r.symbol}
                    className={`border-b border-border/30 ${suggested.has(r.symbol) ? 'bg-primary/10 font-medium' : ''}`}
                    title={suggested.has(r.symbol) ? 'Suggested today by the live scanner' : undefined}
                  >
                    <td className="px-1.5 py-0.5 tabular-nums">{r.rank}</td>
                    <td className="px-1.5 py-0.5 font-mono">
                      <SymbolLink symbol={r.symbol} />
                    </td>
                    <td className="px-1.5 py-0.5">{r.sector}</td>
                    <td className="px-1.5 py-0.5 text-right font-semibold tabular-nums">{r.rFactor.toFixed(2)}</td>
                    <td className="px-1.5 py-0.5 text-right tabular-nums">{r.spreadRatio.toFixed(2)}</td>
                    <td className="px-1.5 py-0.5 text-right tabular-nums">{r.turnoverRatio?.toFixed(2) ?? '—'}</td>
                    <td className={`px-1.5 py-0.5 text-right tabular-nums ${pctCls(r.pctChange)}`}>{fmtPct(r.pctChange)}</td>
                    <td className="px-1.5 py-0.5 text-right tabular-nums">{r.close}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {board.suggestionRanks.length > 0 && (
            <p className="mt-1.5 text-[10px] text-muted-foreground">
              Suggestion ranks on this board:{' '}
              {board.suggestionRanks.map((s) => `${s.symbol} ${s.optionType} → ${s.rank ?? 'unranked'}`).join(' · ')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
