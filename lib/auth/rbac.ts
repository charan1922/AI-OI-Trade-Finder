/**
 * RBAC core — roles, permissions, and the API access policy.
 *
 * Two roles today, resolved from the Basic-Auth password in proxy.ts:
 *   admin  — APP_PASSWORD:          full access (the current operator login)
 *   viewer — APP_READONLY_PASSWORD: can open every page and read every API,
 *            but no action that changes state, spends money (LLM calls), or
 *            triggers an external download/sync.
 *
 * Designed so real authentication can replace the password step later without
 * touching enforcement: only proxy.ts's role RESOLUTION changes (session/JWT →
 * Role); the permission catalog, the policy table, and every roleHas() call
 * site stay as they are. Keep this module runtime-agnostic (no Node/React
 * imports) — proxy.ts may run on the Edge runtime.
 *
 * Enforcement is layered:
 *   1. proxy.ts (authoritative) — requiredPermission() per request; viewers
 *      get 403 JSON before the route runs. Unknown mutating APIs fall through
 *      to 'app:write' (default-deny), so a future POST route is viewer-blocked
 *      automatically unless explicitly classified as a read here.
 *   2. Mixed routes (one endpoint, read AND write actions in the body) check
 *      per-action inside the route via lib/auth/server.ts — currently only
 *      /api/backtest/tf-validate (TF_VALIDATE_WRITE_ACTIONS).
 *   3. UI hides/disables action controls via lib/auth/use-role.ts — pure UX;
 *      the server never trusts it.
 */

export type Role = 'admin' | 'viewer';

/**
 * Google → role policy (user rule 2026-07-12). THE single source of truth for
 * what a Google sign-in is worth — auth.ts admits verified accounts, proxy.ts
 * maps them through roleForGoogleEmail(), in this order:
 *   OWNER_GOOGLE_EMAILS       → admin (and the only accounts that may manage users)
 *   ADMIN_GOOGLE_EMAILS       → admin (bootstrap operators, editable only in code)
 *   the runtime registry      → admin | viewer (the owner's /users screen, app_users)
 *   GOOGLE_VIEWER_EMAILS      → viewer (explicit comma-separated allowlist)
 *   every other account       → denied before a session is issued
 *
 * The two hardcoded sets are checked FIRST so nothing done on /users (or a
 * corrupted app_users table) can ever lock the operator out of his own app.
 */
export const ADMIN_GOOGLE_EMAILS: ReadonlySet<string> = new Set([
  'charan192219@gmail.com',
  'kesardevi22161@gmail.com',
]);

/**
 * The OWNER — user rule 2026-08-10: "i am the main guy i should be able to add
 * admin or viewer nd no other can". Owners may open /users and call
 * /api/users; a plain admin has full trading access but CANNOT change who has
 * access. Deliberately hardcoded and NOT manageable from the UI: the one grant
 * that hands out every other grant must not be editable by whoever holds it.
 */
export const OWNER_GOOGLE_EMAILS: ReadonlySet<string> = new Set(['charan192219@gmail.com']);

export function isOwnerEmail(email: string | null | undefined): boolean {
  return !!email && OWNER_GOOGLE_EMAILS.has(email.trim().toLowerCase());
}

/**
 * Runtime role registry — the DB-backed half of the policy, written from the
 * owner's /users screen (table app_users, see lib/auth/users.ts).
 *
 * This module must stay import-free (proxy.ts imports it), so the registry
 * lives on globalThis: users.ts reads app_users and calls setRoleRegistry();
 * rbac.ts only ever READS it. Next 16 runs proxy.ts on the Node.js runtime —
 * the same process as the route handlers — so both halves genuinely share one
 * globalThis. (Under the old Edge middleware they would not have.)
 *
 * Failure behaviour: an empty/stale registry falls through to the code lists
 * and then to null — i.e. it fails CLOSED for everyone except the hardcoded
 * operators, never open.
 */
const registryHost = globalThis as unknown as {
  __appRoleRegistry?: Map<string, Role>;
  __appRoleRevoked?: Set<string>;
};

export function setRoleRegistry(entries: Iterable<readonly [string, Role]>, revoked: Iterable<string> = []): void {
  const map = new Map<string, Role>();
  for (const [email, role] of entries) {
    const normalized = email.trim().toLowerCase();
    if (normalized) map.set(normalized, role);
  }
  const revokedSet = new Set<string>();
  for (const email of revoked) {
    const normalized = email.trim().toLowerCase();
    if (normalized) revokedSet.add(normalized);
  }
  registryHost.__appRoleRegistry = map;
  registryHost.__appRoleRevoked = revokedSet;
}

export function roleFromRegistry(email: string | null | undefined): Role | null {
  if (!email) return null;
  return registryHost.__appRoleRegistry?.get(email.trim().toLowerCase()) ?? null;
}

