import { NextResponse } from 'next/server';
import { clearFyersToken, getFyersAccessToken, hasFyersAuth } from '@/lib/fyers/auth';
import { adminOnly } from '@/lib/auth/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_CREDS =
  'No Fyers credentials configured. Set FYERS_ID, FYERS_APP_ID, FYERS_SECRET_KEY, FYERS_TOTP_SECRET, FYERS_PIN, FYERS_REDIRECT_URI in .env.local.';

/** Decode a JWT's `exp` claim (→ ms epoch) without verifying. Null on failure. */
function jwtExpiryMs(jwt: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString());
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Mask the token so a response can confirm identity without leaking the credential. */
function maskToken(token: string): string {
  return token.length <= 12 ? '***' : `${token.slice(0, 6)}…${token.slice(-4)}`;
}

function tokenInfo(token: string, reveal: boolean) {
  const expiresAt = jwtExpiryMs(token);
  return {
    token: reveal ? token : undefined,
    tokenPreview: maskToken(token),
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    expiresInMinutes: expiresAt ? Math.round((expiresAt - Date.now()) / 60_000) : null,
  };
}

/**
 * GET /api/fyers/token — current Fyers access-token status. Fetches (and
 * caches) a token via the TOTP login chain if none is loaded yet — this is the
 * endpoint to hit first to validate the whole auth setup in isolation.
 */
export async function GET(req: Request) {
  const denied = adminOnly(req);
  if (denied) return denied;
  if (!hasFyersAuth()) {
    return NextResponse.json({ success: false, configured: false, error: NO_CREDS }, { status: 400 });
  }
  try {
    const token = await getFyersAccessToken();
    return NextResponse.json({
      success: true,
      configured: true,
      regenerated: false,
      ...tokenInfo(token, false),
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 502 });
  }
}

/**
 * POST /api/fyers/token — force a FRESH token: clears the in-memory + disk
 * cache, then re-runs the TOTP login chain.
 *
 * Optional body: { reveal?: boolean } — when true, the full token is returned.
 * It's a live credential, so it's masked by default.
 */
export async function POST(req: Request) {
  const denied = adminOnly(req);
  if (denied) return denied;
  if (!hasFyersAuth()) {
    return NextResponse.json({ success: false, configured: false, error: NO_CREDS }, { status: 400 });
  }
  const body = (await req.json().catch(() => ({}))) as { reveal?: boolean };
  try {
    clearFyersToken();
    const token = await getFyersAccessToken();
    return NextResponse.json({
      success: true,
      configured: true,
      regenerated: true,
      ...tokenInfo(token, body.reveal === true),
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 502 });
  }
}
