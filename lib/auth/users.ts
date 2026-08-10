/**
 * app_users — the persistent registry of every Google account that has signed
 * in, plus the subscription fields the future billing step (Razorpay) will
 * enforce. Same derived-table convention as the other runtime tables: raw
 * CREATE TABLE IF NOT EXISTS via Prisma, mirrored by AppUser in schema.prisma.
 *
 * Policy (user rule 2026-07-12): charan192219@gmail.com (ADMIN_GOOGLE_EMAILS)
 * → role 'admin', plan 'owner'; EVERY other Google account that registers →
 * role 'viewer', plan 'trial' (read-only — all mutating actions 403).
 *
 * ENFORCEMENT today is unchanged and stays in proxy.ts via the
 * ADMIN_GOOGLE_EMAILS policy (rbac.ts) — this table RECORDS who exists so the
 * subscription step can later flip role resolution to DB-driven (active
 * subscriber vs expired trial) without a schema change. Manual edits survive:
 * an upsert never overwrites an existing row's role/plan/status (except the
 * bootstrap rule that the owner email is always admin/owner).
 *
 * Recording happens from the root layout on page render (nodejs), NOT inside
 * the Auth.js callbacks — auth.ts is imported by proxy.ts, which may run on
 * the Edge runtime where better-sqlite3 cannot load. Best-effort + throttled:
 * a DB hiccup must never break page rendering.
 */

import { prisma } from '@/lib/db';
import { ADMIN_GOOGLE_EMAILS, isOwnerEmail, type Role, setRoleRegistry } from '@/lib/auth/rbac';

export interface AppUserRow {
  email: string;
  name: string | null;
  image: string | null;
  role: string; // 'admin' | 'viewer'
  plan: string; // 'owner' | 'trial' (later: 'monthly')
  status: string; // 'active' (later: 'blocked' | 'expired')
  subscriptionEndsAt: string | null; // ISO date; null = no paid subscription
  createdAt: string;
  lastSeenAt: string;
  /** When the owner explicitly granted access on /users. NULL = never granted —
   *  the row is only a record that this account signed in at some point, and it
   *  conveys NO access. See ensureTable(). */
  grantedAt: string | null;
}

let tableReady = false;

