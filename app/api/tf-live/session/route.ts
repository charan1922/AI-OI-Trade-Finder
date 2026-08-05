import { NextResponse } from 'next/server';

import { adminOnly } from '@/lib/auth/server';
import {
  assertTfLiveSessionKeyConfigured,
  getTfLiveSessionStatus,
  saveTfLiveCookie,
  validateTfLiveCookie,
} from '@/lib/tf-live/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Safe operational status. It intentionally never returns the stored cookie or user profile. */
export async function GET(req: Request) {
  const denied = adminOnly(req);
  if (denied) return denied;
  try {
    return NextResponse.json({ success: true, session: await getTfLiveSessionStatus() });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}

/**
 * Accept a freshly copied TradeFinder Cookie header after the operator completes
 * the daily Google sign-in. The value is validated and encrypted before storage;
 * it is never logged or returned.
 */
export async function POST(req: Request) {
  const denied = adminOnly(req);
  if (denied) return denied;
  try {
    const body = (await req.json()) as { cookie?: unknown };
    if (typeof body.cookie !== 'string') {
      return NextResponse.json({ success: false, error: 'body must be { cookie: string }' }, { status: 400 });
    }
    // Do this before sending the sensitive value anywhere, including the
    // validation request, so a misconfigured deployment never accepts it.
    assertTfLiveSessionKeyConfigured();
    const check = await validateTfLiveCookie(body.cookie.trim());
    if (!check.valid) {
      return NextResponse.json({ success: false, error: check.error ?? 'TradeFinder session is not valid' }, { status: 401 });
    }
    await saveTfLiveCookie(body.cookie.trim(), check.expiresAt);
    return NextResponse.json({ success: true, expiresAt: check.expiresAt });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 400 });
  }
}
