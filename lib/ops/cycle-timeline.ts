/**
 * Cycle timeline — per-5-min-cycle timing of the autonomous capture chain
 * (wait for candles → scan → guard/reconcile → AI decision → commentary), so
 * the operator can see what each pass did, when each step started/ended, and
 * which step is slow when a cycle misbehaves.
 *
 * One row per capture in `cycle_timelines` (raw CREATE TABLE IF NOT EXISTS per
 * the repo's derived-table convention). Steps are a JSON array — the shape is
 * display-only, so additive changes never need a migration. When the cycle
 * stored a commentary row, `commentaryId` links the timeline to it and the
 * /trade-commentary page renders the timing alongside that read; cycles that
 * produced no read (guard-only, AI failed, overlap-skips) still get a row so
 * anomalies are visible, not silently absent.
 *
 * The recorder is best-effort by design: it never throws into the trading
 * path, and a persistence failure only costs the timing row.
 */
import { prisma } from '@/lib/db';

const TAG = '[CycleTimeline]';
/** Newest rows kept (~75 cycles/trading day → roughly a month of history). */
const KEEP_ROWS = 2000;

let tableReady = false;

async function ensureTable(): Promise<void> {
  if (tableReady) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS cycle_timelines (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      date         TEXT    NOT NULL,
      source       TEXT    NOT NULL,
      status       TEXT,
      startedAt    TEXT    NOT NULL,
      finishedAt   TEXT,
      totalMs      INTEGER,
      commentaryId INTEGER,
      stepsJson    TEXT    NOT NULL DEFAULT '[]',
      createdAt    TEXT    NOT NULL
    )
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_cycle_timelines_date ON cycle_timelines (date, id)`);
  tableReady = true;
}

/** One timed action inside a cycle. */
export interface CycleStep {
  name: string;
  startedAt: string; // ISO
  endedAt: string; // ISO
  ms: number;
  ok: boolean;
  /** Compact context: counts, model/tool breakdowns, or the error message. */
  detail?: string;
}

export interface CycleTimelineRow {
  id: number;
  date: string;
  trigger: string;
  status: string | null;
  startedAt: string;
  finishedAt: string | null;
  totalMs: number | null;
  commentaryId: number | null;
  steps: CycleStep[];
}

export class CycleTimelineRecorder {
  private steps: CycleStep[] = [];
  private commentaryId: number | null = null;
  private status: string | null = null;
  private finished = false;

  constructor(
    private readonly date: string,
    private readonly trigger: string,
    private readonly startedMs: number
  ) {}

  /** Record a span measured elsewhere (e.g. tick → capture release). */
  addSpan(name: string, startedMs: number, endedMs: number, ok = true, detail?: string): void {
    this.steps.push({
      name,
      startedAt: new Date(startedMs).toISOString(),
      endedAt: new Date(endedMs).toISOString(),
      ms: Math.max(0, endedMs - startedMs),
      ok,
      ...(detail ? { detail: detail.slice(0, 500) } : {}),
    });
  }

  /** Time an async action. Rethrows the action's error after recording it, so
   *  caller error handling is unchanged. `detail` summarizes the result. */
  async step<T>(name: string, fn: () => Promise<T>, detail?: (result: T) => string | undefined): Promise<T> {
    const t0 = Date.now();
    try {
      const result = await fn();
      this.addSpan(name, t0, Date.now(), true, detail?.(result));
      return result;
    } catch (err) {
      this.addSpan(name, t0, Date.now(), false, (err as Error).message);
      throw err;
    }
  }

  /** Link this cycle to the trade_commentary row it stored. */
  setCommentaryId(id: number): void {
    this.commentaryId = id;
  }

  setStatus(status: string): void {
    this.status = status;
  }

  /** Persist the row. Idempotent; never throws (timing must not break trading). */
  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    try {
      await ensureTable();
      const now = Date.now();
      await prisma.$executeRawUnsafe(
        `INSERT INTO cycle_timelines (date, source, status, startedAt, finishedAt, totalMs, commentaryId, stepsJson, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        this.date,
        this.trigger,
        this.status,
        new Date(this.startedMs).toISOString(),
        new Date(now).toISOString(),
        now - this.startedMs,
        this.commentaryId,
        JSON.stringify(this.steps),
        new Date(now).toISOString()
      );
      // Bounded retention — cheap on the PK, keeps the table from growing forever.
      await prisma.$executeRawUnsafe(
        `DELETE FROM cycle_timelines WHERE id <= (
           SELECT id FROM cycle_timelines ORDER BY id DESC LIMIT 1 OFFSET ?
         )`,
        KEEP_ROWS
      );
    } catch (err) {
      console.warn(`${TAG} persist failed (timing lost, trading unaffected): ${(err as Error).message}`);
    }
  }
}

export function startCycleTimeline(date: string, trigger: string, startedMs: number): CycleTimelineRecorder {
  return new CycleTimelineRecorder(date, trigger, startedMs);
}

interface RawRow {
  id: number;
  date: string;
  source: string;
  status: string | null;
  startedAt: string;
  finishedAt: string | null;
  totalMs: number | null;
  commentaryId: number | null;
  stepsJson: string;
}

/** Timelines for one date, newest first — the /trade-commentary sidebar data. */
export async function getCycleTimelines(date: string, limit = 100): Promise<CycleTimelineRow[]> {
  await ensureTable();
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT * FROM cycle_timelines WHERE date = ? ORDER BY id DESC LIMIT ?`,
    date,
    Math.min(Math.max(limit, 1), 300)
  )) as RawRow[];
  return rows.map((r) => {
    let steps: CycleStep[] = [];
    try {
      steps = JSON.parse(r.stepsJson) as CycleStep[];
    } catch {
      steps = [];
    }
    return {
      id: Number(r.id),
      date: r.date,
      trigger: r.source,
      status: r.status,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      totalMs: r.totalMs == null ? null : Number(r.totalMs),
      commentaryId: r.commentaryId == null ? null : Number(r.commentaryId),
      steps,
    };
  });
}
