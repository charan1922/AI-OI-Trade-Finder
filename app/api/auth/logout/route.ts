import { NextResponse } from 'next/server';
import { SESSION_COOKIE, USERNAME_COOKIE } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CLEAR = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: 0,
};

function clearCookies(res: NextResponse): NextResponse {
  res.cookies.set(SESSION_COOKIE, '', CLEAR);
  res.cookies.set(USERNAME_COOKIE, '', CLEAR);
  // Auth.js (Google) session cookies — dev and production (__Secure-) names.
  // Cleared here so ONE sign-out ends BOTH login kinds; without this a Google
  // user would be silently signed back in on their next navigation.
  res.cookies.set('authjs.session-token', '', CLEAR);
  res.cookies.set('__Secure-authjs.session-token', '', { ...CLEAR, secure: true });
  return res;
}

/**
 * GET /api/auth/logout — clear the session cookie AND redirect to /login in the
 * same response. This is what the profile-menu Sign-out link points at: a single
 * browser navigation, so there's no dependency on client fetch timing (the
 * reason a fetch-then-navigate could appear to hang on a busy page like /live).
 * Public — it only removes a cookie.
 *
 * The Location header is RELATIVE on purpose: behind Railway's proxy, req.url
 * shows the internal bind address (0.0.0.0:5001) — building an absolute URL
 * from it sent prod users to https://0.0.0.0:5001/login (seen live
 * 2026-07-12). A relative Location is RFC-legal and every browser resolves it
 * against the address bar's own origin.
 */
export async function GET() {
  const res = new NextResponse(null, { status: 307, headers: { Location: '/login' } });
  return clearCookies(res);
}

/** POST /api/auth/logout — same cookie clear for programmatic callers. */
export async function POST() {
  return clearCookies(NextResponse.json({ success: true }));
}
