import { NextResponse } from 'next/server';
import { resolveRole } from '@/lib/auth/rbac';
import { SESSION_COOKIE, SESSION_MAX_AGE_SEC, signSession, USERNAME_COOKIE } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/auth/login  { password }
 *
 * Validates the password against APP_PASSWORD (admin) / APP_READONLY_PASSWORD
 * (viewer) and, on success, sets the signed session cookie the proxy reads.
 * Public by design (it IS the authentication step) — the proxy lets it through
 * unauthenticated. When the gate is off (no APP_PASSWORD) every request is
 * already admin, so login is unnecessary and returns success as admin.
 */
export async function POST(req: Request) {
  const adminPassword = process.env.APP_PASSWORD;
  if (!adminPassword) {
    return NextResponse.json({ success: true, role: 'admin', gateEnabled: false });
  }

  const body = (await req.json().catch(() => ({}))) as { password?: unknown; username?: unknown };
  if (typeof body.password !== 'string' || body.password.length === 0) {
    return NextResponse.json({ success: false, error: 'Enter your password.' }, { status: 400 });
  }

  const role = resolveRole(body.password, adminPassword, process.env.APP_READONLY_PASSWORD);
  if (!role) {
    return NextResponse.json({ success: false, error: 'Incorrect password.' }, { status: 401 });
  }

  // Display-only name — never used for auth, just shown in the header. Sanitised
  // to a short safe string; falls back to a role-based default.
  const rawUser = typeof body.username === 'string' ? body.username.trim() : '';
  const username = (rawUser || (role === 'viewer' ? 'Guest' : 'Analyst')).replace(/[^\w .@-]/g, '').slice(0, 32);

  const cookieOpts = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_MAX_AGE_SEC,
  };
  const res = NextResponse.json({ success: true, role, username });
  res.cookies.set(SESSION_COOKIE, await signSession(role, adminPassword), cookieOpts);
  res.cookies.set(USERNAME_COOKIE, encodeURIComponent(username), cookieOpts);
  return res;
}
