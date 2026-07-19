/**
 * Next.js server-boot hook (stable since Next 15; runs once per server start,
 * dev and prod). Starts the headless loops so everything trading-critical runs
 * with NO page open: the Fyers 5-min F&O downloader (candles/OI + autonomous
 * capture) and the 60s fast position-guard (stop/target checks between passes).
 */
export async function register(): Promise<void> {
  // instrumentation is also evaluated for the edge runtime — a static import
  // would drag better-sqlite3/otpauth into that bundle.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // File tee FIRST so every startup line below also lands in data/logs/.
  const { startFileLog } = await import('./lib/ops/file-log');
  startFileLog();
  // Production MUST have an auth gate: with APP_PASSWORD unset, proxy.ts would
  // treat every request as admin — the open internet could place orders, dump
  // the DB, and reveal broker tokens. Refuse to boot rather than boot open.
  if (process.env.NODE_ENV === 'production' && !process.env.APP_PASSWORD) {
    const msg = 'FATAL: APP_PASSWORD is not set in production — refusing to boot (every request would run as admin).';
    console.error(msg);
    throw new Error(msg);
  }
  // Seed the NSE holiday calendar from the official CSV BEFORE any trading
  // loop starts — the poller's holiday check fails CLOSED on an empty table,
  // so an unseeded fresh deploy would otherwise skip every cycle (and an
  // unseeded fail-OPEN deploy used to trade straight through holidays).
  try {
    const { syncHolidays } = await import('./lib/backtest/trading-calendar');
    const holidays = await syncHolidays();
    console.log(`[Boot] market_holidays seeded: ${holidays.size} official NSE holidays`);
  } catch (err) {
    console.error(`[Boot] holiday calendar seeding FAILED (trading path will fail closed): ${(err as Error).message}`);
  }
  const { startFyersPoller } = await import('./lib/fyers/poller');
  startFyersPoller();
  const { startGuardLoop } = await import('./lib/auto-trade/guard-loop');
  startGuardLoop();
}
