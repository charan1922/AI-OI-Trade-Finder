'use client';

/**
 * TF Running Race — who TradeFinder's own R-Factor ranks as climbing fastest
 * inside the 09:35–11:00 IST entry window, mirroring ClimbersSection's
 * pattern but sourced from TradeFinder captures (lib/tf-live/race.ts) instead
 * of NSE's live pulse feeds.
 *
 * Deliberately framed as PARTICIPATION evidence, not a buy trigger — this
 * codebase's own hard rule (R-Factor ratchets up all day; it says WHERE the
 * money is, not WHEN to enter) applies here just as much as to the app's own
 * R-Factor. It never selects, sizes, or approves a trade; use it alongside
 * the existing scanner gates, not instead of them.
 */
import { ArrowDown, ArrowUp, Info, Loader2, Sparkles, Target } from 'lucide-react';
import { useEffect, useState } from 'react';

interface TfRaceRunner {
  symbol: string;
  rankNow: number;
  rankAtWindowStart: number | null;
  deltaSinceWindowStart: number | null;
  rFactorNow: number | null;
  isNew: boolean;
  track: (number | null)[];
}

/** One condition of the operator's daily screen. `pass: null` = could not be
 *  evaluated (no candles today / no prior bhavcopy), which is NOT a pass. */
interface ScreenCheck {
  key: string;
  label: string;
  pass: boolean | null;
  detail: string;
}
interface ScreenResult {
  symbol: string;
  passes: boolean;
  checks: ScreenCheck[];
}

interface TfRaceResponse {
  success: boolean;
  hasRace: boolean;
  captureTimes: number[];
  runners: TfRaceRunner[];
  newEntrants: TfRaceRunner[];
  /** Per-symbol daily-screen verdict, keyed by symbol. Absent when the screen
   *  could not run at all — the race still renders. */
  screen?: Record<string, ScreenResult>;
  error?: string;
}

/**
 * Screen badge. THREE states, not two — "we could not check" must never look
 * like "it qualifies": we record intraday candles for ~166 symbols while the
 * F&O universe is ~216, so a runner can be unevaluable purely for lack of data.
 */
function ScreenBadge({ s }: { s: ScreenResult | undefined }) {
  if (s == null) return null;
  const unevaluable = s.checks.every((c) => c.pass === null);
  const failed = s.checks.filter((c) => c.pass === false);
  const tip = s.checks.map((c) => `${c.pass === true ? '✓' : c.pass === false ? '✗' : '?'} ${c.label} — ${c.detail}`).join('\n');

  if (unevaluable) {
    return (
      <span className="rounded bg-muted px-1 text-[8px] font-medium text-muted-foreground" title={`Daily screen could not be evaluated:\n${tip}`}>
        no data
      </span>
    );
  }
  if (s.passes) {
    return (
      <span
        className="rounded bg-emerald-500/15 px-1 text-[8px] font-semibold text-emerald-700 dark:text-emerald-300"
        title={`Clears the daily screen:\n${tip}`}
      >
        screen ✓
      </span>
    );
  }
  return (
    <span
      className="rounded bg-muted px-1 text-[8px] font-medium text-muted-foreground"
      title={`Does not clear the daily screen:\n${tip}`}
    >
      {failed.length === 1 ? `fails ${failed[0].key}` : `fails ${failed.length}`}
    </span>
  );
}

