'use client';

/**
 * TF Climbers — the live-trading cockpit for TradeFinder's Intraday Boost top 20.
 * Spec: docs/superpowers/specs/2026-10-08-tf-climbers-cockpit-design.md.
 *
 * Answers, at a glance on a laptop or a phone: what clears every check now
 * (TAKE), what is close and exactly which check it still needs (WATCH), what has
 * stalled, and what climbed earlier but left the top 20 (DROPPED — never just
 * vanishes). Every verdict comes from /api/tf/race, which runs the SAME selector
 * the auto-trader uses; the six dots are that selector's checks in its own order.
 *
 * Still participation evidence, not a standalone buy signal: the route withholds
 * every verdict off a stale or other-day board, and this card never re-derives one.
 */
import { ChevronDown, ChevronRight, ExternalLink, Loader2, Target } from 'lucide-react';
import { useEffect, useState } from 'react';
import { GATE_LABEL, GATE_ORDER, passedCount, type GateStrip } from '@/lib/tf-live/board-view';

interface TfBoardRow {
  symbol: string;
  rankNow: number;
  rankAtBaseline: number;
  climb: number;
  rFactor: number;
  deltaR: number | null;
  pctChange: number | null;
  side: 'CE' | 'PE';
  tradeable: boolean;
  blockedBy: string | null;
  premValueCr: number | null;
  sinceEntryPct: number | null;
  /** How stretched vs the stock's normal day — recorded evidence, NOT a check. */
  stretch: { rangeUsed: number; firstCandle: number | null; fromPrevClosePct: number } | null;
  gates: GateStrip;
  needs: string | null;
  trend: 'faster' | 'slower' | 'steady' | null;
  climbingSince: number | null;
  rPath: { minute: number; r: number }[];
  beacon: { dir: 'BULL' | 'BEAR'; time: string } | null;
  sector: { name: string; value: number } | null;
}

interface DroppedClimber {
  symbol: string;
  from: number;
  to: number;
  rankNow: number | null;
  rNow: number | null;
  deltaRNow: number | null;
}

interface TfRaceResponse {
  success: boolean;
  hasRace: boolean;
  date?: string;
  stale?: boolean;
  board?: TfBoardRow[];
  dropped?: DroppedClimber[];
  boardMinuteIST?: number | null;
  boardAgeMin?: number | null;
  verdictsLive?: boolean;
  verdictNote?: string | null;
  sessionOpenedToday?: boolean;
  windowStartMin?: number;
  windowEndMin?: number;
  error?: string;
}

/** At or below this the R-Factor is not advancing (mirrors the selector's minDeltaR). */
const FROZEN_DELTA_R = 0.05;
const BOARD_MAX_AGE_MIN = 10;
const POLL_SESSION_MS = 30_000;
const POLL_IDLE_MS = 5 * 60_000;

const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const pct = (v: number | null) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);
const chartUrl = (symbol: string) =>
  `https://in.tradingview.com/chart/?symbol=NSE%3A${encodeURIComponent(symbol)}&interval=5`;

/** IST minute-of-day and whether today is a weekday — for the countdown and poll cadence. */
function istNow(): { minute: number; weekday: boolean } {
  const parts = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const day = get('weekday');
  return { minute: Number(get('hour')) * 60 + Number(get('minute')), weekday: day !== 'Sat' && day !== 'Sun' };
}

/** 09:15–15:30 on a weekday: poll every 30 s; otherwise every 5 min. */
const inSession = () => {
  const { minute, weekday } = istNow();
  return weekday && minute >= 9 * 60 + 15 && minute <= 15 * 60 + 30;
};

/** Six dots in the selector's order. Green = passed, hollow = failed, grey = no data — never green without evidence. */
function GateDots({ gates }: { gates: GateStrip }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5" aria-label="checks">
      {GATE_ORDER.map((k) => {
        const g = gates[k];
        const cls =
          g === true
            ? 'bg-emerald-500 border-emerald-500'
            : g === false
              ? 'border-red-400 bg-transparent'
              : 'border-zinc-300 bg-zinc-200 dark:border-zinc-600 dark:bg-zinc-700';
        const state = g === true ? 'passed' : g === false ? 'not passed' : 'no data';
        return <span key={k} title={`${GATE_LABEL[k]}: ${state}`} className={`h-2 w-2 rounded-full border ${cls}`} />;
      })}
    </span>
  );
}

