/**
 * Password gate + RBAC (HTTP Basic Auth) — Next 16 proxy convention.
 *
 * Two passwords, two roles (policy + role catalog in lib/auth/rbac.ts):
 *   APP_PASSWORD          → admin  (full access — the original operator login)
 *   APP_READONLY_PASSWORD → viewer (every page + every read API; any state-
 *                                   changing / paid / download action → 403)
 *
 * Enforced ONLY when APP_PASSWORD is set. Unset (e.g. local dev) → the gate is
 * a no-op and every request runs as admin, so `pnpm dev` stays password-free.
 * Set both as Railway service variables to enable the split in production;
 * APP_READONLY_PASSWORD alone does nothing (the gate keys off APP_PASSWORD).
 *
 * The browser's native Basic-Auth prompt collects the password (any username
 * is accepted — only the password picks the role). The resolved role is
 * stamped on the forwarded request as `x-app-role` AFTER stripping any
 * client-supplied value, so route handlers can trust the header (see
 * lib/auth/server.ts). Uses atob (Edge + Node runtimes) so it works regardless
 * of how Next runs the proxy.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { requiredPermission, resolveRole, ROLE_HEADER, roleHas, type Role } from '@/lib/auth/rbac';

/** Forward the request with the TRUSTED role header (spoof-proof: always overwritten). */
function forwardAs(req: NextRequest, role: Role): NextResponse {
  const headers = new Headers(req.headers);
  headers.set(ROLE_HEADER, role);
  return NextResponse.next({ request: { headers } });
}

export function proxy(req: NextRequest): NextResponse {
  const { pathname, searchParams } = req.nextUrl;

  // Health check stays public so the market-hours keep-alive pinger can wake
  // the app (Railway Serverless) without a password. It leaks nothing
  // sensitive — but still strip a spoofed role header before forwarding.
  if (pathname === '/api/health') {
    const headers = new Headers(req.headers);
    headers.delete(ROLE_HEADER);
    return NextResponse.next({ request: { headers } });
  }

  const password = process.env.APP_PASSWORD;
  // Gate disabled when no password is configured (local dev, or opt-out).
  if (!password) return forwardAs(req, 'admin');

  const header = req.headers.get('authorization');
  let role: Role | null = null;
  if (header?.startsWith('Basic ')) {
    let decoded = '';
    try {
      decoded = atob(header.slice(6));
    } catch {
      decoded = '';
    }
    // Format is "username:password" — only the password is checked.
    if (decoded.includes(':')) {
      const supplied = decoded.slice(decoded.indexOf(':') + 1);
      role = resolveRole(supplied, password, process.env.APP_READONLY_PASSWORD);
    }
  }

  if (!role) {
    return new NextResponse('Authentication required.', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="Project-R Simulator", charset="UTF-8"' },
    });
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
}

/**
 * Run on everything except Next's static assets and the favicon, so those don't
 * trip the prompt. Once authenticated, the browser attaches the credentials to
 * all same-origin requests (pages, API routes, SSE) automatically.
 */
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt).*)'],
};