/** True when the owner explicitly revoked this account on /users. Stored as a
 *  tombstone row (status='revoked') rather than a deletion, precisely so it can
 *  override the hardcoded ADMIN_GOOGLE_EMAILS list below. */
export function isRevokedEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return registryHost.__appRoleRevoked?.has(email.trim().toLowerCase()) ?? false;
}

export function roleForGoogleEmail(
  email: string | null | undefined,
  viewerEmails = process.env.GOOGLE_VIEWER_EMAILS
): Role | null {
  if (!email) return null;
  const normalized = email.trim().toLowerCase();
  // 1. The owner always wins — no DB state can lock him out of his own app.
  if (OWNER_GOOGLE_EMAILS.has(normalized)) return 'admin';
  // 2. An explicit revoke on /users beats everything below, including the
  //    hardcoded admin list — otherwise "Remove" would silently do nothing to a
  //    code-listed operator and the screen would be lying.
  if (isRevokedEmail(normalized)) return null;
  // 3. The owner-managed registry (app_users) — also lets a code-listed admin be
  //    downgraded to viewer, so it is checked BEFORE the code list.
  const fromRegistry = roleFromRegistry(normalized);
  if (fromRegistry) return fromRegistry;
  // 4. Hardcoded bootstrap operators, for emails never touched on /users.
  if (ADMIN_GOOGLE_EMAILS.has(normalized)) return 'admin';
  const viewers = new Set(
    (viewerEmails ?? '')
      .split(',')
      .map((candidate) => candidate.trim().toLowerCase())
      .filter(Boolean)
  );
  return viewers.has(normalized) ? 'viewer' : null;
}

/** Request header the proxy stamps AFTER stripping any client-supplied value —
 *  downstream route handlers may trust it (see lib/auth/server.ts). */
export const ROLE_HEADER = 'x-app-role';

/** Companion to ROLE_HEADER: '1' when the caller is the owner. Same guarantee —
 *  the proxy always overwrites whatever the client sent. */
export const OWNER_HEADER = 'x-app-owner';

/**
 * OWNER-only surfaces — access management. A plain admin is blocked here (403
 * on the API, redirect to home on the page), which is the whole point: admins
 * trade, only the owner decides who gets in.
 */
export const OWNER_ONLY_PAGES: ReadonlySet<string> = new Set(['/users']);
export const OWNER_ONLY_API_PREFIXES: readonly string[] = ['/api/users'];

/** True when `pathname` is an owner-only page/API (exact match or a sub-path). */
export function isOwnerOnlyPath(pathname: string): boolean {
  for (const page of OWNER_ONLY_PAGES) {
    if (pathname === page || pathname.startsWith(`${page}/`)) return true;
  }
  return OWNER_ONLY_API_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export type Permission =
  | 'app:write' // catch-all: any mutating API not explicitly classified below
  | 'config:write' // feature toggles / numeric settings
  | 'data:sync' // external downloads: bhavcopy sync, candle/backtest downloads
  | 'poller:control' // pause/resume/run-once the Fyers download loop
  | 'token:manage' // force-regenerate Dhan/Fyers access tokens
  | 'ai:generate' // "Generate now" commentary (paid MiMo call + persisted row)
  | 'ai:chat' // Trade Assistant chat (paid Azure OpenAI call)
  | 'scan:actions'; // trade-suggest review/stats + window-bypass force scans

const ALL_PERMISSIONS: readonly Permission[] = [
  'app:write',
  'config:write',
  'data:sync',
  'poller:control',
  'token:manage',
  'ai:generate',
  'ai:chat',
  'scan:actions',
];

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  admin: new Set(ALL_PERMISSIONS),
  viewer: new Set<Permission>(), // read-only: no action permissions at all
};

