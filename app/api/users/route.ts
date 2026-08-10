/**
 * /api/users — access management. OWNER-ONLY (user rule 2026-08-10: only the
 * main account may hand out access; a plain admin trades but cannot).
 *
 * Enforcement is layered: proxy.ts blocks non-owners via
 * OWNER_ONLY_API_PREFIXES before this file runs, and ownerOnly() below is the
 * close-to-data second check.
 *
 * Writes land in app_users and immediately re-hydrate the in-memory role
 * registry that rbac.ts reads (see lib/auth/users.ts), so a grant takes effect
 * on the user's next request — no redeploy, no restart.
 */
import { NextResponse } from 'next/server';
import { ownerOnly } from '@/lib/auth/server';
import { ADMIN_GOOGLE_EMAILS, OWNER_GOOGLE_EMAILS, type Role } from '@/lib/auth/rbac';
import { listUsers, removeUser, setUserRole } from '@/lib/auth/users';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/users — every registered account plus the hardcoded operators. */
export async function GET(req: Request) {
  const denied = ownerOnly(req);
  if (denied) return denied;
  try {
    const users = await listUsers();
    return NextResponse.json({
      success: true,
      users,
      // Shown as locked rows on /users: these live in code, not the DB, and are
      // checked BEFORE the registry — the screen must not imply otherwise.
      owners: [...OWNER_GOOGLE_EMAILS],
      codeAdmins: [...ADMIN_GOOGLE_EMAILS].filter((e) => !OWNER_GOOGLE_EMAILS.has(e)),
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}

/**
 * POST /api/users
 *   { action: 'set-role', email, role: 'admin' | 'viewer' }  → grant / change
 *   { action: 'remove',   email }                            → revoke access
 */
export async function POST(req: Request) {
  const denied = ownerOnly(req);
  if (denied) return denied;
  try {
    const body = (await req.json()) as { action?: string; email?: string; role?: string };
    const email = typeof body.email === 'string' ? body.email : '';
    if (!email.trim()) return NextResponse.json({ success: false, error: 'email is required' }, { status: 400 });

    if (body.action === 'set-role') {
      if (body.role !== 'admin' && body.role !== 'viewer') {
        return NextResponse.json({ success: false, error: "role must be 'admin' or 'viewer'" }, { status: 400 });
      }
      const saved = await setUserRole(email, body.role as Role);
      return NextResponse.json({ success: true, email: saved, role: body.role });
    }

    if (body.action === 'remove') {
      const { email: removed, wasCodeAdmin } = await removeUser(email);
      return NextResponse.json({
        success: true,
        email: removed,
        // The revoke tombstone DOES override the code list, but say so plainly —
        // the code entry is still there and would apply again if the tombstone
        // were ever cleared straight out of the database.
        warning: wasCodeAdmin
          ? `${removed} is revoked and can no longer sign in. Note they are still listed in ADMIN_GOOGLE_EMAILS in code — the revoke overrides it, but remove the code entry too if this is permanent.`
          : undefined,
      });
    }

    return NextResponse.json({ success: false, error: `unknown action '${body.action}'` }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 400 });
  }
}
