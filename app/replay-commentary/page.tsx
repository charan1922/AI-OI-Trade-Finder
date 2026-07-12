'use client';

/**
 * TEMP BENCH PAGE — commentary replay viewer.
 * Shows the threads produced by scripts/replay-commentary.ts (real MiMo over a
 * recorded session) with per-read contract badges, the verdict stream, and the
 * outcome of following the calls literally. Not part of the product surface —
 * this exists so replay iterations can be eyeballed before anything ships to
 * the deployed /trade-commentary loop.
 */

import { useEffect, useState } from 'react';

interface RunSummary {
  runName: string;
  date: string;
  label: string;
  createdAt: string;
  dry: boolean;
  metrics: Metrics;
}
interface Metrics {
  reads: number;
  structureFails: number;
  warns: number;
  groundingSuspects: number;
  tradeNowCalls: number;
  trades: number;
  wins: number;
  totalPoints: number;
  totalR: number;
  orphanSquareOffs: number;
  avgWords: number;
  avgLatencySec: number;
}
interface TradeRow {
  ticker: string;
  direction: string;
  entryTime: string;
  entryPx: number;
  exitTime: string;
  exitPx: number;
  exitReason: string;
  points: number;
  rMultiple: number | null;
}
interface ReadRow {
  timeIST: string;
  windowActive: boolean;
  scanned: number;
  picks: { symbol: string; direction: string; entrySpot: number; slSpot: number | null; targetSpot: number | null; tfGrade: string | null }[];
  text: string;
  latencyMs: number;
  fails: string[];
  warns: string[];
  suspects: number[];
  verdicts: { ticker: string; verdict: string; slLevel: number | null }[];
}
interface RunFull extends RunSummary {
  config: Record<string, unknown>;
  metrics: Metrics;
  trades: TradeRow[];
  reads: ReadRow[];
}

