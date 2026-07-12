import { NextResponse } from 'next/server';
import { ROLE_PERMISSIONS } from '@/lib/auth/rbac';
import { roleFromRequest } from '@/lib/auth/server';
import { USERNAME_COOKIE } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

/** Display-only username from the cookie the login route set (never trusted). */
function usernameFromRequest(req: Request, role: string): string {
  const cookie = req.headers.get('cookie') ?? '';
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${USERNAME_COOKIE}=([^;]*)`));
  if (m) {
    try {
      const v = decodeURIComponent(m[1]).trim();
      if (v) return v;
    } catch {
      /* malformed — fall through to default */
    }
  }
  return role === 'viewer' ? 'Guest' : 'Analyst';
}

/**
 * GET /api/auth/me — who am I, per the proxy's trusted role header.
 * The UI uses this (lib/auth/use-role.ts) to hide/disable action controls for
 * read-only sessions; enforcement itself lives in the proxy, never here.
 */
export async function GET(req: Request) {
  const role = roleFromRequest(req);
  return NextResponse.json({
    success: true,
    role,
    readOnly: role === 'viewer',
    username: usernameFromRequest(req, role),
    // Off (local dev, no APP_PASSWORD) → every request is admin and there's no
    // session to end, so the UI hides the logout button.
    gateEnabled: !!process.env.APP_PASSWORD,
    permissions: [...ROLE_PERMISSIONS[role]],
  });
}