function TrendTag({ trend }: { trend: TfBoardRow['trend'] }) {
  if (trend === 'faster') return <span className="text-emerald-600 dark:text-emerald-400">▲faster</span>;
  if (trend === 'slower') return <span className="text-amber-600 dark:text-amber-400">▼slower</span>;
  if (trend === 'steady') return <span className="text-muted-foreground">steady</span>;
  return null;
}

/** The R-Factor path since 09:35 — a 48×14 sparkline. */
function RPath({ path }: { path: TfBoardRow['rPath'] }) {
  const W = 48;
  const H = 14;
  if (path.length < 2) return <span className="inline-block" style={{ width: W, height: H }} />;
  const rs = path.map((p) => p.r);
  const lo = Math.min(...rs);
  const span = Math.max(...rs) - lo || 1;
  const x = (i: number) => 1 + (i / (path.length - 1)) * (W - 2);
  const y = (r: number) => H - 1 - ((r - lo) / span) * (H - 2);
  const d = path.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.r).toFixed(1)}`).join(' ');
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="shrink-0" aria-hidden>
      <path d={d} fill="none" stroke="rgb(139 92 246)" strokeWidth={1.25} strokeLinejoin="round" />
    </svg>
  );
}

/** TF's own evidence — shown, and (beacon) also one of the six checks. */
function Chips({ r }: { r: TfBoardRow }) {
  return (
    <>
      {r.beacon && (
        <span
          title={`TradeFinder's breakout beacon: ${r.beacon.dir} at ${r.beacon.time}`}
          className={`rounded px-1 text-[10px] font-semibold ${
            r.beacon.dir === 'BULL'
              ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
              : 'bg-red-500/15 text-red-700 dark:text-red-300'
          }`}
        >
          TF{r.beacon.dir === 'BULL' ? '▲' : '▼'}
          {r.beacon.time}
        </span>
      )}
      {r.sector && (
        <span
          title="TradeFinder's own value for this stock's sector (a signed R-Factor, not a %). Shown only — never a check."
          className="rounded bg-muted px-1 text-[10px] text-muted-foreground"
        >
          {r.sector.name.replace(/^NIFTY /i, '')}{' '}
          <span className={r.sector.value >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>
            {r.sector.value >= 0 ? '+' : ''}
            {r.sector.value.toFixed(2)}
          </span>
        </span>
      )}
    </>
  );
}

function ChartLink({ symbol }: { symbol: string }) {
  return (
    <a
      href={chartUrl(symbol)}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      aria-label={`Open ${symbol} chart`}
      title="Open the 5-min chart"
      className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <ExternalLink className="h-3 w-3" />
    </a>
  );
}

