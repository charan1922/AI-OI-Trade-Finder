/**
 * One-password gate (HTTP Basic Auth) — Next 16 proxy convention.
 *
 * A single shared password protects the whole app — every page and API route —
 * so the deployed instance isn't an open door to live broker data and the sync
 * controls. It's intentionally minimal: one env var, no login page, no user db.
 *
 * Enforced ONLY when APP_PASSWORD is set. Unset (e.g. local dev) → the gate is a
 * no-op, so `pnpm dev` on your machine stays password-free. Set APP_PASSWORD as
 * a Railway service variable to turn it on in production.
 *
 * The browser's native Basic-Auth prompt collects the password (any username is
 * accepted — only the password is checked). Uses atob (available on both the
 * Edge and Node runtimes) so it works regardless of how Next runs the proxy.
 */
import { type NextRequest, NextResponse } from 'next/server';

export function proxy(req: NextRequest): NextResponse {
  // Health check stays public so the market-hours keep-alive pinger can wake the
  // app (Railway Serverless) without a password. It leaks nothing sensitive.
  if (req.nextUrl.pathname === '/api/health') return NextResponse.next();

  const password = process.env.APP_PASSWORD;
  // Gate disabled when no password is configured (local dev, or opt-out).
  if (!password) return NextResponse.next();

  const header = req.headers.get('authorization');
  if (header?.startsWith('Basic ')) {
    let decoded = '';
    try {
      decoded = atob(header.slice(6));
    } catch {
      decoded = '';
    }
    // Format is "username:password" — only the password is checked.
    const supplied = decoded.slice(decoded.indexOf(':') + 1);
    if (decoded.includes(':') && supplied === password) {
      return NextResponse.next();
    }
  }

  return new NextResponse('Authentication required.', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Project-R Simulator", charset="UTF-8"' },
  });
}

/**
 * Run on everything except Next's static assets and the favicon, so those don't
 * trip the prompt. Once authenticated, the browser attaches the credentials to
 * all same-origin requests (pages, API routes, SSE) automatically.
 */
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt).*)'],
};
