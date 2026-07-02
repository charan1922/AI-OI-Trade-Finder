/**
 * Next.js server-boot hook (stable since Next 15; runs once per server start,
 * dev and prod). Starts the Fyers 5-min F&O downloader so live data records
 * while the server is up, without any page needing to stay open.
 */
export async function register(): Promise<void> {
  // instrumentation is also evaluated for the edge runtime — a static import
  // would drag better-sqlite3/otpauth into that bundle.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { startFyersPoller } = await import('./lib/fyers/poller');
  startFyersPoller();
}
