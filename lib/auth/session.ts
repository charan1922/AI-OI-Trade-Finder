/**
 * Signed session cookie — the browser side of auth.
 *
 * HTTP Basic Auth (proxy.ts) can't render a custom login page or support a
 * logout button (the browser caches the credentials), so browsers authenticate
 * with a cookie instead. Basic Auth still works in parallel for the internal
 * server-to-self calls (engine.ts / poller.ts send APP_PASSWORD).
 *
 * The cookie is `role.exp.hmac` — tamper-proof, not encrypted (it carries no
 * secret, only the role + expiry). The HMAC key is APP_PASSWORD, which a viewer
 * never knows, so a viewer cannot forge an `admin` cookie; changing APP_PASSWORD
 * invalidates every live session. Uses Web Crypto (crypto.subtle) + btoa, both
 * available on the Edge runtime the proxy runs on — keep this file free of any
 * Node-only import.
 */
import { constantTimeEqual, type Role } from './rbac';

export const SESSION_COOKIE = 'pr_session';
/** Display-only name shown in the header (URI-encoded). No auth meaning. */
export const USERNAME_COOKIE = 'pr_user';
/** 7 days — long enough to avoid nagging, short enough to bound a leaked cookie. */
export const SESSION_MAX_AGE_SEC = 7 * 24 * 60 * 60;

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return base64url(new Uint8Array(sig));
}

/** Build a signed cookie value for `role`, valid for SESSION_MAX_AGE_SEC. */
export async function signSession(role: Role, secret: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SEC;
  const payload = `${role}.${exp}`;
  return `${payload}.${await hmac(payload, secret)}`;
}

/** Verify a cookie value; returns the role only when signature AND expiry hold. */
export async function verifySession(value: string | undefined, secret: string): Promise<Role | null> {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [role, expStr, sig] = parts;
  if (role !== 'admin' && role !== 'viewer') return null;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp * 1000 <= Date.now()) return null;
  const expected = await hmac(`${role}.${expStr}`, secret);
  if (!constantTimeEqual(sig, expected)) return null;
  return role;
}
