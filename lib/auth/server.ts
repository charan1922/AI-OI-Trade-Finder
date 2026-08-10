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
import { OWNER_HEADER, ROLE_HEADER, type Role } from './rbac';

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

/** True when the proxy identified the caller as the owner (OWNER_HEADER is
 *  stamped or stripped by the proxy, never client-supplied). */
export function isOwnerRequest(req: Request): boolean {
  if (!process.env.APP_PASSWORD) return true; // local dev, gate off
  return req.headers.get(OWNER_HEADER) === '1';
}

/**
 * Defence in depth for the access-management endpoints. The proxy already
 * blocks non-owners via OWNER_ONLY_API_PREFIXES; this is the close-to-data
 * check so a policy-list regression can't quietly open user management up.
 */
export function ownerOnly(req: Request): NextResponse | null {
  if (isOwnerRequest(req)) return null;
  return NextResponse.json(
    { success: false, error: 'Owner-only — only the account owner can manage user access.' },
    { status: 403 }
  );
}
