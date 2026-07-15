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
  const { startFyersPoller } = await import('./lib/fyers/poller');
  startFyersPoller();
  const { startGuardLoop } = await import('./lib/auto-trade/guard-loop');
  startGuardLoop();
}
