import { readdir, readFile } from 'node:fs/promises';
import { NextResponse } from 'next/server';
import { adminOnly } from '@/lib/auth/server';
import { logFilePath } from '@/lib/ops/file-log';
import { todayIST } from '@/lib/dhan/market-feed';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_LINES = 2000;

/**
 * GET /api/logs[?date=YYYY-MM-DD&lines=N&dates=true] — tail of the raw server
 * console log (the same lines `pnpm dev` / `docker logs` shows), teed to
 * data/logs/app-<date>.log by lib/ops/file-log.ts so it survives redeploys.
 * Read-only file reads; never touches the database. Admin-only.
 */
export async function GET(req: Request) {
  const denied = adminOnly(req);
  if (denied) return denied;
  try {
    const url = new URL(req.url);
    if (url.searchParams.get('dates') === 'true') {
      let dates: string[] = [];
      try {
        const files = await readdir(logFilePath('x').replace(/app-x\.log$/, ''));
        dates = files
          .map((f) => f.match(/^app-(\d{4}-\d{2}-\d{2})\.log$/)?.[1])
          .filter((d): d is string => Boolean(d))
          .sort()
          .reverse();
      } catch {
        // no log dir yet
      }
      return NextResponse.json({ success: true, dates });
    }

    const date = url.searchParams.get('date') ?? todayIST();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ success: false, error: 'bad date' }, { status: 400 });
    }
    const linesParam = Number(url.searchParams.get('lines'));
    const lines = Number.isFinite(linesParam) && linesParam > 0 ? Math.min(linesParam, MAX_LINES) : 300;

    let text = '';
    try {
      text = await readFile(logFilePath(date), 'utf8');
    } catch {
      // file absent (no logs that day / feature just deployed) — empty tail
    }
    const all = text.length ? text.split('\n') : [];
    const tail = all.slice(Math.max(0, all.length - 1 - lines), -1); // drop trailing ''
    return NextResponse.json({ success: true, date, totalLines: Math.max(0, all.length - 1), lines: tail });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
