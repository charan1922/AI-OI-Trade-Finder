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
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Info, Loader2, Sparkles, Target } from 'lucide-react';
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
  /** IST date the board actually came from — not always today (see `stale`). */
  date?: string;
  /** True when today has no usable race yet and this is a RETAINED board from an
   *  earlier session. The header says so; a held-over board must never read as live. */
  stale?: boolean;
  /** TF's top-N by R-Factor — NOT filtered to names that climbed. See the route. */
  board?: TfBoardRow[];
  /** IST minute-of-day the board was actually captured at. The window badge is
   *  the ENTRY WINDOW, not the data's age — these are different things. */
  boardMinuteIST?: number | null;
  /** How old the board is, in minutes. Null when it is from another session. */
  boardAgeMin?: number | null;
  /** False when the board is one the SCANNER would refuse (another session, or
   *  older than TF_BOARD_MAX_AGE_MIN). No green "would take it" row may render:
   *  the claim is present tense and the evidence is not. */
  verdictsLive?: boolean;
  /** Why the verdict is withheld, in plain English. Shown in place of the picks. */
  verdictNote?: string | null;
  /** True on a weekday past 09:15 IST — today's session has opened. */
  sessionOpenedToday?: boolean;
  error?: string;
}

/** One row of TF's board, carrying the accumulation RATE and the engine verdict. */
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
  supertrendAligned: boolean | null;
  breakout: boolean | null;
}

/** At or below this, TF's R-Factor is not meaningfully advancing — the frozen
 *  state that measured −0.286R (n=1160) against +0.474R for surging names.
 *  Mirrors DEFAULT_TF_SELECTOR_CONFIG.minDeltaR. */
const FROZEN_DELTA_R = 0.05;

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

/**
 * One board row. Rank is context; the RATE is the signal.
 *
 * A frozen name is DIMMED, never hidden — the operator should be able to see
 * that TF's own #1 has stopped accumulating, which is precisely what the old
 * climb-filtered list concealed. And a name that never climbed (PNB at TF R
 * 4.33, second on the whole board) now appears at all.
 */
