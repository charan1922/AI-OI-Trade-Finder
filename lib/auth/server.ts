/**
 * Server-side role helpers for route handlers.
 *
 * The proxy (proxy.ts) resolves the caller's role and stamps it on the
 * forwarded request as `x-app-role`, ALWAYS overwriting anything the client
 * sent — so reading the header here is trustworthy. A missing header means the
 * proxy ran with the gate off (no APP_PASSWORD — local dev), which is admin by
 * definition; a spoofed header can never reach a route un-overwritten.
 *
 * Most routes never need this: the proxy already 403s viewers per the policy
 * in lib/auth/rbac.ts. Use these only for MIXED endpoints where one route
 * serves both read and write actions decided by the request body (currently
 * /api/backtest/tf-validate) — the proxy can't see bodies.
 */
import { NextResponse } from 'next/server';
import { ROLE_HEADER, type Role } from './rbac';

export function roleFromRequest(req: Request): Role {
  if (!process.env.APP_PASSWORD) return 'admin';
  return req.headers.get(ROLE_HEADER) === 'admin' ? 'admin' : 'viewer';
}

export function isReadOnlyRequest(req: Request): boolean {
  return roleFromRequest(req) === 'viewer';
}

/** The standard 403 body for a viewer hitting a write action inside a mixed route. */
export function readOnlyForbidden(action?: string): NextResponse {
  return NextResponse.json(
    {
      success: false,
      error: `Read-only access — ${action ? `'${action}'` : 'this action'} needs the operator (admin) login.`,
      role: 'viewer',
    },
    { status: 403 }
  );
}

/** Defence in depth for sensitive route handlers. Proxy remains the first
 * layer, but close-to-data checks prevent an accidental policy regression. */
export function adminOnly(req: Request): NextResponse | null {
  if (!process.env.APP_PASSWORD) return null;
  return req.headers.get(ROLE_HEADER) === 'admin' ? null : readOnlyForbidden('this endpoint');
}
