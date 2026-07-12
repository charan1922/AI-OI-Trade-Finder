import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { ROLE_PERMISSIONS } from '@/lib/auth/rbac';
import { roleFromRequest } from '@/lib/auth/server';
import { USERNAME_COOKIE } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

/** Display-only username: the password-login cookie first, else the Google
 *  session's name (Auth.js), else a role-based default. Never trusted. */
async function usernameFromRequest(req: Request, role: string): Promise<string> {
  const cookie = req.headers.get('cookie') ?? '';
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${USERNAME_COOKIE}=([^;]*)`));
  if (m) {
    try {
      const v = decodeURIComponent(m[1]).trim();
      if (v) return v;
    } catch {
      /* malformed — fall through */
    }
  }
  try {
    const session = await auth();
    const name = session?.user?.name?.trim() || session?.user?.email?.trim();
    if (name) return name.slice(0, 32);
  } catch {
    /* no Auth.js session — fall through to default */
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
    username: await usernameFromRequest(req, role),
    // Off (local dev, no APP_PASSWORD) → every request is admin and there's no
    // session to end, so the UI hides the logout button.
    gateEnabled: !!process.env.APP_PASSWORD,
    permissions: [...ROLE_PERMISSIONS[role]],
  });
}
