/**
 * Public health check — the ONLY unauthenticated route (allowlisted in
 * proxy.ts). Two jobs:
 *   1. A wake target for the market-hours keep-alive pinger
 *      (.github/workflows/keep-awake.yml) when Railway "Serverless" app-sleeping
 *      is enabled — hitting it wakes the container so the Fyers poller records.
 *   2. A cheap liveness probe (no DB, no external calls).
 * Intentionally leaks nothing sensitive.
 */
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json({ ok: true, ts: new Date().toISOString() });
}
