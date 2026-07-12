/**
 * Auth gate + RBAC — Next 16 proxy convention, wrapped with Auth.js `auth()`
 * per the official pattern (authjs.dev) so `req.auth` carries the Google
 * session inside our existing gate.
 *
 * Three ways to authenticate, all mapping to a role (catalog in lib/auth/rbac.ts):
 *   1. Session cookie (browsers) — set by /api/auth/login after the /login page
 *      posts the password; cleared by /api/auth/logout. Signed (lib/auth/session).
 *   2. Google sign-in (browsers) — Auth.js session JWT (auth.ts); only emails
 *      on ADMIN_GOOGLE_EMAILS ever get a session, and they resolve to admin.
 *   3. HTTP Basic Auth (non-browser clients only: the internal server-to-self
 *      calls in engine.ts / poller.ts, curl). Ignored when the request carries
 *      Sec-Fetch-Mode (i.e. comes from a browser) — see roleFromBasicAuth.
 *
 * Roles:
 *   APP_PASSWORD           → admin  (full access)
 *   ADMIN_GOOGLE_EMAILS    → admin  (via Google)
 *   any other Google login → viewer (read-only)
 *   APP_READONLY_PASSWORD  → viewer (every page + read API; actions 403)
 *
 * Active ONLY when APP_PASSWORD is set. Unset (local dev) → no-op, every request
 * runs as admin, `pnpm dev` stays password-free and never sees /login.
 *
 * The resolved role is stamped on the forwarded request as `x-app-role` AFTER
 * stripping any client-supplied value, so route handlers can trust it
 * (lib/auth/server.ts). Unauthenticated browser navigations are redirected to
 * /login (with ?next=); unauthenticated API calls get 401 JSON.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { requiredPermission, resolveRole, roleForGoogleEmail, ROLE_HEADER, roleHas, type Role } from '@/lib/auth/rbac';
import { SESSION_COOKIE, verifySession } from '@/lib/auth/session';

/** Forward the request with the TRUSTED role header (spoof-proof: always overwritten). */
function forwardAs(req: NextRequest, role: Role): NextResponse {
  const headers = new Headers(req.headers);
  headers.set(ROLE_HEADER, role);
  return NextResponse.next({ request: { headers } });
}

/** A top-level page navigation (as opposed to a fetch/XHR/API call). */
function isBrowserNavigation(req: NextRequest): boolean {
  return req.method === 'GET' && (req.headers.get('accept') ?? '').includes('text/html');
}

/**
 * Basic Auth is for NON-browser clients only (the engine/poller's internal
 * server-to-self fetches, curl). Browsers must use the session cookie:
 * they cache Basic credentials for the whole browser session and re-send them
 * on every request, which would silently re-authenticate a user who just
 * signed out (the /login redirect would bounce straight back in). All modern
 * browsers send `Sec-Fetch-Mode` on every request; Node fetch and curl don't —
 * so its presence identifies a browser and disables the Basic path.
 */
function roleFromBasicAuth(req: NextRequest, adminPassword: string): Role | null {
  if (req.headers.has('sec-fetch-mode')) return null; // browser → cookie only
  const header = req.headers.get('authorization');
  if (!header?.startsWith('Basic ')) return null;
  let decoded = '';
  try {
    decoded = atob(header.slice(6));
  } catch {
    return null;
  }
  if (!decoded.includes(':')) return null;
  const supplied = decoded.slice(decoded.indexOf(':') + 1);
  return resolveRole(supplied, adminPassword, process.env.APP_READONLY_PASSWORD);
}

export const proxy = auth(async (req) => {
  const { pathname, searchParams } = req.nextUrl;

  // Health check stays public (Railway keep-alive pinger) — strip any spoofed role.
  if (pathname === '/api/health') {
    const headers = new Headers(req.headers);
    headers.delete(ROLE_HEADER);
    return NextResponse.next({ request: { headers } });
  }

  const adminPassword = process.env.APP_PASSWORD;
  // Gate disabled (local dev / opt-out) — everyone is admin, no login needed.
  if (!adminPassword) return forwardAs(req, 'admin');

  // Login/logout and the Auth.js endpoints (signin, callback/google, csrf,
  // session, …) authenticate themselves — always reachable.
  if (
    pathname === '/api/auth/login' ||
    pathname === '/api/auth/logout' ||
    pathname.startsWith('/api/auth/signin') ||
    pathname.startsWith('/api/auth/callback') ||
    pathname === '/api/auth/csrf' ||
    pathname === '/api/auth/session' ||
    pathname === '/api/auth/providers' ||
    pathname === '/api/auth/error' ||
    pathname === '/api/auth/signout'
  ) {
    return NextResponse.next();
  }

  // Google session → role via the central policy (lib/auth/rbac.ts):
  // the operator's email → admin, any other signed-in Google account → viewer.
  const googleRole: Role | null = roleForGoogleEmail(req.auth?.user?.email);

  // Resolve the caller's role: password cookie, then Google session, then Basic Auth.
  const role =
    (await verifySession(req.cookies.get(SESSION_COOKIE)?.value, adminPassword)) ??
    googleRole ??
    roleFromBasicAuth(req, adminPassword);

  // The login page: reachable when signed out; bounce to home when already in.
  if (pathname === '/login') {
    if (role) return NextResponse.redirect(new URL(searchParams.get('next') || '/', req.url));
    const headers = new Headers(req.headers);
    headers.delete(ROLE_HEADER);
    return NextResponse.next({ request: { headers } });
  }

  if (!role) {
    if (isBrowserNavigation(req)) {
      const loginUrl = new URL('/login', req.url);
      loginUrl.searchParams.set('next', pathname + req.nextUrl.search);
      return NextResponse.redirect(loginUrl);
    }
    return NextResponse.json({ success: false, error: 'Authentication required.' }, { status: 401 });
  }

  const permission = requiredPermission(req.method, pathname, searchParams);
  if (permission && !roleHas(role, permission)) {
    return NextResponse.json(
      {
        success: false,
        error: 'Read-only access — this action needs the operator (admin) login.',
        role,
        requiredPermission: permission,
      },
      { status: 403 },
    );
  }

  return forwardAs(req, role);
});

/**
 * Run on everything except Next's static assets and the favicon, so those don't
 * trip auth. Once authenticated, the browser attaches the session cookie to all
 * same-origin requests (pages, API routes, SSE) automatically.
 */
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt).*)'],
};