/** The numbers behind a row — what the old card hid in a tooltip. */
function Details({ r }: { r: TfBoardRow }) {
  return (
    <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 rounded bg-muted/40 px-2 py-1 text-[10px] sm:grid-cols-3">
      <div>
        <dt className="inline text-muted-foreground">rank </dt>
        <dd className="inline">
          #{r.rankNow} {r.climb > 0 ? `(up ${r.climb} from #${r.rankAtBaseline})` : `(#${r.rankAtBaseline} at 09:35)`}
        </dd>
      </div>
      <div>
        <dt className="inline text-muted-foreground">TF R </dt>
        <dd className="inline">{r.rFactor.toFixed(2)}</dd>
      </div>
      <div>
        <dt className="inline text-muted-foreground">30-min rise </dt>
        <dd className="inline">{r.deltaR == null ? 'unknown' : `${r.deltaR >= 0 ? '+' : ''}${r.deltaR.toFixed(2)}`}</dd>
      </div>
      <div>
        <dt className="inline text-muted-foreground">climbing since </dt>
        <dd className="inline">{r.climbingSince == null ? '—' : hhmm(r.climbingSince)}</dd>
      </div>
      <div>
        <dt className="inline text-muted-foreground">options pool </dt>
        <dd className="inline">{r.premValueCr == null ? 'no reading' : `₹${Math.round(r.premValueCr)} Cr`}</dd>
      </div>
      <div>
        <dt className="inline text-muted-foreground">since 09:45 </dt>
        <dd className="inline">{r.sinceEntryPct == null ? 'unrecorded' : pct(r.sinceEntryPct)}</dd>
      </div>
      <div
        className="col-span-full"
        title="Recorded to measure, not a check: how much of a normal day's range (10-day average) is already used, the 09:15 candle against a normal day, and the move from yesterday's close in the trade's direction."
      >
        <dt className="inline text-muted-foreground">vs normal day </dt>
        <dd className="inline">
          {r.stretch == null
            ? 'no daily baseline'
            : `range used ${r.stretch.rangeUsed.toFixed(2)}× · 1st candle ${
                r.stretch.firstCandle == null ? '—' : `${r.stretch.firstCandle.toFixed(2)}×`
              } · ${pct(r.stretch.fromPrevClosePct)} from prev close`}
        </dd>
      </div>
      {r.needs && <div className="col-span-full">needs: {r.needs}</div>}
      <div className="col-span-full">
        {GATE_ORDER.map((k) => (
          <span key={k} className="mr-2">
            {r.gates[k] === true ? '✓' : r.gates[k] === false ? '✗' : '?'} {GATE_LABEL[k]}
          </span>
        ))}
      </div>
    </dl>
  );
}

/** A name that clears every check — the answer to "what now". Big on purpose. */
function TakeRow({ r }: { r: TfBoardRow }) {
  const bull = r.side === 'CE';
  return (
    <div className="rounded-md border border-emerald-500/50 bg-emerald-500/10 px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-bold text-white ${bull ? 'bg-emerald-600' : 'bg-red-600'}`}
        >
          {r.side}
        </span>
        <span className="text-[14px] font-bold text-foreground">{r.symbol}</span>
        <span className={`text-[12px] font-semibold tabular-nums ${bull ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300'}`}>
          {pct(r.pctChange)}
        </span>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          TF R <b className="text-violet-600 dark:text-violet-400">{r.rFactor.toFixed(2)}</b>{' '}
          <b className="text-emerald-600 dark:text-emerald-400">↑{(r.deltaR ?? 0).toFixed(2)}/30m</b>{' '}
          <TrendTag trend={r.trend} />
        </span>
        <Chips r={r} />
        <span className="ml-auto flex items-center gap-1">
          <RPath path={r.rPath} />
          <ChartLink symbol={r.symbol} />
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[10px] text-muted-foreground">
        <GateDots gates={r.gates} />
        <span>{GATE_ORDER.map((k) => GATE_LABEL[k]).join(' · ')}</span>
        {r.climbingSince != null && <span>· climbing since {hhmm(r.climbingSince)}</span>}
      </div>
    </div>
  );
}