/** Minimal markdown-ish rendering: ### headings, bold, bullets. */
function Rich({ text }: { text: string }) {
  return (
    <div className="space-y-1 text-xs leading-relaxed">
      {text.split('\n').map((line, i) => {
        const key = `${i}-${line.slice(0, 12)}`;
        if (/^###\s/.test(line)) {
          return (
            <div key={key} className="mt-2 border-t border-border pt-2 text-[13px] font-bold text-foreground">
              {line.replace(/^###\s*/, '').replace(/\*\*/g, '')}
            </div>
          );
        }
        const html = line
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
          .replace(/^\s*[•*-]\s+/, '• ');
        // biome-ignore lint/security/noDangerouslySetInnerHtml: bench-only page, own script's output
        return <div key={key} dangerouslySetInnerHTML={{ __html: html }} />;
      })}
    </div>
  );
}

const VERDICT_CLS: Record<string, string> = {
  'TRADE NOW': 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-300',
  HOLD: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  'MOVE SL': 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  'EXIT NOW': 'bg-red-500/15 text-red-700 dark:text-red-300',
  WATCH: 'bg-slate-500/10 text-slate-600 dark:text-slate-400',
  OTHER: 'bg-muted text-muted-foreground',
};

export default function ReplayCommentaryPage() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [run, setRun] = useState<RunFull | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await fetch('/api/replay-commentary', { cache: 'no-store' });
        const j = await r.json();
        if (!alive) return;
        if (j.success) {
          setRuns(j.runs);
          setSelected((cur) => cur ?? (j.runs[0]?.runName as string | undefined) ?? null);
        } else setError(j.error ?? 'failed');
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!selected) return;
    void (async () => {
      const r = await fetch(`/api/replay-commentary?run=${encodeURIComponent(selected)}`, { cache: 'no-store' });
      const j = await r.json();
      if (j.success) setRun(j.run);
      else setError(j.error ?? 'failed');
    })();
  }, [selected]);

  const m = run?.metrics;
  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4">
      <div className="rounded-lg border border-amber-400 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
        TEMP BENCH — replayed commentary over a recorded session (real MiMo, real recorded data, nothing stored to the
        live page). Produced by <code>scripts/replay-commentary.ts</code>; experiment ledger in{' '}
        <code>tracking/commentary-replay-log.md</code>.
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-bold">Commentary Replay</h1>
        <select
          className="ml-auto rounded-md border border-border bg-card px-2 py-1 text-xs"
          value={selected ?? ''}
          onChange={(e) => setSelected(e.target.value)}
        >
          {runs.map((r) => (
            <option key={r.runName} value={r.runName}>
              {r.runName}
              {r.dry ? ' (dry)' : ''}
            </option>
          ))}
        </select>
      </div>

      {error && <div className="text-xs text-red-500">{error}</div>}
      {runs.length === 0 && !error && <div className="text-xs text-muted-foreground">No runs yet — run scripts/replay-commentary.ts first.</div>}

      {run && m && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              ['Reads', String(m.reads)],
              ['Structure fails', String(m.structureFails)],
              ['Ungrounded #s', String(m.groundingSuspects)],
              ['TRADE NOW calls', String(m.tradeNowCalls)],
              ['Trades (wins)', `${m.trades} (${m.wins}W)`],
              ['Outcome', `${m.totalPoints >= 0 ? '+' : ''}${m.totalPoints} pts / ${m.totalR}R`],
              ['Orphan square-offs', String(m.orphanSquareOffs)],
              ['Avg words / latency', `${m.avgWords}w · ${m.avgLatencySec}s`],
            ].map(([k, v]) => (
              <div key={k} className="rounded-lg border border-border bg-card px-3 py-2">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{k}</div>
                <div className="text-sm font-bold tabular-nums">{v}</div>
              </div>
            ))}
          </div>

          {run.trades.length > 0 && (
            <div className="rounded-lg border border-border bg-card p-3">
              <div className="mb-1 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                Following the calls literally (spot points, real bars)
              </div>
              {run.trades.map((t) => (
                <div key={`${t.ticker}-${t.entryTime}`} className="flex flex-wrap gap-x-2 text-xs tabular-nums">
                  <b>{t.ticker}</b>
                  <span>{t.direction}</span>
                  <span>
                    {t.entryTime} @ {t.entryPx} → {t.exitTime} @ {t.exitPx}
                  </span>
                  <span className="text-muted-foreground">({t.exitReason})</span>
                  <span className={t.points >= 0 ? 'font-semibold text-emerald-600 dark:text-emerald-400' : 'font-semibold text-red-600 dark:text-red-400'}>
                    {t.points >= 0 ? '+' : ''}
                    {t.points} pts{t.rMultiple != null ? ` (${t.rMultiple}R)` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="space-y-3">
            {run.reads.map((r) => (
              <div key={r.timeIST} className="rounded-xl border border-border bg-card p-3">
                <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                  <b className="text-[13px] tabular-nums">{r.timeIST} IST</b>
                  <span className={`rounded px-1.5 py-0.5 ${r.windowActive ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : 'bg-muted text-muted-foreground'}`}>
                    {r.windowActive ? 'in window' : 'out of window'}
                  </span>
                  <span className="text-muted-foreground">scanned {r.scanned}</span>
                  {r.verdicts.map((v) => (
                    <span key={`${v.ticker}-${v.verdict}`} className={`rounded px-1.5 py-0.5 font-semibold ${VERDICT_CLS[v.verdict] ?? VERDICT_CLS.OTHER}`}>
                      {v.ticker} {v.verdict}
                      {v.slLevel != null ? ` ${v.slLevel}` : ''}
                    </span>
                  ))}
                  <span className={`ml-auto rounded px-1.5 py-0.5 ${r.fails.length ? 'bg-red-500/15 font-semibold text-red-700 dark:text-red-300' : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'}`}>
                    {r.fails.length ? `✗ ${r.fails.length} contract fail` : '✓ contract'}
                  </span>
                </div>
                {(r.fails.length > 0 || r.warns.length > 0 || r.suspects.length > 0) && (
                  <div className="mb-2 space-y-0.5 text-[10px]">
                    {r.fails.map((f) => (
                      <div key={f} className="text-red-600 dark:text-red-400">
                        ✗ {f}
                      </div>
                    ))}
                    {r.warns.map((w) => (
                      <div key={w} className="text-amber-600 dark:text-amber-400">
                        ⚠ {w}
                      </div>
                    ))}
                    {r.suspects.length > 0 && (
                      <div className="text-amber-600 dark:text-amber-400">⚠ ungrounded numbers: {r.suspects.join(', ')}</div>
                    )}
                  </div>
                )}
                <Rich text={r.text || '(dry run — no narration)'} />
                <div className="mt-2 text-[10px] text-muted-foreground">
                  picks: {r.picks.map((p) => `${p.symbol} ${p.direction}${p.tfGrade ? ` [${p.tfGrade}]` : ''}`).join(' · ') || 'none'} ·{' '}
                  {(r.latencyMs / 1000).toFixed(0)}s
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
