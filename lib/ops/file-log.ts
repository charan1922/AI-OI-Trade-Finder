/**
 * File tee for the server console — every console.log/info/warn/error line is
 * ALSO appended to data/logs/app-<IST date>.log, so the raw `pnpm dev`-style
 * output survives container restarts/redeploys (docker discards a replaced
 * container's logs — the 2026-07-17 09:45 missing-read question was
 * unanswerable because of exactly that). The /logs page tails these files.
 *
 * Deliberately dumb and safe:
 *  - console still prints normally (original methods called first);
 *  - file writes are fire-and-forget appends — a disk hiccup can never break
 *    a trading code path;
 *  - NEVER touches the database;
 *  - one file per IST day, files older than KEEP_DAYS pruned on rollover.
 */

import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { format } from 'node:util';

const LOG_DIR = path.join(process.cwd(), 'data', 'logs');
const KEEP_DAYS = 7;

const g = globalThis as unknown as { __fileLogInstalled?: boolean; __fileLogDate?: string };

function istNow(): Date {
  return new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60_000);
}
function istDate(): string {
  return istNow().toISOString().slice(0, 10);
}
function istTime(): string {
  return istNow().toISOString().slice(11, 19);
}

export function logFilePath(date: string): string {
  return path.join(LOG_DIR, `app-${date}.log`);
}

async function pruneOldLogs(): Promise<void> {
  try {
    const cutoff = new Date(istNow().getTime() - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
    for (const f of await readdir(LOG_DIR)) {
      const m = f.match(/^app-(\d{4}-\d{2}-\d{2})\.log$/);
      if (m && m[1] < cutoff) await unlink(path.join(LOG_DIR, f)).catch(() => {});
    }
  } catch {
    // best-effort
  }
}

/** Install the tee once per process (idempotent — safe under HMR). */
export function startFileLog(): void {
  if (g.__fileLogInstalled) return;
  g.__fileLogInstalled = true;
  g.__fileLogDate = istDate();
  void mkdir(LOG_DIR, { recursive: true }).then(pruneOldLogs);

  const write = (level: string, args: unknown[]): void => {
    try {
      const date = istDate();
      if (date !== g.__fileLogDate) {
        g.__fileLogDate = date;
        void pruneOldLogs();
      }
      const line = `${istTime()} ${level} ${format(...args)}\n`;
      void appendFile(logFilePath(date), line).catch(() => {});
    } catch {
      // formatting/appending must never throw into the app
    }
  };

  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      write(level.toUpperCase().padEnd(5), args);
    };
  }
  console.log('[FileLog] console tee → data/logs/app-<date>.log (kept', KEEP_DAYS, 'days)');
}