function RankSparkline({ track, climbed }: { track: (number | null)[]; climbed: boolean }) {
  const W = 56;
  const H = 16;
  const pts = track.map((r, i) => ({ i, r })).filter((p): p is { i: number; r: number } => p.r != null);
  if (pts.length < 2) return <span className="inline-block" style={{ width: W, height: H }} />;
  const ranks = pts.map((p) => p.r);
  const minR = Math.min(...ranks);
  const maxR = Math.max(...ranks);
  const span = maxR - minR || 1;
  const n = track.length - 1 || 1;
  const x = (i: number) => 1 + (i / n) * (W - 2);
  const y = (r: number) => 1 + ((r - minR) / span) * (H - 2);
  const d = pts.map((p, k) => `${k === 0 ? 'M' : 'L'}${x(p.i).toFixed(1)},${y(p.r).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  const stroke = climbed ? 'rgb(16 185 129)' : 'rgb(239 68 68)';
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="shrink-0" aria-hidden>
      <path d={d} fill="none" stroke={stroke} strokeWidth={1.25} strokeLinejoin="round" strokeLinecap="round" opacity={0.85} />
      <circle cx={x(last.i)} cy={y(last.r)} r={1.6} fill={stroke} />
    </svg>
  );
}

function RunnerRow({ r, screen }: { r: TfRaceRunner; screen?: ScreenResult }) {
  const climbed = (r.deltaSinceWindowStart ?? 0) > 0;
  return (
    <div
      onClick={() =>
        window.open(`https://in.tradingview.com/chart/?symbol=NSE%3A${encodeURIComponent(r.symbol)}&interval=5`, '_blank', 'noopener,noreferrer')
      }
      title={`${r.symbol} — now #${r.rankNow} in TF R-Factor, from #${r.rankAtWindowStart ?? '—'} at the 09:35 baseline. "TF R ${r.rFactorNow?.toFixed(2) ?? '—'}" is TradeFinder's OWN R-Factor for this stock at the latest capture — not our estimate of it. Open chart.`}
      className="flex cursor-pointer items-center gap-1 rounded border border-border bg-muted/30 px-1 py-px hover:bg-muted/60"
    >
      <span className="w-6 shrink-0 text-center text-[11px] font-bold text-foreground tabular-nums">#{r.rankNow}</span>
      <span className="w-14 truncate text-[10px] font-medium text-foreground">{r.symbol}</span>
      <span className={`flex shrink-0 items-center gap-0.5 text-[9px] tabular-nums ${climbed ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
        {climbed ? <ArrowUp className="h-2.5 w-2.5" /> : <ArrowDown className="h-2.5 w-2.5" />}
        {Math.abs(r.deltaSinceWindowStart ?? 0)}
      </span>
      <RankSparkline track={r.track} climbed={climbed} />
      <ScreenBadge s={screen} />
      {/* Labelled "TF R", not "R" — this is TradeFinder's own number straight
          off their board, and the bare "R" read as though it might be this
          app's R-Factor (operator, 2026-08-11: "i am not sure what this is").
          Two decimals to match every other place TF's R-Factor is shown. */}
      <span
        className="ml-auto text-[9px] text-muted-foreground tabular-nums"
        title="TradeFinder's OWN R-Factor for this stock at the latest capture — not this app's R-Factor."
      >
        {r.rFactorNow != null ? `TF R ${r.rFactorNow.toFixed(2)}` : '—'}
      </span>
    </div>
  );
}

export function TfRaceCard() {
  const [data, setData] = useState<TfRaceResponse | null>(null);

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const res = await fetch('/api/tf/race', { cache: 'no-store' });
        const j = (await res.json()) as TfRaceResponse;
        if (!stopped) setData(j);
      } catch {
        /* transient — next poll retries */
      }
    };
    void load();
    const timer = setInterval(load, 5 * 60_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  const runners = data?.runners ?? [];
  const newEntrants = data?.newEntrants ?? [];

  return (
    <section className="flex h-full flex-col rounded-lg border border-border bg-card">
      <header className="flex flex-wrap items-center gap-1.5 border-b border-border px-2 py-1">
        <Target className="h-3.5 w-3.5 text-violet-500" />
        <h2 className="text-[12px] font-semibold tracking-wide text-foreground uppercase">TF Running Race</h2>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">09:35–11:00 IST</span>
      </header>
      <p
        className="flex items-start gap-1 border-b border-amber-300/40 bg-amber-50 px-2 py-1 text-[10px] leading-snug text-amber-800 dark:bg-amber-500/10 dark:text-amber-300"
        title="Same rule as this app's own R-Factor: participation evidence, not entry timing. It says who is gaining ground on TradeFinder's own board — never a standalone reason to buy a contract. Confirm with the scanner's gates first."
      >
        <Info className="mt-0.5 h-3 w-3 shrink-0" />
        Who&apos;s climbing TradeFinder&apos;s own board right now — participation evidence, NOT a buy signal by itself.
        Confirm with the scanner&apos;s gates before entering.
      </p>
      {/* Legend for the badge. Sorted by TF R-Factor, so the caption says so —
          the list is NOT ordered by how far each name climbed. */}
      <p className="border-b border-border px-2 py-1 text-[9px] leading-snug text-muted-foreground">
        Ordered by TF R-Factor. <span className="font-semibold text-emerald-700 dark:text-emerald-300">screen ✓</span> = also
        clears your daily screen (close &gt; VWAP, close &gt; prior day&apos;s high, volume &gt; 5,00,000, close &gt; 900).
        Hover a badge for the numbers. Nothing is hidden — a name that fails the screen is still climbing.
      </p>
      <div className="flex-1 px-2 py-1.5">
        {!data ? (
          <p className="flex items-center justify-center gap-2 py-3 text-[11px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin text-primary" /> Loading…
          </p>
        ) : !data.success ? (
          <p className="py-3 text-center text-[11px] text-red-600 dark:text-red-400">{data.error ?? 'unavailable'}</p>
        ) : !data.hasRace ? (
          <p className="py-3 text-center text-[11px] text-muted-foreground">
            Needs at least 2 captures inside today&apos;s 09:35–11:00 IST window to show a race —{' '}
            <a href="/tf" className="underline">
              check /tf
            </a>{' '}
            is capturing successfully.
          </p>
        ) : runners.length === 0 && newEntrants.length === 0 ? (
          <p className="py-3 text-center text-[11px] text-muted-foreground">No one&apos;s climbed TF&apos;s board in this window yet.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {runners.map((r) => (
              <RunnerRow key={r.symbol} r={r} screen={data.screen?.[r.symbol]} />
            ))}
            {newEntrants.length > 0 && (
              <div>
                <p className="flex items-center gap-1 text-[9px] font-medium text-muted-foreground">
                  <Sparkles className="h-2.5 w-2.5 text-amber-500" /> New since 09:35
                </p>
                <div className="flex flex-wrap gap-1">
                  {newEntrants.map((r) => (
                    <span
                      key={r.symbol}
                      onClick={() =>
                        window.open(`https://in.tradingview.com/chart/?symbol=NSE%3A${encodeURIComponent(r.symbol)}&interval=5`, '_blank', 'noopener,noreferrer')
                      }
                      title={`${r.symbol} — new at #${r.rankNow}. Open chart.`}
                      className="inline-flex cursor-pointer items-center gap-1 rounded border border-amber-300/50 bg-amber-50 px-1.5 py-0.5 text-[9px] dark:bg-amber-500/10"
                    >
                      <span className="font-semibold text-foreground">{r.symbol}</span>
                      <span className="text-muted-foreground">#{r.rankNow}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
