/**
 * Fyers Access Token Auto-Generation (TOTP login chain)
 *
 * Mirrors lib/dhan/auth.ts: token cached in globalThis (survives HMR) + disk
 * (survives restarts), regenerated only near expiry. Fyers has no renew
 * endpoint, but regeneration is fully automated so mid-day expiry just
 * re-runs the chain.
 *
 * The login chain uses Fyers' own (undocumented) web-login endpoints — the
 * same flow every community auto-login script uses, because the official API
 * only offers an interactive redirect flow:
 *   1. send_login_otp_v2 (fy_id)          → request_key
 *   2. verify_otp (TOTP code)             → request_key
 *   3. verify_pin_v2 (PIN)                → interim "trade" token
 *   4. api/v3/token (Bearer trade token)  → redirect Url containing auth_code
 *   5. api/v3/validate-authcode           → the day's access_token
 * Step 5's appIdHash = sha256("APP_ID:SECRET_KEY") — format verified against
 * the fyers-api-v3 SDK source (generate_access_token).
 *
 * Required env vars (lib/env.ts — all six): FYERS_ID, FYERS_APP_ID,
 * FYERS_SECRET_KEY, FYERS_TOTP_SECRET, FYERS_PIN, FYERS_REDIRECT_URI.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { TOTP } from 'otpauth';
import { env, hasFyersCredentials } from '@/lib/env';

const TAG = '[FyersAuth]';
const REFRESH_BUFFER_MS = 30 * 60 * 1000; // regenerate 30min before expiry
const TOKEN_CACHE_FILE = path.join(process.cwd(), 'data', '.fyers-token.json');
const LOGIN_BASE = 'https://api-t2.fyers.in/vagator/v2';
const API_BASE = 'https://api-t1.fyers.in/api/v3';

/** Thrown by client.ts on auth-coded API errors so the poller can regen + retry. */
export class FyersAuthError extends Error {}

// ─── Global cache (survives HMR reloads in dev) ─────────────────────────────

const g = globalThis as unknown as {
  __fyersToken?: string | null;
  __fyersExpiry?: number;
  __fyersPromise?: Promise<string> | null;
};

function getToken(): string | null {
  return g.__fyersToken ?? null;
}
function getExpiry(): number {
  return g.__fyersExpiry ?? 0;
}
function setToken(token: string, expiresAt: number): void {
  g.__fyersToken = token;
  g.__fyersExpiry = expiresAt;
  fs.writeFile(TOKEN_CACHE_FILE, JSON.stringify({ token, expiresAt })).catch(() => {});
}

async function loadFromDisk(): Promise<void> {
  if (getToken()) return;
  try {
    const raw = await fs.readFile(TOKEN_CACHE_FILE, 'utf-8');
    const { token, expiresAt } = JSON.parse(raw);
    if (token && expiresAt > Date.now() + REFRESH_BUFFER_MS) {
      g.__fyersToken = token;
      g.__fyersExpiry = expiresAt;
      console.log(
        `${TAG} Loaded cached token from disk, expires ${new Date(expiresAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`,
      );
    }
  } catch {
    // No cached token on disk
  }
}

// ─── Login chain helpers ─────────────────────────────────────────────────────

function generateTotpCode(): string {
  return new TOTP({
    secret: env.FYERS_TOTP_SECRET!,
    digits: 6,
    period: 30,
    algorithm: 'SHA1',
  }).generate();
}

function parseJwtExpiry(jwt: string): number {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString());
    return payload.exp * 1000;
  } catch {
    // Fyers tokens are valid for the trading day; be conservative
    return Date.now() + 12 * 60 * 60 * 1000;
  }
}