export function roleHas(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

/**
 * Write actions of POST /api/backtest/tf-validate — the one mixed endpoint
 * whose body decides read vs write. Everything else on it ('status',
 * 'trade-detail', 'simulate', 'backtest' — compute over already-stored rows,
 * …) is a read. Enforced inside the route (proxy can't see the body).
 */
export const TF_VALIDATE_WRITE_ACTIONS: ReadonlySet<string> = new Set([
  'download',
  'download-symbols',
  'download-all-tf',
]);

/**
 * Admin-only PAGES (matched as the exact path or any sub-path). Every other
 * page is viewable by every role. The proxy redirects a viewer's navigation
 * here to the home page; the sidebar also hides these entries for viewers
 * (components/app-sidebar.tsx) — that part is cosmetic, this list is what
 * enforces.
 *
 * What counts as sensitive (operator-only): anything that controls trading or
 * money (auto-trade), broker/token panels (fyers, dhan), raw internals
 * (db-explorer, prompts, api-docs, config), data-sync/download tooling
 * (data-downloader, trade-viewer, replay-commentary), and paid-AI surfaces
 * (trade-assistant — its chat API is viewer-403'd anyway, the page is useless
 * without it). Data-VIEW pages (/live, /nse/*, /heatmap, /trade-suggest,
 * /trade-commentary, /holidays, /fno-lots) stay viewer-visible.
 */
export const ADMIN_ONLY_PAGES: ReadonlySet<string> = new Set([
  '/api-docs',
  '/config',
  '/auto-trade',
  '/logs',
  '/fyers',
  '/dhan',
  '/prompts',
  '/db-explorer',
  '/data-downloader',
  '/trade-viewer',
  '/replay-commentary',
  '/trade-assistant',
  '/reminders',
  // Also OWNER-only (OWNER_ONLY_PAGES) — listed here too so the viewer
  // machinery (proxy policy + sidebar hiding) covers it without a special case.
  '/users',
]);

/** True when `pathname` is an admin-only page or lives under one. */
export function isAdminOnlyPage(pathname: string): boolean {
  for (const page of ADMIN_ONLY_PAGES) {
    if (pathname === page || pathname.startsWith(`${page}/`)) return true;
  }
  return false;
}

export const ADMIN_ONLY_API_PREFIXES: readonly string[] = [
  '/api/auto-trade',
  '/api/backtest',
  '/api/config',
  '/api/db-explorer',
  '/api/dhan',
  '/api/fyers',
  '/api/health/services',
  '/api/logs',
  '/api/openapi',
  '/api/prompts',
  '/api/replay-commentary',
  '/api/telegram/setup',
  '/api/users', // narrowed further to the owner by OWNER_ONLY_API_PREFIXES
];

export function isAdminOnlyApi(pathname: string): boolean {
  return ADMIN_ONLY_API_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * The API access policy: which permission (if any) a request needs.
 * Returns null when every authenticated role may pass (all pages, all reads).
 *
 * Notes on the deliberate classifications:
 *  - GET /api/trade-suggest (plain) runs a scan that persists suggestions, but
 *    the SAME scan runs autonomously in the server poller during market hours;
 *    a viewer loading /trade-suggest adds nothing an admin session wouldn't —
 *    so it stays a read. `?force=1` (window bypass) is an operator override.
 *  - POST /api/live/quote is POST-for-payload only (batch symbol list) — a read.
 *  - Sensitive operational GETs are covered by ADMIN_ONLY_API_PREFIXES as
 *    well as close-to-data checks in their route handlers.
 */
export function requiredPermission(method: string, pathname: string, searchParams: URLSearchParams): Permission | null {
  // Pages: viewable by every role except the explicit admin-only list
  // (matched with sub-paths, e.g. /db-explorer/<table>).
  if (!pathname.startsWith('/api/')) return isAdminOnlyPage(pathname) ? 'app:write' : null;

  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') {
    if (pathname === '/api/trade-suggest' && searchParams.get('force') === '1') return 'scan:actions';
    // The OpenAPI spec backs the admin-only /api-docs page — same restriction.
    if (isAdminOnlyApi(pathname)) return 'app:write';
    return null;
  }

  // POST-for-payload reads (body is a query, nothing mutates on the caller's behalf).
  if (pathname === '/api/live/quote') return null;
  // Mixed endpoint — per-action check lives in the route handler itself.
  if (pathname === '/api/backtest/tf-validate') return null;

  if (pathname === '/api/config/toggles') return 'config:write';
  if (pathname === '/api/bhavcopy') return 'data:sync';
  if (pathname === '/api/backtest/download-stream') return 'data:sync';
  if (pathname === '/api/fyers/poller') return 'poller:control';
  if (pathname === '/api/fyers/token' || pathname === '/api/dhan/token') return 'token:manage';
  if (pathname === '/api/trade-commentary') return 'ai:generate';
  if (pathname === '/api/ai-assistant/chat') return 'ai:chat';
  if (pathname === '/api/trade-suggest') return 'scan:actions';

  return 'app:write'; // default-deny: an unclassified mutating API is admin-only
}

/**
 * Constant-time string comparison (no early exit on first mismatch), so the
 * password check doesn't leak match length via response timing. charCodeAt
 * past the end yields NaN → coerced to 0, which still flips `diff` whenever
 * lengths differ.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * Map a supplied Basic-Auth password to a role. APP_READONLY_PASSWORD is only
 * meaningful when APP_PASSWORD (the gate switch) is set — same as today, an
 * unset APP_PASSWORD means the gate is off and everyone is admin (local dev).
 */
export function resolveRole(supplied: string, adminPassword: string, viewerPassword: string | undefined): Role | null {
  if (constantTimeEqual(supplied, adminPassword)) return 'admin';
  if (viewerPassword && constantTimeEqual(supplied, viewerPassword)) return 'viewer';
  return null;
}
