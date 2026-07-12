import { NextResponse } from 'next/server';
import { ROLE_PERMISSIONS } from '@/lib/auth/rbac';
import { roleFromRequest } from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

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
    permissions: [...ROLE_PERMISSIONS[role]],
  });
}