async function postJson(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    // api/v3/token answers HTTP 308 whose JSON body carries the auth-code Url —
    // auto-following the redirect would discard it.
    redirect: 'manual',
  });
  const text = await resp.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${TAG} ${url} returned non-JSON (HTTP ${resp.status}): ${text.slice(0, 200)}`);
  }
  // Fyers login endpoints signal failure via s:'error' (often with HTTP 200);
  // 308 is the SUCCESS status of the token step.
  if ((!resp.ok && resp.status !== 308) || json.s === 'error') {
    throw new Error(`${TAG} ${url} failed (HTTP ${resp.status}): ${text.slice(0, 300)}`);
  }
  return json;
}

/** Wait for the next 30s TOTP window (a code minted at the window edge is sometimes rejected). */
async function waitForNextTotpWindow(): Promise<void> {
  const msIntoWindow = Date.now() % 30_000;
  await new Promise((r) => setTimeout(r, 30_000 - msIntoWindow + 1_000));
}

async function performTotpLogin(): Promise<{ token: string; expiresAt: number }> {
  const fyId = env.FYERS_ID!;
  const appId = env.FYERS_APP_ID!; // e.g. "ABCD1EFG2H-100"
  const [appIdPlain, appType = '100'] = appId.split('-');

  console.log(`${TAG} Generating access token via TOTP login chain...`);

  // 1. Request an OTP session for the login id
  const otpReq = await postJson(`${LOGIN_BASE}/send_login_otp_v2`, {
    fy_id: Buffer.from(fyId).toString('base64'),
    app_id: '2',
  });

  // 2. Verify with the current TOTP code; retry once on the next window
  let verifyOtp: Record<string, unknown>;
  try {
    verifyOtp = await postJson(`${LOGIN_BASE}/verify_otp`, {
      request_key: otpReq.request_key,
      otp: generateTotpCode(),
    });
  } catch (err) {
    console.warn(`${TAG} TOTP rejected, retrying on next 30s window...`, (err as Error).message);
    await waitForNextTotpWindow();
    verifyOtp = await postJson(`${LOGIN_BASE}/verify_otp`, {
      request_key: otpReq.request_key,
      otp: generateTotpCode(),
    });
  }

  // 3. Verify PIN → interim "trade" token
  const verifyPin = await postJson(`${LOGIN_BASE}/verify_pin_v2`, {
    request_key: verifyOtp.request_key,
    identity_type: 'pin',
    identifier: Buffer.from(env.FYERS_PIN!).toString('base64'),
  });
  const tradeToken = (verifyPin.data as Record<string, unknown> | undefined)?.access_token as string | undefined;
  if (!tradeToken) throw new Error(`${TAG} verify_pin_v2 returned no access_token`);

  // 4. Ask for the API app's auth code (what the interactive redirect would carry)
  const tokenResp = await postJson(
    `${API_BASE}/token`,
    {
      fyers_id: fyId,
      app_id: appIdPlain,
      redirect_uri: env.FYERS_REDIRECT_URI!,
      appType,
      code_challenge: '',
      state: 'None',
      scope: '',
      nonce: '',
      response_type: 'code',
      create_cookie: true,
    },
    { Authorization: `Bearer ${tradeToken}` },
  );
  // Two observed response shapes: a redirect Url carrying ?auth_code=..., or
  // the auth code (a JWT) directly at data.auth.
  const redirectUrl = tokenResp.Url as string | undefined;
  const authCode =
    (redirectUrl ? new URL(redirectUrl).searchParams.get('auth_code') : null) ??
    ((tokenResp.data as Record<string, unknown> | undefined)?.auth as string | undefined) ??
    null;
  if (!authCode) throw new Error(`${TAG} No auth_code in token response: ${JSON.stringify(tokenResp).slice(0, 300)}`);

  // 5. Exchange the auth code for the day's access token
  const validated = await postJson(`${API_BASE}/validate-authcode`, {
    grant_type: 'authorization_code',
    appIdHash: createHash('sha256').update(`${appId}:${env.FYERS_SECRET_KEY!}`).digest('hex'),
    code: authCode,
  });
  const accessToken = validated.access_token as string | undefined;
  if (!accessToken) throw new Error(`${TAG} No access_token in validate-authcode response`);

  const expiresAt = parseJwtExpiry(accessToken);
  console.log(
    `${TAG} Token generated. Expires: ${new Date(expiresAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`,
  );
  return { token: accessToken, expiresAt };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Get a valid Fyers access token.
 *
 * Priority: globalThis cache → disk cache → fresh TOTP login chain.
 */
export async function getFyersAccessToken(): Promise<string> {
  if (getToken() && Date.now() < getExpiry() - REFRESH_BUFFER_MS) {
    return getToken()!;
  }

  // Prevent concurrent login chains (would burn OTP sessions)
  if (g.__fyersPromise) return g.__fyersPromise;

  g.__fyersPromise = (async () => {
    try {
      await loadFromDisk();
      if (getToken() && Date.now() < getExpiry() - REFRESH_BUFFER_MS) {
        return getToken()!;
      }

      if (!hasFyersCredentials()) {
        throw new FyersAuthError(
          `${TAG} Missing Fyers credentials. Set FYERS_ID, FYERS_APP_ID, FYERS_SECRET_KEY, FYERS_TOTP_SECRET, FYERS_PIN, FYERS_REDIRECT_URI in .env.local`,
        );
      }

      const { token, expiresAt } = await performTotpLogin();
      setToken(token, expiresAt);
      return token;
    } finally {
      g.__fyersPromise = null;
    }
  })();

  return g.__fyersPromise;
}

/**
 * Clear cached token (in-memory + disk).
 * Call when Fyers returns an auth error — forces a fresh login chain next request.
 */
export function clearFyersToken(): void {
  g.__fyersToken = null;
  g.__fyersExpiry = 0;
  fs.unlink(TOKEN_CACHE_FILE).catch(() => {});
  console.warn(`${TAG} Cleared cached token`);
}

/** True when the full TOTP login chain is configured. */
export function hasFyersAuth(): boolean {
  return hasFyersCredentials();
}

/** Current token status for the /api/fyers/token route (never exposes the full token). */
export function getFyersTokenStatus(): { cached: boolean; expiresAt: number | null } {
  return { cached: !!getToken(), expiresAt: getToken() ? getExpiry() : null };
}

/** The configured app id (client.ts needs it for the SDK's Authorization header). */
export function fyersAppId(): string {
  return env.FYERS_APP_ID ?? '';
}