async function ensureTable(): Promise<void> {
  if (tableReady) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS app_users (
      email              TEXT PRIMARY KEY,
      name               TEXT,
      image              TEXT,
      role               TEXT NOT NULL DEFAULT 'viewer',
      plan               TEXT NOT NULL DEFAULT 'trial',
      status             TEXT NOT NULL DEFAULT 'active',
      subscriptionEndsAt TEXT,
      createdAt          TEXT NOT NULL,
      lastSeenAt         TEXT NOT NULL
    )
  `);
  // Additive column for pre-existing databases. CRITICAL to the access policy:
  // recordUserSeen() writes a row for EVERY account that signs in, so "has a
  // row" must never mean "has access" — otherwise deploying the registry would
  // silently grant viewer access to everyone who ever visited. Only a row the
  // owner explicitly granted on /users carries grantedAt, and only those become
  // registry entries. Legacy rows have grantedAt NULL → no access, exactly as
  // before. SQLite has no IF NOT EXISTS for ADD COLUMN; a duplicate-column
  // error just means it is already there.
  try {
    await prisma.$executeRawUnsafe(`ALTER TABLE app_users ADD COLUMN grantedAt TEXT`);
  } catch {
    /* column already exists */
  }
  tableReady = true;
}

// Throttle DB touches per email per process: the layout calls recordUserSeen on
// every page render — once per 15 min per user is plenty for "last seen".
const SEEN_THROTTLE_MS = 15 * 60 * 1000;
const seenHost = globalThis as unknown as { __appUsersSeen?: Map<string, number> };

/**
 * Record (or refresh) a signed-in Google account in app_users. Fire-and-forget
 * safe: never throws. New accounts register as viewer/trial; the owner email
 * always lands (and stays) admin/owner.
 */
export async function recordUserSeen(user: { email: string; name?: string | null; image?: string | null }): Promise<void> {
  try {
    const email = user.email.trim().toLowerCase();
    if (!email) return;

    seenHost.__appUsersSeen ??= new Map();
    const last = seenHost.__appUsersSeen.get(email) ?? 0;
    const now = Date.now();
    if (now - last < SEEN_THROTTLE_MS) return;
    seenHost.__appUsersSeen.set(email, now);

    await ensureTable();
    // Seed a code-listed operator's first row as admin; the owner's row is
    // additionally FORCED below. Everyone else registers as viewer/trial.
    const isCodeAdmin = ADMIN_GOOGLE_EMAILS.has(email);
    const isOwner = isOwnerEmail(email);
    const nowIso = new Date(now).toISOString();
    // Existing rows keep their role/plan/status (manual upgrades survive);
    // only identity + lastSeenAt refresh.
    await prisma.$executeRawUnsafe(
      `INSERT INTO app_users (email, name, image, role, plan, status, subscriptionEndsAt, createdAt, lastSeenAt)
       VALUES (?, ?, ?, ?, ?, 'active', NULL, ?, ?)
       ON CONFLICT(email) DO UPDATE SET
         name = excluded.name,
         image = excluded.image,
         lastSeenAt = excluded.lastSeenAt`,
      email,
      user.name ?? null,
      user.image ?? null,
      isCodeAdmin ? 'admin' : 'viewer',
      isCodeAdmin ? 'owner' : 'trial',
      nowIso,
      nowIso,
    );
    if (isOwner) {
      // Bootstrap rule: the OWNER's row is always admin/owner/active, even if it
      // was somehow edited — the same guarantee rbac.ts gives in code.
      // Deliberately scoped to the owner and NOT to every ADMIN_GOOGLE_EMAILS
      // entry: forcing those would silently undo a downgrade the owner made on
      // /users the next time that person signed in.
      await prisma.$executeRawUnsafe(
        `UPDATE app_users SET role = 'admin', plan = 'owner', status = 'active'
           WHERE email = ? AND (role != 'admin' OR plan != 'owner' OR status != 'active')`,
        email,
      );
    }
  } catch (err) {
    console.warn('[app-users] recordUserSeen failed:', (err as Error).message);
  }
}

/** All registered users, newest first — powers the owner's /users screen. */
export async function listUsers(): Promise<AppUserRow[]> {
  await ensureTable();
  return (await prisma.$queryRawUnsafe(
    `SELECT email, name, image, role, plan, status, subscriptionEndsAt, createdAt, lastSeenAt, grantedAt
       FROM app_users ORDER BY lastSeenAt DESC`,
  )) as AppUserRow[];
}

/* ------------------------------------------------------------------ *
 * Access management (owner-only; called from /api/users)
 * ------------------------------------------------------------------ */

/** Cheap sanity check — we store the email as the primary key, so a junk value
 *  would become a permanent un-loginable row. Deliberately loose (one @, no
 *  spaces, a dot in the domain): Google is the real validator. */
export function isPlausibleEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Grant `email` a role, creating the row if this is a pre-authorisation (the
 * common case: the owner adds someone BEFORE their first sign-in, so the
 * signIn callback lets them through). Returns the normalised email.
 *
 * Refuses to touch the owner's own row — the hardcoded OWNER_GOOGLE_EMAILS is
 * the authority there, and letting the screen rewrite it would only ever create
 * a misleading display.
 */
export async function setUserRole(email: string, role: Role): Promise<string> {
  const normalized = email.trim().toLowerCase();
  if (!isPlausibleEmail(normalized)) throw new Error(`'${email}' is not a valid email address`);
  if (isOwnerEmail(normalized)) throw new Error('The owner account cannot be modified.');
  await ensureTable();
  const nowIso = new Date().toISOString();
  // status returns to 'active' so re-adding a revoked account restores it, and
  // grantedAt is stamped — that stamp is what turns a merely-seen row into an
  // actual grant (see ensureTable).
  await prisma.$executeRawUnsafe(
    `INSERT INTO app_users (email, name, image, role, plan, status, subscriptionEndsAt, createdAt, lastSeenAt, grantedAt)
     VALUES (?, NULL, NULL, ?, ?, 'active', NULL, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       role = excluded.role, plan = excluded.plan, status = 'active', grantedAt = excluded.grantedAt`,
    normalized,
    role,
    role === 'admin' ? 'owner' : 'trial',
    nowIso,
    nowIso,
    nowIso,
  );
  await refreshRoleRegistry({ force: true });
  return normalized;
}

/**
 * Revoke access. Writes a TOMBSTONE (status='revoked') instead of deleting the
 * row, because roleForGoogleEmail() checks the revoked set BEFORE the hardcoded
 * ADMIN_GOOGLE_EMAILS list — a plain DELETE would let a code-listed operator
 * fall straight back through to admin and the "Remove" button would be a lie.
 *
 * Reversible: setUserRole() flips status back to 'active'.
 * The owner cannot be revoked (rbac checks OWNER_GOOGLE_EMAILS first anyway).
 */
export async function removeUser(email: string): Promise<{ email: string; wasCodeAdmin: boolean }> {
  const normalized = email.trim().toLowerCase();
  if (!isPlausibleEmail(normalized)) throw new Error(`'${email}' is not a valid email address`);
  if (isOwnerEmail(normalized)) throw new Error('The owner account cannot be removed.');
  await ensureTable();
  const nowIso = new Date().toISOString();
  await prisma.$executeRawUnsafe(
    `INSERT INTO app_users (email, name, image, role, plan, status, subscriptionEndsAt, createdAt, lastSeenAt)
     VALUES (?, NULL, NULL, 'viewer', 'trial', 'revoked', NULL, ?, ?)
     ON CONFLICT(email) DO UPDATE SET status = 'revoked'`,
    normalized,
    nowIso,
    nowIso,
  );
  await refreshRoleRegistry({ force: true });
  return { email: normalized, wasCodeAdmin: ADMIN_GOOGLE_EMAILS.has(normalized) };
}

/* ------------------------------------------------------------------ *
 * Registry hydration — the bridge to rbac.ts / proxy.ts
 * ------------------------------------------------------------------ */

/** How long a hydrated registry is trusted before the next read re-queries.
 *  SQLite is in-process, so this is a cheap query; the TTL exists to keep it off
 *  the hot path of every single request, not because it is expensive. */
const REGISTRY_TTL_MS = 15_000;
const registryHost = globalThis as unknown as { __appRoleRegistryAt?: number };

/**
 * Load app_users into the in-memory role registry that rbac.ts reads.
 *
 * Safe to call on every request: TTL-throttled, and it NEVER throws — a DB
 * hiccup leaves the previous registry in place (or none at all, which falls
 * back to the hardcoded operator lists). Returns true when a fresh read landed.
 */
export async function refreshRoleRegistry(opts?: { force?: boolean }): Promise<boolean> {
  const now = Date.now();
  if (!opts?.force && now - (registryHost.__appRoleRegistryAt ?? 0) < REGISTRY_TTL_MS) return false;
  // Stamp BEFORE the query so a slow/failing DB can't be re-queried by every
  // concurrent request in the meantime.
  registryHost.__appRoleRegistryAt = now;
  try {
    await ensureTable();
    const rows = (await prisma.$queryRawUnsafe(`SELECT email, role, status, grantedAt FROM app_users`)) as Array<{
      email: string;
      role: string;
      status: string;
      grantedAt: string | null;
    }>;
    setRoleRegistry(
      // ONLY explicit owner grants. A row without grantedAt is just a record
      // that the account once signed in (recordUserSeen) and must convey no
      // access — see the ensureTable comment.
      rows
        .filter((r) => r.status === 'active' && r.grantedAt)
        .map((r) => [r.email, r.role === 'admin' ? 'admin' : 'viewer'] as const),
      rows.filter((r) => r.status === 'revoked').map((r) => r.email),
    );
    return true;
  } catch (err) {
    console.warn('[app-users] refreshRoleRegistry failed:', (err as Error).message);
    return false;
  }
}