function BoardRow({ r }: { r: TfBoardRow }) {
  const frozen = r.deltaR == null || r.deltaR <= FROZEN_DELTA_R;
  const bull = r.side === 'CE';
  const lines = [
    `${r.symbol} — TF R-Factor ${r.rFactor.toFixed(2)}, rank #${r.rankNow}${
      r.climb > 0 ? ` (up ${r.climb} from #${r.rankAtBaseline})` : ` (was #${r.rankAtBaseline} at the baseline)`
    }`,
    `Accumulation rate: ${
      r.deltaR == null
        ? 'unknown — no board 30 min earlier'
        : `${r.deltaR >= 0 ? '+' : ''}${r.deltaR.toFixed(2)} TF R over the last 30 min`
    }`,
    `TF has it ${bull ? 'up' : 'down'} ${Math.abs(r.pctChange ?? 0).toFixed(2)}% today`,
    r.premValueCr != null ? `Options premium pool ₹${Math.round(r.premValueCr)} Cr` : 'No options premium reading',
    r.tradeable ? 'The scanner would take this' : `Not tradeable: ${r.blockedBy}`,
    'Open chart.',
  ];
  return (
    <div
      onClick={() =>
        window.open(
          `https://in.tradingview.com/chart/?symbol=NSE%3A${encodeURIComponent(r.symbol)}&interval=5`,
          '_blank',
          'noopener,noreferrer'
        )
      }
      title={lines.join('\n')}
      className={`flex cursor-pointer items-center gap-1 rounded border px-1 py-px hover:bg-muted/60 ${
        r.tradeable
          ? 'border-emerald-500/40 bg-emerald-500/5'
          : frozen
            ? 'border-border bg-muted/10 opacity-55'
            : 'border-border bg-muted/30'
      }`}
    >
      <span className="w-6 shrink-0 text-center text-[11px] font-bold text-foreground tabular-nums">#{r.rankNow}</span>
      <span className="w-16 truncate text-[10px] font-medium text-foreground">{r.symbol}</span>
      <span
        className="w-10 shrink-0 text-[10px] font-semibold text-violet-600 tabular-nums dark:text-violet-400"
        title="TradeFinder's OWN R-Factor — how much big money has gone in today, cumulatively."
      >
        {r.rFactor.toFixed(2)}
      </span>
      {/* THE signal: the rate money is arriving, not the level already there. */}
      <span
        className={`w-11 shrink-0 text-[10px] font-semibold tabular-nums ${
          frozen ? 'text-muted-foreground' : 'text-emerald-600 dark:text-emerald-400'
        }`}
        title="Change in TF R-Factor over the trailing 30 minutes. Flat = the build has stalled."
      >
        {r.deltaR == null ? '—' : frozen ? 'flat' : `+${r.deltaR.toFixed(2)}`}
      </span>
      <span
        className={`w-12 shrink-0 text-[9px] tabular-nums ${bull ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}
      >
        {(r.pctChange ?? 0) >= 0 ? '+' : ''}
        {(r.pctChange ?? 0).toFixed(2)}%
      </span>
      {r.tradeable ? (
        <span className="ml-auto shrink-0 rounded bg-emerald-500/15 px-1 text-[8px] font-bold text-emerald-700 dark:text-emerald-300">
          {r.side} ✓
        </span>
      ) : (
        <span className="ml-auto truncate pl-1 text-[8px] text-muted-foreground">{r.blockedBy}</span>
      )}
    </div>
  );
}

/**
 * An ACTIONABLE name — a name that cleared every selector gate.
 *
 * Deliberately larger and louder than a board row. There are usually 0–2 of
 * these against ~20 board names, and the whole point of the card is that the
 * operator can find them without reading the other eighteen.
 *
 * It states the CASE, not just the numbers: side, how fast money is arriving,
 * and the two facts that let it through (breakout + a real options pool). Still
 * participation evidence — the scanner owns the actual entry.
 */
function TakeRow({ r }: { r: TfBoardRow }) {
  const bull = r.side === 'CE';
  return (
    <div
      onClick={() =>
        window.open(
          `https://in.tradingview.com/chart/?symbol=NSE%3A${encodeURIComponent(r.symbol)}&interval=5`,
          '_blank',
          'noopener,noreferrer'
        )
      }
      title={`${r.symbol} — clears every gate. TF R-Factor ${r.rFactor.toFixed(2)} (rank #${r.rankNow}), still building at +${(r.deltaR ?? 0).toFixed(2)} over 30 min, ${bull ? 'up' : 'down'} ${Math.abs(r.pctChange ?? 0).toFixed(2)}% today${r.premValueCr != null ? `, options pool ₹${Math.round(r.premValueCr)} Cr` : ''}. Open chart.`}
      className="flex cursor-pointer items-center gap-2 rounded-md border border-emerald-500/50 bg-emerald-500/10 px-2 py-1 hover:bg-emerald-500/20"
    >
      <span
        className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${
          bull
            ? 'bg-emerald-600 text-white dark:bg-emerald-500'
            : 'bg-red-600 text-white dark:bg-red-500'
        }`}
      >
        {r.side}
      </span>
      <span className="text-[13px] font-bold text-foreground">{r.symbol}</span>
      <span className={`text-[11px] font-semibold tabular-nums ${bull ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300'}`}>
        {(r.pctChange ?? 0) >= 0 ? '+' : ''}
        {(r.pctChange ?? 0).toFixed(2)}%
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[9px] text-muted-foreground">
        <span title="TradeFinder's own R-Factor — cumulative big-money participation today.">
          TF R <span className="font-semibold text-violet-600 dark:text-violet-400">{r.rFactor.toFixed(2)}</span>
        </span>
        <span
          className="font-semibold text-emerald-600 dark:text-emerald-400"
          title="Still accumulating: TF R-Factor gained over the trailing 30 minutes. This is the signal, not the level."
        >
          ↑{(r.deltaR ?? 0).toFixed(2)}/30m
        </span>
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

  const [showAll, setShowAll] = useState(false);

  const runners = data?.runners ?? [];
  const newEntrants = data?.newEntrants ?? [];
  // The full board is preferred when the route supplies it; the climb-filtered
  // runner list stays as the fallback so an older/failing route still renders.
  const board = data?.board ?? [];

  // ── Three tiers by ACTIONABILITY, not by rank ────────────────────────────
  //
  // A flat top-20 list is a data dump: on a typical board 18 of 20 rows read
  // "R-Factor stopped climbing", so the operator has to read past sixteen dead
  // names to find the two that matter (operator, 2026-08-13). Rank order is the
  // right way to RANK a board and the wrong way to PRESENT a decision.
  //
  //  TAKE     — clears every selector gate. This is the answer to "what now".
  //  BUILDING — still accumulating (ΔR above the frozen floor) but failing one
  //             gate. These are the names that can flip to TAKE within minutes,
  //             so they earn a visible line rather than the collapsed tail.
  //  STALLED  — R-Factor has stopped advancing. Not deleted (a stall can end,
  //             and hiding TF's own #1 is the mistake this card just fixed) —
  //             collapsed behind a count, with the names still one click away.
  //
  // When the route withholds the verdict (`verdictsLive === false`) NOTHING is
  // green: `tradeable` already comes back false for every row, so TAKE is empty
  // by construction and the note below says why. See the route — a board from
  // another session, or one the scanner would refuse as stale, must never
  // present a name as today's answer.
  const take = board.filter((r) => r.tradeable);
  const building = board.filter((r) => !r.tradeable && r.deltaR != null && r.deltaR > FROZEN_DELTA_R);
  const stalled = board.filter((r) => !r.tradeable && !(r.deltaR != null && r.deltaR > FROZEN_DELTA_R));
  const verdictsLive = data?.verdictsLive !== false;

  return (
    <section className="flex h-full flex-col rounded-lg border border-border bg-card">
      <header className="flex flex-wrap items-center gap-1.5 border-b border-border px-2 py-1">
        <Target className="h-3.5 w-3.5 text-violet-500" />
        {/* Display label only — lib/tf-live/race.ts and /api/tf/race are unchanged. */}
        <h2 className="text-[12px] font-semibold tracking-wide text-foreground uppercase">TF Climbers</h2>
        <span
          className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
          title="The window in which entries are allowed. It describes WHEN trades may be taken — not when this board was captured; that is the separate time badge."
        >
          entry 09:35–11:00
        </span>
        {/* The board's REAL capture time. Without it, a 14:56 board shown under
            a "09:35-11:00" heading reads as if it were the 11:00 board. */}
        {data?.boardMinuteIST != null ? (
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-medium tabular-nums ${
              data.boardAgeMin != null && data.boardAgeMin > 10
                ? 'bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400'
                : 'bg-muted text-muted-foreground'
            }`}
            title={
              data.boardAgeMin == null
                ? 'The clock time of the TradeFinder capture this board comes from.'
                : `The clock time of the TradeFinder capture this board comes from — ${data.boardAgeMin} min ago. Past 10 min the scanner refuses to act on it.`
            }
          >
            board {String(Math.floor(data.boardMinuteIST / 60)).padStart(2, '0')}:
            {String(data.boardMinuteIST % 60).padStart(2, '0')}
            {data.boardAgeMin != null && data.boardAgeMin > 10 ? ` · ${data.boardAgeMin}m old` : ''}
          </span>
        ) : null}
        {/* Retained board — labelled with the session it belongs to, in the same
            amber the rest of /live uses for "this is not live". */}
        {data?.stale && data.date ? (
          <span
            className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-400"
            title="The market is closed, so this is the last session that produced a usable race — a closing snapshot, not a live board, and not a set of calls for the next session. Once today's session opens this is replaced by today's board or by nothing at all."
          >
            {data.date} · not today
          </span>
        ) : null}
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
        TradeFinder&apos;s top 20 by their own R-Factor — columns are rank · TF R · 30-min rate · move.{' '}
        <span className="font-semibold text-emerald-700 dark:text-emerald-300">Green</span> = the scanner would take it;
        every other row shows the first gate it fails. <span className="font-semibold">flat</span> = the R-Factor has
        stopped climbing (the money is already in, none is arriving) — dimmed, never hidden. Hover any row for the numbers.
      </p>
      <div className="flex-1 px-2 py-1.5">
        {!data ? (
          <p className="flex items-center justify-center gap-2 py-3 text-[11px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin text-primary" /> Loading…
          </p>
        ) : !data.success ? (
          <p className="py-3 text-center text-[11px] text-red-600 dark:text-red-400">{data.error ?? 'unavailable'}</p>
        ) : !data.hasRace ? (
          /* Deliberately NOT filled in with an earlier session's board once
             today's session has opened — TF's R-Factor restarts every morning,
             so yesterday's board is not a weaker answer, it is a wrong one. */
          <p className="py-3 text-center text-[11px] text-muted-foreground">
            {data.sessionOpenedToday ? (
              <>
                <b className="text-foreground">Today&apos;s board isn&apos;t ready yet.</b> The race needs 2+ TradeFinder
                captures after 09:35 IST. Yesterday&apos;s board is deliberately not shown — TF&apos;s R-Factor restarts
                each morning, so it would say nothing about today. Check{' '}
                <a href="/tf" className="underline">
                  /tf
                </a>{' '}
                is capturing.
              </>
            ) : (
              <>
                No TradeFinder race on record — a session needs 2+ captures inside 09:35–11:00 IST, and no recent one
                has that. Check{' '}
                <a href="/tf" className="underline">
                  /tf
                </a>{' '}
                is capturing successfully.
              </>
            )}
          </p>
        ) : board.length > 0 ? (
          <div className="flex flex-col gap-2">
            {/* ① TAKE — the answer to "what do I do". Never collapsed. */}
            {!verdictsLive ? (
              /* The board is real, the VERDICT is not available — say which, and
                 never let the rows below read as picks. */
              <p className="rounded border border-amber-300/60 bg-amber-50 px-2 py-1.5 text-[10px] leading-snug text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
                <b>No picks from this board.</b> {data.verdictNote}
              </p>
            ) : take.length > 0 ? (
              <div className="flex flex-col gap-1">
                {take.map((r) => (
                  <TakeRow key={r.symbol} r={r} />
                ))}
              </div>
            ) : (
              <p className="rounded border border-dashed border-border px-2 py-1.5 text-center text-[10px] text-muted-foreground">
                Nothing clears every gate right now.
                {building.length > 0 ? ' Closest candidates below.' : ' No name on TF’s board is still accumulating.'}
              </p>
            )}

            {/* ② BUILDING — one gate away, so worth watching. */}
            {building.length > 0 && (
              <div>
                <p className="mb-0.5 text-[9px] font-semibold tracking-wide text-muted-foreground uppercase">
                  Building · one gate away ({building.length})
                </p>
                <div className="flex flex-col gap-1">
                  {building.map((r) => (
                    <BoardRow key={r.symbol} r={r} />
                  ))}
                </div>
              </div>
            )}

            {/* ③ STALLED — collapsed. Present, but not competing for attention. */}
            {stalled.length > 0 && (
              <div>
                <button
                  onClick={() => setShowAll((v) => !v)}
                  className="flex w-full items-center gap-1 text-left text-[9px] font-semibold tracking-wide text-muted-foreground uppercase hover:text-foreground"
                  title="TradeFinder still ranks these highly, but their R-Factor has stopped advancing — the money is already in and none is arriving. Shown for completeness, not as candidates."
                >
                  {showAll ? <ChevronDown className="h-2.5 w-2.5" /> : <ChevronRight className="h-2.5 w-2.5" />}
                  Stalled · R-Factor not advancing ({stalled.length})
                </button>
                {showAll ? (
                  <div className="mt-1 flex flex-col gap-1">
                    {stalled.map((r) => (
                      <BoardRow key={r.symbol} r={r} />
                    ))}
                  </div>
                ) : (
                  <p className="truncate text-[9px] text-muted-foreground/70">
                    {stalled.map((r) => `${r.symbol} ${r.rFactor.toFixed(1)}`).join(' · ')}
                  </p>
                )}
              </div>
            )}
          </div>
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