/** A name still climbing but short of TAKE — shows exactly which check it needs. Tap for the numbers. */
function WatchRow({ r, dim = false }: { r: TfBoardRow; dim?: boolean }) {
  const [open, setOpen] = useState(false);
  const bull = r.side === 'CE';
  const flat = r.deltaR == null || r.deltaR <= FROZEN_DELTA_R;
  return (
    <div className={`rounded border border-border px-1.5 py-0.5 ${dim ? 'bg-muted/10 opacity-60' : 'bg-muted/30'}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-x-1.5 text-left"
      >
        <span className="w-6 shrink-0 text-[10px] font-bold tabular-nums text-foreground">#{r.rankNow}</span>
        <span className="min-w-14 text-[11px] font-semibold text-foreground">{r.symbol}</span>
        <span className="text-[10px] tabular-nums text-violet-600 dark:text-violet-400">R {r.rFactor.toFixed(2)}</span>
        <span className={`text-[10px] font-semibold tabular-nums ${flat ? 'text-muted-foreground' : 'text-emerald-600 dark:text-emerald-400'}`}>
          {r.deltaR == null ? '—' : flat ? 'flat' : `↑${r.deltaR.toFixed(2)}`}
        </span>
        <span className="text-[10px]">
          <TrendTag trend={r.trend} />
        </span>
        <span className={`text-[10px] tabular-nums ${bull ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
          {pct(r.pctChange)}
        </span>
        <Chips r={r} />
        {r.needs && (
          <span title={`needs: ${r.needs}`} className="min-w-0 flex-1 truncate text-[9px] text-muted-foreground">
            needs: {r.needs}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <GateDots gates={r.gates} />
          <ChartLink symbol={r.symbol} />
        </span>
      </button>
      {open && <Details r={r} />}
    </div>
  );
}

function Collapsible({ title, hint, count, children }: { title: string; hint: string; count: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={hint}
        className="flex w-full items-center gap-1 text-left text-[10px] font-semibold tracking-wide text-muted-foreground uppercase hover:text-foreground"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {title} ({count})
      </button>
      {open && <div className="mt-1 flex flex-col gap-1">{children}</div>}
    </div>
  );
}

function DroppedRow({ d }: { d: DroppedClimber }) {
  const flat = d.deltaRNow == null || d.deltaRNow <= FROZEN_DELTA_R;
  return (
    <div className="flex flex-wrap items-center gap-x-2 rounded border border-dashed border-border px-1.5 py-1 text-[10px]">
      <span className="min-w-16 font-semibold text-foreground">{d.symbol}</span>
      <span className="text-muted-foreground">
        climbing {hhmm(d.from)}
        {d.to !== d.from ? `–${hhmm(d.to)}` : ''}
      </span>
      <span className="tabular-nums text-muted-foreground">
        {d.rankNow == null
          ? 'left Intraday Boost'
          : `now #${d.rankNow}${d.rNow != null ? `, R ${d.rNow.toFixed(2)}` : ''} ${
              d.deltaRNow == null ? '' : flat ? 'flat' : `↑${d.deltaRNow.toFixed(2)}`
            }`}
      </span>
      <span className="ml-auto">
        <ChartLink symbol={d.symbol} />
      </span>
    </div>
  );
}

/** "entries open 09:45" / "closes in 23 min" / "closed" — the ENTRY window, not the board's age. */
function WindowBadge({ start, end, stale }: { start: number; end: number; stale: boolean }) {
  const [now, setNow] = useState(() => istNow().minute);
  useEffect(() => {
    const t = setInterval(() => setNow(istNow().minute), 30_000);
    return () => clearInterval(t);
  }, []);
  const text = stale
    ? `entry ${hhmm(start)}–${hhmm(end)}`
    : now < start
      ? `entries open ${hhmm(start)}`
      : now <= end
        ? `entries close in ${end - now} min`
        : `entries closed (${hhmm(start)}–${hhmm(end)})`;
  const live = !stale && now >= start && now <= end;
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-medium tabular-nums ${
        live ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' : 'bg-muted text-muted-foreground'
      }`}
    >
      {text}
    </span>
  );
}

export function TfRaceCard() {
  const [data, setData] = useState<TfRaceResponse | null>(null);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const res = await fetch('/api/tf/race', { cache: 'no-store' });
        const j = (await res.json()) as TfRaceResponse;
        if (!stopped) setData(j);
      } catch {
        /* transient — the next poll retries */
      }
      if (!stopped) timer = setTimeout(load, inSession() ? POLL_SESSION_MS : POLL_IDLE_MS);
    };
    void load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  const board = data?.board ?? [];
  const dropped = data?.dropped ?? [];
  const verdictsLive = data?.verdictsLive !== false;
  const take = board.filter((r) => r.tradeable);
  const climbing = (r: TfBoardRow) => r.deltaR != null && r.deltaR > FROZEN_DELTA_R;
  // Closest to TAKE first: most checks passed, then the stronger TF R-Factor.
  const watch = board
    .filter((r) => !r.tradeable && climbing(r))
    .sort((a, b) => passedCount(b.gates) - passedCount(a.gates) || b.rFactor - a.rFactor);
  const stalled = board.filter((r) => !r.tradeable && !climbing(r));
  const old = data?.boardAgeMin != null && data.boardAgeMin > BOARD_MAX_AGE_MIN;

  return (
    <section className="flex h-full flex-col rounded-lg border border-border bg-card">
      <header className="flex flex-wrap items-center gap-1.5 border-b border-border px-2 py-1">
        <Target className="h-3.5 w-3.5 text-violet-500" />
        <h2 className="text-[12px] font-semibold tracking-wide text-foreground uppercase">TF Climbers</h2>
        {data?.boardMinuteIST != null && (
          <span
            title="When the TradeFinder board behind every number here was captured."
            className={`rounded px-1.5 py-0.5 text-[10px] font-medium tabular-nums ${
              old ? 'bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400' : 'bg-muted text-muted-foreground'
            }`}
          >
            {!data.stale && !old && <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />}
            board {hhmm(data.boardMinuteIST)}
            {old ? ` · ${data.boardAgeMin}m old` : ''}
          </span>
        )}
        {data?.stale && data.date && (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
            {data.date} · not today
          </span>
        )}
        <span className="ml-auto">
          <WindowBadge start={data?.windowStartMin ?? 585} end={data?.windowEndMin ?? 660} stale={data?.stale === true} />
        </span>
      </header>
      <p className="border-b border-border px-2 py-1 text-[10px] leading-snug text-muted-foreground">
        TF Intraday Boost top 20. A name is <b className="text-emerald-700 dark:text-emerald-300">TAKE</b> when it passes all
        six checks — the same ones the auto-trader uses. Participation evidence, not a buy signal by itself.
      </p>
      <div className="flex-1 px-2 py-1.5">
        {!data ? (
          <p className="flex items-center justify-center gap-2 py-3 text-[11px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin text-primary" /> Loading…
          </p>
        ) : !data.success ? (
          <p className="py-3 text-center text-[11px] text-red-600 dark:text-red-400">{data.error ?? 'unavailable'}</p>
        ) : board.length === 0 ? (
          <p className="py-3 text-center text-[11px] text-muted-foreground">
            {data.sessionOpenedToday ? (
              <>
                <b className="text-foreground">Today&apos;s board isn&apos;t ready yet.</b> It needs TradeFinder captures after
                09:35 IST — check{' '}
                <a href="/tf" className="underline">
                  /tf
                </a>{' '}
                is capturing. An earlier day&apos;s board is deliberately not shown: TF&apos;s R-Factor restarts each morning.
              </>
            ) : (
              <>
                No TradeFinder race on record yet. Check{' '}
                <a href="/tf" className="underline">
                  /tf
                </a>{' '}
                is capturing.
              </>
            )}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {!verdictsLive ? (
              <p className="rounded border border-amber-300/60 bg-amber-50 px-2 py-1.5 text-[10px] leading-snug text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
                <b>No picks from this board.</b> {data.verdictNote}
              </p>
            ) : take.length > 0 ? (
              <div className="flex flex-col gap-1">
                <p className="text-[10px] font-semibold tracking-wide text-emerald-700 uppercase dark:text-emerald-300">
                  Take ({take.length})
                </p>
                {take.map((r) => (
                  <TakeRow key={r.symbol} r={r} />
                ))}
              </div>
            ) : (
              <p className="rounded border border-dashed border-border px-2 py-1.5 text-center text-[10px] text-muted-foreground">
                Nothing passes all six checks right now.{watch.length > 0 ? ' Closest names below.' : ''}
              </p>
            )}

            {watch.length > 0 && (
              <div className="flex flex-col gap-1">
                <p className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                  Watch · still climbing ({watch.length})
                </p>
                {watch.map((r) => (
                  <WatchRow key={r.symbol} r={r} />
                ))}
              </div>
            )}

            {stalled.length > 0 && (
              <Collapsible
                title="Stalled · R-Factor not advancing"
                hint="Still in TF's top 20, but the R-Factor stopped rising — the money is in, none is arriving."
                count={stalled.length}
              >
                {stalled.map((r) => (
                  <WatchRow key={r.symbol} r={r} dim />
                ))}
              </Collapsible>
            )}

            {dropped.length > 0 && (
              <Collapsible
                title="Dropped · climbed earlier, left the top 20"
                hint="Names that were climbing inside TF's top 20 earlier today — kept visible, never silently removed."
                count={dropped.length}
              >
                {dropped.map((d) => (
                  <DroppedRow key={d.symbol} d={d} />
                ))}
              </Collapsible>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
